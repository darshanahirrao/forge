import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ApprovalActor, CompanionGrant } from '../shared/types.js';
import type {
  CompanionRuntime,
  CompanionRuntimeLaunch,
  CompanionRuntimeReview,
  CompanionRuntimeScope,
  CompanionRuntimeSnapshot,
} from '../shared/companion-runtime.js';
import { Store, id, now } from './store.js';
import { assert, safeMessage } from './errors.js';
import { ExecutionController } from './execution.js';
import { accountBinding } from './adapters/binding.js';
import { captureWorker } from './processes.js';
import {
  ownedNativeSpawner,
  type OwnedNativeReceipt,
  type SupervisedChild,
} from './owned-native.js';
import { privateDirectory, scopeHash, readWorkerExit } from './worker-proof.mjs';
import {
  companionProviders,
  type CompanionProviderDefinition,
  type CompanionConnection,
} from './companion-providers.js';
import { resolveCredential, type CredentialMaterial } from './credentials.js';
import { validateResourceReceipt, type ResourceGovernance } from './resource-governance.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
export const runtimeRegistration = z
  .object({
    label: z.string().trim().min(1).max(80),
    accountId: identifier,
    grantId: z.string().uuid(),
  })
  .strict();
export const runtimeReviewDecision = z
  .object({
    id: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    nativeActivityReviewed: z.literal(true),
    nativeSpendingAccepted: z.literal(true),
  })
  .strict();
export const runtimeStopDecision = z
  .object({ launchId: z.string().uuid(), revision: z.number().int().nonnegative() })
  .strict();
type Proof = OwnedNativeReceipt<CompanionRuntimeScope>;
type Live = {
  child?: SupervisedChild;
  connection?: CompanionConnection;
  credentials?: CredentialMaterial;
  abort: AbortController;
  done?: Promise<unknown>;
};

/** Lifecycle authority comes only from the original native child, never an observed PID. */
export class CompanionRuntimes {
  private plans = new Map<string, CompanionRuntimeReview>();
  private live = new Map<string, Live>();
  private tasks = new Set<Promise<unknown>>();
  private busy = false;
  private closing = false;
  constructor(
    private store: Store,
    private execution: ExecutionController,
    private directory: string | undefined,
    private admit: () => Promise<void>,
    private providers: Record<string, CompanionProviderDefinition> = companionProviders,
    private persistent = true,
    private resources?: ResourceGovernance,
  ) {
    if (directory) privateDirectory(directory);
    for (const definition of Object.values(providers))
      assert(
        definition.contract === 1 &&
          definition.nativeVersion.length > 0 &&
          definition.profileFiles.length > 0 &&
          definition.profileFiles.length <= 16 &&
          definition.profileFiles.every(
            (path) =>
              /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) &&
              !path.split('/').includes('..'),
          ),
        409,
        'The native companion provider definition is unsupported.',
      );
    for (const launch of this.unclosed())
      this.saveLaunch({
        ...launch,
        state: 'unknown',
        detail:
          'The host connection ended. Exact native exit evidence must be reviewed; no gateway was restarted.',
      });
  }
  get supported() {
    return Boolean(
      this.persistent && this.directory && ['darwin', 'linux'].includes(process.platform),
    );
  }
  get isBusy() {
    return this.busy;
  }
  get hasOpenLaunch() {
    return this.unclosed().length > 0;
  }
  private unclosed(): CompanionRuntimeLaunch[] {
    return this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='companion_launches' AND json_extract(data,'$.exitConfirmed') IS NOT 1",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  private runtime(runtimeId: string) {
    const runtime = this.store.get<CompanionRuntime>('companion_runtimes', runtimeId);
    assert(runtime && !runtime.retiredAt, 404, 'This native companion runtime is unavailable.');
    return runtime;
  }
  private launch(launchId: string) {
    const launch = this.store.get<CompanionRuntimeLaunch>('companion_launches', launchId);
    assert(launch, 404, 'This native companion launch is unavailable.');
    return launch;
  }
  private saveLaunch(launch: CompanionRuntimeLaunch) {
    return this.store.put('companion_launches', launch.id, {
      ...launch,
      revision: launch.revision + 1,
      updatedAt: now(),
    });
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  private grant(runtime: CompanionRuntime) {
    const grant = this.store.get<CompanionGrant>('companion_grants', runtime.grantId);
    assert(
      grant &&
        !grant.revokedAt &&
        grant.expiresAt > now() &&
        grant.profileId === runtime.profileId &&
        grant.root === runtime.root &&
        (!grant.lifecycle || ['active', 'staged'].includes(grant.lifecycle)),
      409,
      'The linked native companion access changed, expired or is preparing to drain.',
    );
    return grant;
  }
  private async boundary(runtime: CompanionRuntime) {
    this.grant(runtime);
    const account = this.store.account(runtime.accountId);
    assert(
      !account.backend &&
        !account.connector &&
        account.harness === runtime.harness &&
        this.providers[account.harness],
      409,
      'Choose a supported native companion account.',
    );
    const home = await realpath(account.nativeHome).catch(() => null);
    assert(
      home &&
        home === account.nativeHome &&
        (await realpath(runtime.root).catch(() => null)) === runtime.root,
      409,
      'The native profile or project target changed.',
    );
    const paths = this.providers[account.harness].profileFiles;
    const nativeFiles: CompanionRuntimeReview['nativeFiles'] = [];
    for (const path of paths) {
      let file;
      try {
        file = await open(join(home, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          nativeFiles.push({ path, sha256: null });
          continue;
        }
        throw error;
      }
      try {
        const before = await file.stat();
        assert(
          before.isFile() && before.size <= 4 * 1024 * 1024,
          409,
          'A native profile review file is not regular or exceeds its supported size.',
        );
        const content = createHash('sha256');
        const buffer = Buffer.alloc(65536);
        let offset = 0;
        for (;;) {
          const read = await file.read(buffer, 0, buffer.length, offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
          assert(
            offset <= 4 * 1024 * 1024,
            409,
            'A native profile file changed beyond its review bound.',
          );
          content.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await file.stat();
        const currentPath = await lstat(join(home, path));
        assert(
          before.ino === after.ino &&
            before.ino === currentPath.ino &&
            before.dev === currentPath.dev &&
            !currentPath.isSymbolicLink() &&
            before.size === after.size &&
            before.mtimeMs === after.mtimeMs &&
            (await realpath(join(home, path))) === join(home, path),
          409,
          'A native profile file changed during review.',
        );
        nativeFiles.push({ path, sha256: content.digest('hex') });
      } finally {
        await file.close();
      }
    }
    assert(
      this.grant(runtime).id === runtime.grantId &&
        accountBinding(this.store.account(account.id)) === accountBinding(account),
      409,
      'The native account changed during review.',
    );
    const nativeResources = this.resources?.review();
    return {
      account,
      home,
      nativeFiles,
      nativeResources,
      binding: hash({
        runtimeId: runtime.id,
        ...(nativeResources ? { resourcePolicyDigest: nativeResources.digest } : {}),
        revision: runtime.revision,
        account: accountBinding(account),
        nativeFiles,
        grantId: runtime.grantId,
        profileId: runtime.profileId,
        root: runtime.root,
      }),
    };
  }
  register(value: unknown) {
    assert(
      this.supported && !this.closing && !this.busy,
      409,
      'Native companion lifecycle needs an idle file-backed macOS or Linux workspace.',
    );
    const input = runtimeRegistration.parse(value),
      account = this.store.account(input.accountId),
      grant = this.store.get<CompanionGrant>('companion_grants', input.grantId);
    assert(
      this.providers[account.harness] &&
        account.nativeHome &&
        !account.backend &&
        !account.connector,
      409,
      'Select an explicit supported native companion profile.',
    );
    assert(
      grant && !grant.revokedAt && grant.expiresAt > now(),
      409,
      'Choose current native MCP companion access.',
    );
    assert(
      Number(
        this.store.db
          .prepare(
            "SELECT COUNT(*) AS value FROM records WHERE collection='companion_runtimes' AND json_type(data,'$.retiredAt') IS NULL",
          )
          .get()!.value,
      ) < 32,
      409,
      'Retire an unused native runtime before registering another.',
    );
    const runtime: CompanionRuntime = {
      ...input,
      id: id(),
      profileId: grant.profileId,
      root: grant.root,
      harness: account.harness,
      revision: 0,
      createdAt: now(),
    };
    return this.store.put('companion_runtimes', runtime.id, runtime);
  }
  async prepare(runtimeId: string) {
    assert(this.supported && !this.closing && !this.busy, 409, 'Wait for native lifecycle setup.');
    this.busy = true;
    try {
      return await this.execution.atWorkspaceCheckpoint('native-companion-review', async () => {
        await this.admit();
        const runtime = this.runtime(runtimeId);
        assert(
          !this.unclosed().some(
            (launch) => launch.runtimeId === runtimeId || launch.profileId === runtime.profileId,
          ),
          409,
          'Stop and reconcile the current native companion for this profile first.',
        );
        const boundary = await this.boundary(runtime);
        for (const [key, plan] of this.plans) if (plan.expiresAt <= now()) this.plans.delete(key);
        assert(this.plans.size < 32, 409, 'Finish earlier native runtime reviews first.');
        const plan: CompanionRuntimeReview = {
          ...(boundary.nativeResources ? { nativeResources: boundary.nativeResources } : {}),
          id: id(),
          digest: '',
          runtime,
          account: {
            id: boundary.account.id,
            label: boundary.account.label,
            harness: boundary.account.harness,
            billingMode: boundary.account.billingMode,
          },
          nativeHome: boundary.home,
          nativeFiles: boundary.nativeFiles,
          binding: boundary.binding,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        };
        plan.digest = hash(plan);
        this.plans.set(plan.id, plan);
        return plan;
      });
    } finally {
      this.busy = false;
    }
  }
  async start(value: unknown, actor: ApprovalActor) {
    const input = runtimeReviewDecision.parse(value);
    const previous = this.store.get<CompanionRuntimeLaunch>('companion_launches', input.id);
    if (previous) {
      assert(previous.binding === input.digest, 409, 'This launch ID has different intent.');
      return previous;
    }
    assert(this.supported && !this.closing && !this.busy, 409, 'Wait for native lifecycle setup.');
    const plan = this.plans.get(input.id);
    assert(
      plan && plan.digest === input.digest && plan.expiresAt > now(),
      409,
      'The native runtime review expired or changed.',
    );
    this.busy = true;
    let accepted: (launch: CompanionRuntimeLaunch) => void = () => {},
      rejected: (reason: unknown) => void = () => {};
    const acceptance = new Promise<CompanionRuntimeLaunch>((resolve, reject) => {
      accepted = resolve;
      rejected = reject;
    });
    const task = this.execution.atWorkspaceCheckpoint('native-companion-start', async () => {
      let live: Live | undefined;
      try {
        await this.admit();
        const runtime = this.runtime(plan.runtime.id);
        assert(
          !this.unclosed().some((row) => row.profileId === runtime.profileId),
          409,
          'Stop and reconcile the current native companion for this profile first.',
        );
        const boundary = await this.boundary(runtime);
        assert(
          boundary.binding === plan.binding,
          409,
          'Native profile contents changed after review. Prepare again.',
        );
        const launch: CompanionRuntimeLaunch = {
          ...(boundary.nativeResources ? { nativeResources: boundary.nativeResources } : {}),
          id: plan.id,
          runtimeId: runtime.id,
          accountId: runtime.accountId,
          profileId: runtime.profileId,
          grantId: runtime.grantId,
          harness: runtime.harness,
          generation: runtime.revision + 1,
          revision: 0,
          state: 'starting',
          exitConfirmed: false,
          binding: plan.digest,
          createdAt: now(),
          actor,
          detail:
            'The reviewed native gateway is starting. Its native channels, scheduler and provider policy retain ownership.',
        };
        this.store.transaction(() => {
          this.store.put('companion_launches', launch.id, launch);
          this.store.put('companion_runtimes', runtime.id, {
            ...runtime,
            currentLaunchId: launch.id,
            revision: runtime.revision + 1,
          });
        });
        this.plans.delete(plan.id);
        live = { abort: new AbortController() };
        this.live.set(launch.id, live);
        accepted(launch);
        live.credentials = await resolveCredential(boundary.account);
        const scope: CompanionRuntimeScope = {
          kind: 'companion-runtime',
          launchId: launch.id,
          runtimeId: runtime.id,
          accountId: runtime.accountId,
          profileId: runtime.profileId,
          generation: launch.generation,
          harness: runtime.harness,
          ...(launch.nativeResources
            ? { resourcePolicyDigest: launch.nativeResources.digest }
            : {}),
        };
        const mayStart = () => {
          this.resources?.assertCurrent(launch.nativeResources, boundary.account);
          const current = this.launch(launch.id);
          return (
            !this.closing &&
            !current.stopRequestedAt &&
            current.state === 'starting' &&
            accountBinding(this.store.account(runtime.accountId)) ===
              accountBinding(boundary.account) &&
            Boolean(this.grant(runtime))
          );
        };
        const spawner = ownedNativeSpawner({
          directory: this.directory!,
          scope,
          resources: launch.nativeResources,
          nativeHome: boundary.home,
          mayPrepare: mayStart,
          mayCommit: mayStart,
          prepared: (proof) =>
            this.store.transaction(() => {
              this.store.put('companion_supervisions', proof.id, proof);
              this.store.put('companion_launches', launch.id, {
                ...this.launch(launch.id),
                supervisionId: proof.id,
              });
            }),
          phaseChanged: (proof) => this.store.put('companion_supervisions', proof.id, proof),
        });
        const connection = await this.providers[runtime.harness].connect(
          boundary.account,
          runtime.root,
          live.credentials,
          (command, args, options, policy) => {
            const child = spawner(
              command,
              args,
              { ...options, signal: live!.abort.signal },
              policy,
            );
            live!.child = child;
            child.once('close', () => {
              this.track(this.complete(launch.id));
            });
            this.track(
              child.nativeStarted.then(async (pid) => {
                if (!pid) return;
                const ownerPid = child.pid;
                assert(ownerPid, 409, 'The original native child owner is unavailable.');
                const identity = await captureWorker(ownerPid);
                const current = this.launch(launch.id);
                if (!current.exitConfirmed)
                  this.saveLaunch({
                    ...current,
                    nativePid: pid,
                    nativeWorker: {
                      version: 2,
                      pid: ownerPid,
                      ownerPid: process.pid,
                      ...identity,
                      supervisionId: current.supervisionId,
                      capturedAt: now(),
                    },
                  });
              }),
            );
            return child;
          },
        );
        live.connection = connection;
        assert(
          live.child &&
            (await live.child.nativeStarted) === connection.pid &&
            connection.version === this.providers[runtime.harness].nativeVersion,
          409,
          'The native provider did not retain the original owned launch.',
        );
        const current = this.launch(launch.id);
        if (current.stopRequestedAt || this.closing) {
          await connection.stop();
          return;
        }
        assert(
          !connection.signal.aborted && !current.exitConfirmed,
          409,
          'The native gateway closed during startup.',
        );
        this.saveLaunch({
          ...current,
          state: 'running',
          nativeVersion: connection.version,
          detail:
            'Owned native gateway available. Native scheduling, channels, tools, approvals and model spending follow this profile’s native policy.',
        });
        connection.signal.addEventListener(
          'abort',
          () => {
            this.track(this.stopOwned(launch.id));
          },
          { once: true },
        );
      } catch (error) {
        rejected(error);
        if (live) {
          await this.stopOwned(plan.id).catch(() => {});
          // A pre-spawn stop may already have removed the handle while credential
          // resolution was pending. Dispose that late material on this path too.
          live.credentials?.dispose();
          const current = this.launch(plan.id);
          if (!current.exitConfirmed)
            this.saveLaunch({
              ...current,
              state: 'unknown',
              detail:
                'Native startup did not finish. Exact native exit evidence stays held; no launch will be replayed.',
            });
          else this.saveLaunch({ ...current, state: 'failed', detail: safeMessage(error) });
        } else throw error;
      } finally {
        this.busy = false;
      }
    });
    void this.track(task)
      .catch((error) => rejected(error))
      .finally(() => {
        this.busy = false;
      });
    return acceptance;
  }
  private evidence(launch: CompanionRuntimeLaunch) {
    if (launch.nativeResources) validateResourceReceipt(launch.nativeResources);
    const proof = launch.supervisionId
      ? this.store.get<Proof>('companion_supervisions', launch.supervisionId)
      : null;
    assert(
      proof &&
        proof.scope.kind === 'companion-runtime' &&
        proof.scope.launchId === launch.id &&
        proof.scope.runtimeId === launch.runtimeId &&
        proof.scope.accountId === launch.accountId &&
        proof.scope.profileId === launch.profileId &&
        proof.scope.generation === launch.generation &&
        proof.scope.harness === launch.harness &&
        proof.scope.resourcePolicyDigest === launch.nativeResources?.digest &&
        proof.scopeHash === scopeHash(proof.scope),
      409,
      'Exact native companion evidence is unavailable.',
    );
    if (proof.phase === 'prepared' || proof.phase === 'armed')
      return { digest: hash(proof), method: 'not-committed' as const };
    assert(proof.phase === 'committed', 409, 'Native companion launch phase is unavailable.');
    const result = readWorkerExit(proof);
    return {
      digest: result.digest,
      method: 'signed-native-close' as const,
      native: result.payload,
    };
  }
  private async complete(launchId: string) {
    const launch = this.launch(launchId);
    if (launch.exitConfirmed) return launch;
    try {
      const exit = this.evidence(launch);
      return this.saveLaunch({
        ...launch,
        state: launch.stopRequestedAt ? 'closed' : 'failed',
        exitConfirmed: true,
        endedAt: now(),
        exit,
        detail:
          'The original native child and inherited stdio closed. Review external effects and native spending before a fresh start.',
      });
    } catch {
      return this.saveLaunch({
        ...launch,
        state: 'unknown',
        detail: 'Original native closure is unverified. Its lifecycle reservation remains held.',
      });
    } finally {
      this.live.get(launchId)?.credentials?.dispose();
    }
  }
  private async stopOwned(launchId: string) {
    const live = this.live.get(launchId);
    if (!live) return;
    if (live.done) return live.done;
    return (live.done = (async () => {
      live.abort.abort();
      live.child?.kill('SIGTERM');
      if (live.connection) await live.connection.stop();
      else if (live.child && live.child.exitCode === null && live.child.signalCode === null)
        await new Promise<void>((resolve) => live.child!.once('close', () => resolve()));
      const launch = this.launch(launchId);
      if (!live.child && !launch.supervisionId)
        this.saveLaunch({
          ...launch,
          state: 'closed',
          exitConfirmed: true,
          endedAt: now(),
          detail: 'The native provider returned before an owned gateway launch was prepared.',
        });
      else await this.complete(launchId);
      live.credentials?.dispose();
      this.live.delete(launchId);
    })());
  }
  stop(runtimeId: string, value: unknown, actor: ApprovalActor) {
    const input = runtimeStopDecision.parse(value),
      runtime = this.runtime(runtimeId),
      launch = this.launch(input.launchId);
    assert(
      runtime.currentLaunchId === launch.id && launch.runtimeId === runtime.id,
      409,
      'This is not the current native runtime launch.',
    );
    if (launch.exitConfirmed) return launch;
    assert(
      input.revision <= launch.revision && this.live.has(launch.id),
      409,
      'The native runtime changed or its original handle is unavailable. Review current exit evidence.',
    );
    if (launch.stopRequestedAt) return launch;
    const updated = this.saveLaunch({
      ...launch,
      state: 'stopping',
      stopRequestedAt: now(),
      stoppedBy: actor,
      detail: 'The original native gateway is draining under its native cleanup budget.',
    });
    this.track(this.stopOwned(launch.id));
    return updated;
  }
  reconcile(launchId: string, digest: string, revision: number, actor: ApprovalActor) {
    const launch = this.launch(launchId);
    if (launch.exitConfirmed && launch.exit?.digest === digest) return launch;
    assert(
      !this.closing && !this.busy && !this.live.has(launchId) && launch.revision === revision,
      409,
      'Wait for the original native handle or review current evidence.',
    );
    const exit = this.evidence(launch);
    assert(exit.digest === digest, 409, 'Native companion evidence changed.');
    return this.saveLaunch({
      ...launch,
      state: 'closed',
      exitConfirmed: true,
      endedAt: now(),
      exit: { ...exit, actor },
      detail:
        'A human reconciled exact original native closure. No gateway, schedule or prompt was replayed.',
    });
  }
  retire(runtimeId: string, revision: number) {
    const runtime = this.runtime(runtimeId);
    assert(
      runtime.revision === revision &&
        !this.busy &&
        !this.unclosed().some((launch) => launch.runtimeId === runtimeId),
      409,
      'Stop and reconcile this native runtime before retiring it.',
    );
    return this.store.put('companion_runtimes', runtimeId, {
      ...runtime,
      retiredAt: now(),
      revision: runtime.revision + 1,
    });
  }
  uses(kind: 'account' | 'profile', value: string) {
    if (
      kind === 'account' &&
      this.store.db
        .prepare(
          "SELECT 1 FROM records WHERE collection='companion_launches' AND json_extract(data,'$.accountId')=? LIMIT 1",
        )
        .get(value)
    )
      return true;
    const field = kind === 'account' ? 'accountId' : 'profileId';
    return Boolean(
      this.store.db
        .prepare(
          `SELECT 1 FROM records WHERE collection='companion_runtimes' AND json_type(data,'$.retiredAt') IS NULL AND json_extract(data,'$.${field}')=? LIMIT 1`,
        )
        .get(value),
    );
  }
  hasOpenForAccount(accountId: string) {
    return this.unclosed().some((launch) => launch.accountId === accountId);
  }
  assertDispatch() {
    assert(
      !this.unclosed().some(
        (launch) =>
          !this.live.has(launch.id) || launch.state === 'unknown' || launch.state === 'stopping',
      ),
      409,
      'Reconcile the native companion lifecycle before dispatching more work.',
    );
  }
  sourceBoundary(grantId: string) {
    const runtimes = this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='companion_runtimes' AND json_extract(data,'$.grantId')=? ORDER BY id",
      )
      .all(grantId)
      .map((row) => JSON.parse(String(row.data)) as CompanionRuntime);
    if (!runtimes.length) return undefined;
    const states = runtimes.map((runtime) => {
      const launch = runtime.currentLaunchId ? this.launch(runtime.currentLaunchId) : undefined;
      assert(
        !launch || launch.exitConfirmed,
        409,
        'Stop and reconcile the original managed native gateway before replacing its connection.',
      );
      return {
        id: runtime.id,
        revision: runtime.revision,
        launchId: launch?.id,
        exit: launch?.exit,
      };
    });
    return hash(states);
  }
  resourceRoots() {
    return this.unclosed().flatMap((launch) =>
      launch.nativeWorker
        ? [
            {
              runtimeId: launch.runtimeId,
              launchId: launch.id,
              accountId: launch.accountId,
              harness: launch.harness,
              root: launch.nativeWorker,
            },
          ]
        : [],
    );
  }
  snapshot(): CompanionRuntimeSnapshot {
    const runtimes = this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='companion_runtimes' AND json_type(data,'$.retiredAt') IS NULL ORDER BY rowid DESC LIMIT 32",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)) as CompanionRuntime);
    const launches = this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='companion_launches' AND (json_extract(data,'$.exitConfirmed') IS NOT 1 OR id IN (SELECT json_extract(data,'$.currentLaunchId') FROM records WHERE collection='companion_runtimes' AND json_type(data,'$.retiredAt') IS NULL)) ORDER BY rowid DESC",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)) as CompanionRuntimeLaunch);
    const recovery = this.unclosed()
      .filter((launch) => !this.live.has(launch.id))
      .map((launch) => {
        try {
          const evidence = this.evidence(launch);
          return {
            launchId: launch.id,
            runtimeId: launch.runtimeId,
            revision: launch.revision,
            state: 'ready' as const,
            digest: evidence.digest,
            detail: 'Exact original native closure can be reviewed.',
          };
        } catch (error) {
          return {
            launchId: launch.id,
            runtimeId: launch.runtimeId,
            revision: launch.revision,
            state:
              (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? ('waiting' as const)
                : ('unavailable' as const),
            detail: 'Original native closure is unavailable; observation cannot clear this hold.',
          };
        }
      });
    return {
      supported: this.supported,
      providers: Object.keys(this.providers),
      runtimes,
      launches,
      recovery,
    };
  }
  async close() {
    this.closing = true;
    for (const launch of this.unclosed()) {
      const live = this.live.get(launch.id);
      if (live) {
        const current = this.launch(launch.id);
        this.saveLaunch({
          ...current,
          state: 'stopping',
          stopRequestedAt: current.stopRequestedAt ?? now(),
          detail: 'The workspace host is draining its owned native gateway.',
        });
        this.track(this.stopOwned(launch.id));
      }
    }
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }
}
