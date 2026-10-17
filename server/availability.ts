import { access, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BackgroundRuntime } from '../shared/types.js';
import type {
  ActivationReceipt,
  AvailabilityReview,
  AvailabilitySnapshot,
} from '../shared/availability.js';
import type { PhoneConfig } from './phone.js';
import { Store } from './store.js';
import { assert } from './errors.js';
import { writePrivateJson } from './private-json.js';
import {
  installedServiceDefinition,
  prepareService,
  serviceContext,
  serviceDefinitionLoaded,
  verifyServiceDefinition,
  type ServiceContext,
  type ServiceReceipt,
} from './background-service.js';
import {
  activationDigest,
  activationLease,
  activationPath,
  activationReceipt,
  launchActivation,
  readActivation,
  type ActivationIntent,
  type ActivationLaunch,
} from './service-activation.js';

export interface AvailabilityOptions {
  dataDirectory: string;
  port: number;
  phone: PhoneConfig | null;
  context?: ServiceContext;
  environment?: NodeJS.ProcessEnv;
  launch?: ActivationLaunch;
  requestShutdown: () => void | Promise<void>;
}
type Saved = Pick<ActivationReceipt, 'id' | 'digest' | 'installationId' | 'requestedAt'>;
export class Availability {
  private plans = new Map<string, { review: AvailabilityReview; definition: ServiceReceipt }>();
  private checking = false;
  private transition = false;
  private shutdown = false;
  private context: ServiceContext;
  constructor(
    private store: Store,
    private filename: string,
    private runtime: BackgroundRuntime,
    private options: AvailabilityOptions | undefined,
    private otherBusy: () => boolean,
  ) {
    this.context =
      options?.context ??
      serviceContext({
        ...(runtime.definitionDirectory ? { agentDirectory: runtime.definitionDirectory } : {}),
      });
  }
  get isBusy() {
    return this.checking || this.transitioning;
  }
  get transitioning() {
    return this.transition && this.runtime.mode !== 'launchd';
  }
  get shouldShutdown() {
    return this.shutdown && this.transitioning;
  }
  private get supported() {
    return !!this.options && this.context.platform === 'darwin' && this.context.uid > 0;
  }
  private get startsAtLogin() {
    return (
      resolve(this.context.agentDirectory) === join(this.context.home, 'Library', 'LaunchAgents')
    );
  }
  private async previous(): Promise<ActivationReceipt | null> {
    const saved = this.store.get<Saved>('config', 'background-activation');
    if (!saved) return null;
    try {
      assert(this.options, 409, 'The background handoff settings are unavailable.');
      const intent = await readActivation(
        activationPath(await realpath(this.options.dataDirectory), saved.id),
      );
      assert(
        intent.review.id === saved.id &&
          intent.review.digest === saved.digest &&
          intent.review.installationId === saved.installationId &&
          intent.requestedAt === saved.requestedAt,
        409,
        'The background handoff receipt changed.',
      );
      return activationReceipt(intent);
    } catch {
      return {
        ...saved,
        updatedAt: saved.requestedAt,
        state: 'uncertain',
        detail:
          'The private handoff receipt is unavailable or changed. Review native service status. No request will replay.',
      };
    }
  }
  async snapshot(): Promise<AvailabilitySnapshot> {
    return {
      supported: this.supported,
      runtime: this.runtime.mode,
      startsAtLogin: this.startsAtLogin,
      transitioning: this.transitioning,
      receipt: await this.previous(),
      detail: !this.supported
        ? 'Reviewed background activation requires the compiled macOS app. Other platforms and development mode can run in the foreground.'
        : this.runtime.mode === 'launchd'
          ? 'The native macOS user service owns this workspace. It runs while you are logged in and the Mac is awake.'
          : 'Review the exact macOS service definition, then hand this idle workspace to its native background owner.',
    };
  }
  private idle() {
    assert(
      !this.otherBusy(),
      409,
      'Wait for native work, account checks and workspace setup, and reconcile unconfirmed native exits before changing availability.',
    );
  }
  async prepare(): Promise<AvailabilityReview> {
    assert(
      this.supported && this.options,
      409,
      'Reviewed background activation is available only in the compiled macOS app.',
    );
    assert(
      this.runtime.mode === 'foreground' && !this.isBusy,
      409,
      'This workspace is already in the background or a handoff is in progress.',
    );
    this.idle();
    this.checking = true;
    try {
      const desired = await prepareService(
        { ...this.options, environment: this.options.environment ?? process.env },
        this.context,
      );
      assert(
        (await realpath(this.filename)) === join(desired.dataDirectory, 'workspace.sqlite'),
        409,
        'Background activation must use this exact persistent workspace database.',
      );
      assert(
        await activationLease(desired.dataDirectory),
        409,
        'Another background handoff still owns this workspace.',
      );
      const previous = await this.previous();
      assert(
        !previous || !!previous.review || ['failed', 'aborted', 'running'].includes(previous.state),
        409,
        'Review the previous handoff and native service status before another activation. Uncertain requests never replay.',
      );
      await access(join(desired.root, 'bin', 'service-activate.mjs'));
      const existing = await installedServiceDefinition(desired.dataDirectory, this.context);
      let definition = desired;
      if (existing) {
        definition = await verifyServiceDefinition(existing, this.context);
        assert(
          existing.port === desired.port &&
            JSON.stringify(existing.phone) === JSON.stringify(desired.phone) &&
            JSON.stringify(existing.environment) === JSON.stringify(desired.environment),
          409,
          'The installed service settings differ from this foreground workspace. Review them with forge service status before changing availability.',
        );
      }
      assert(
        !(await serviceDefinitionLoaded(definition, this.context)),
        409,
        'A native service already owns this installation. Review its status before another start.',
      );
      this.idle();
      const unsigned: Omit<AvailabilityReview, 'digest'> = {
        id: randomUUID(),
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        action: existing ? 'start-installed' : 'install-and-start',
        installationId: definition.id,
        dataDirectory: definition.dataDirectory,
        definition: join(definition.agentDirectory, `${definition.label}.plist`),
        executable: definition.node,
        runner: definition.runner,
        port: definition.port,
        phonePort: definition.phone?.port ?? null,
        phoneOrigin: definition.phone?.origin ?? null,
        phoneUsers: definition.phone?.users ?? [],
        environment: definition.environment,
        startsAtLogin: this.startsAtLogin,
      };
      const review = { ...unsigned, digest: activationDigest(unsigned) };
      while (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!);
      this.plans.set(review.id, { review, definition });
      return review;
    } finally {
      this.checking = false;
    }
  }
  async activate(planId: string, digest: string): Promise<ActivationReceipt> {
    const saved = this.store.get<Saved>('config', 'background-activation');
    if (saved?.id === planId) {
      assert(saved.digest === digest, 409, 'The reviewed background handoff digest changed.');
      return (await this.previous())!;
    }
    assert(
      this.supported && this.options && this.runtime.mode === 'foreground' && !this.isBusy,
      409,
      'This workspace is already in the background or another setup operation is active.',
    );
    const plan = this.plans.get(planId);
    assert(
      plan && plan.review.digest === digest && Date.now() < Date.parse(plan.review.expiresAt),
      409,
      'Prepare a fresh background handoff review before activation.',
    );
    this.idle();
    this.checking = true;
    try {
      const r = await verifyServiceDefinition(plan.definition, this.context);
      assert(
        await activationLease(r.dataDirectory),
        409,
        'Another background handoff owns this workspace.',
      );
      const existing = await installedServiceDefinition(r.dataDirectory, this.context);
      assert(
        plan.review.action === 'install-and-start'
          ? !existing
          : existing?.configurationHash === r.configurationHash,
        409,
        'The native installation changed after review. Prepare another review.',
      );
      assert(
        !(await serviceDefinitionLoaded(r, this.context)),
        409,
        'A native service owner appeared after review.',
      );
      this.idle();
      const timestamp = new Date().toISOString();
      const intent: ActivationIntent = {
        version: 1,
        review: plan.review,
        definition: r,
        parentPid: process.pid,
        requestedAt: timestamp,
        updatedAt: timestamp,
        state: 'submitted',
        detail:
          'A local human submitted this reviewed background handoff. Waiting for private helper acknowledgement.',
        actor: 'local-human',
      };
      const filename = activationPath(r.dataDirectory, planId);
      await writePrivateJson(filename, intent);
      this.store.put('config', 'background-activation', {
        id: planId,
        digest,
        installationId: r.id,
        requestedAt: timestamp,
      });
      this.transition = true;
      let committed = false,
        outcome: 'committed' | 'aborted' | 'uncertain';
      try {
        outcome = await (this.options.launch ?? launchActivation)(filename, intent, () => {
          this.idle();
          assert(
            Date.now() < Date.parse(plan.review.expiresAt),
            409,
            'The background handoff review expired.',
          );
          committed = true;
        });
      } catch {
        outcome = committed ? 'uncertain' : 'aborted';
      }
      if (outcome === 'aborted') {
        await writePrivateJson(filename, {
          ...intent,
          state: 'aborted',
          updatedAt: new Date().toISOString(),
          detail:
            'The handoff was not committed. The foreground workspace stays available; no native service action was authorized.',
        });
        this.transition = false;
      } else this.shutdown = true;
      return (await this.previous())!;
    } finally {
      this.checking = false;
    }
  }
  async requestShutdown() {
    if (this.shouldShutdown) await this.options?.requestShutdown();
  }
  async reviewInactive(id: string, digest: string, note: string): Promise<ActivationReceipt> {
    assert(
      this.supported && this.options && this.runtime.mode === 'foreground' && !this.isBusy,
      409,
      'Review an inactive handoff from its idle foreground workspace.',
    );
    this.idle();
    const previous = await this.previous();
    assert(
      previous?.id === id && previous.digest === digest,
      409,
      'The saved background handoff changed. Refresh before review.',
    );
    this.checking = true;
    try {
      const dir = await realpath(this.options.dataDirectory);
      assert(
        await activationLease(dir),
        409,
        'The handoff helper still owns this workspace. Wait for its confirmed exit.',
      );
      const filename = activationPath(dir, id),
        intent = await readActivation(filename);
      const definition = await verifyServiceDefinition(intent.definition, this.context);
      const installed = await installedServiceDefinition(dir, this.context);
      assert(
        !installed || installed.configurationHash === definition.configurationHash,
        409,
        'The native installation changed. Review it through the native service commands.',
      );
      assert(
        !(await serviceDefinitionLoaded(definition, this.context)),
        409,
        'A native service is still loaded. Review it through its native controls.',
      );
      this.idle();
      if (!intent.outcomeReview)
        await writePrivateJson(filename, {
          ...intent,
          outcomeReview: { at: new Date().toISOString(), note, native: 'not-loaded' },
        });
      return activationReceipt(await readActivation(filename));
    } finally {
      this.checking = false;
    }
  }
}
