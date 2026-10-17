import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';
import type { InitializeResponse, ClientApp } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { Account, Run, Work } from '../shared/types.js';
import type { NativeConnector, ConnectorPlan } from '../shared/connectors.js';
import { Store, id, now } from './store.js';
import { assert } from './errors.js';
import { version } from '../shared/version.js';
import { AcpDriver } from './adapters/acp-driver.js';
import { boundedAcpRequest, spawnAcpWorker, type AcpWorker } from './adapters/acp-worker.js';
import { acquireProfileLease } from './adapters/profile-lease.js';
import { credentialTarget, credentialValue, type CredentialMaterial } from './credentials.js';
import type { DriverContext } from './adapters/driver.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const connectorId = z.string().regex(/^ext\.[a-z][a-z0-9.-]{1,75}$/);
const homeVariable = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,100}(?:_HOME|_CONFIG_DIR)$/)
  .refine((key) => !/^(?:FORGE_|LD_|DYLD_|NODE_|PYTHON)/.test(key));
const homePath = z
  .string()
  .max(200)
  .refine(
    (value) =>
      value === '.' ||
      (/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
        !value.split('/').some((part) => part === '..' || part === '.')),
  );
export const connectorManifestSchema = z
  .object({
    format: z.literal('forge.native-connector'),
    version: z.literal(1),
    id: connectorId,
    name: text(80),
    protocol: z.literal('acp/1'),
    executable: text(2000).refine(isAbsolute),
    args: z
      .array(
        z
          .string()
          .max(2000)
          .refine((arg) => !/[\x00\r\n]/.test(arg)),
      )
      .max(32),
    agent: z.object({ name: text(100), version: text(80) }).strict(),
    mode: text(80),
    model: text(200).optional(),
    homeVariables: z
      .record(homeVariable, homePath)
      .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 8),
  })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const coverage =
  'ACP v1 native execution and one-time native permission requests. Native tools, sign-in, model, memory and policy remain upstream. ACP stop reasons report turn completion only; task acceptance, provider identity/limits and billable usage remain unverified. No browser/file/terminal tools, inference loop or scheduler is added.';

async function binaryIdentity(filename: string) {
  const executable = await realpath(filename),
    info = await stat(executable);
  assert(
    info.isFile() &&
      info.size <= 512 * 1024 * 1024 &&
      (process.platform === 'win32' || (info.mode & 0o022) === 0),
    409,
    'Select an installed regular executable without group/world write access.',
  );
  await access(executable, constants.X_OK);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(executable, { highWaterMark: 256 * 1024 }))
    digest.update(chunk);
  const after = await stat(executable);
  assert(
    info.ino === after.ino &&
      info.size === after.size &&
      info.mtimeMs === after.mtimeMs &&
      (await realpath(filename)) === executable,
    409,
    'The native executable changed during review.',
  );
  return { executable, executableDigest: digest.digest('hex') };
}

export function connectorEnvironment(
  connector: NativeConnector,
  account: Account,
  credentials?: CredentialMaterial,
  home = account.nativeHome,
) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
  ])
    if (process.env[key]) env[key] = process.env[key];
  env.HOME = home;
  if (process.platform === 'win32') {
    env.USERPROFILE = home;
    env.APPDATA = resolve(home, 'appdata', 'roaming');
    env.LOCALAPPDATA = resolve(home, 'appdata', 'local');
  }
  for (const [key, suffix] of Object.entries(connector.manifest.homeVariables)) {
    const target = resolve(home, suffix),
      child = relative(home, target);
    assert(
      child !== '..' && !child.startsWith('../') && !isAbsolute(child),
      409,
      'A connector home variable escaped the selected native profile.',
    );
    env[key] = target;
  }
  if (account.credentialEnv) {
    const target = credentialTarget(account);
    assert(
      !Object.hasOwn(connector.manifest.homeVariables, target),
      409,
      'A credential variable cannot replace a reviewed native profile variable.',
    );
    env[target] = credentialValue(account, target, credentials);
  }
  return env;
}

export class NativeConnectors {
  private plans = new Map<string, ConnectorPlan>();
  private checking = false;
  get isChecking() {
    return this.checking;
  }
  constructor(
    private store: Store,
    private isBusy: () => boolean,
  ) {}
  private async checkBinary(filename: string) {
    assert(!this.checking, 409, 'Another native connector check is in progress.');
    this.checking = true;
    try {
      return await binaryIdentity(filename);
    } finally {
      this.checking = false;
    }
  }
  list() {
    return this.store.all<NativeConnector>('connectors');
  }
  async prepare(value: unknown): Promise<ConnectorPlan> {
    assert(!this.isBusy(), 409, 'Wait for current native operations before reviewing a connector.');
    const manifest = connectorManifestSchema.parse(value);
    assert(
      this.list().length < 64,
      409,
      'This workspace already has 64 native connectors. Remove unused bindings before adding another.',
    );
    assert(
      !this.store.get('connectors', manifest.id),
      409,
      'This connector ID is immutable and already installed. Use a new versioned ID.',
    );
    const binary = await this.checkBinary(manifest.executable);
    const connector: NativeConnector = {
      id: manifest.id,
      manifest,
      ...binary,
      digest: hash([manifest, binary]),
      enabled: true,
      installedAt: now(),
    };
    const plan: ConnectorPlan = {
      id: id(),
      connector,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      coverage,
    };
    for (const [key, item] of this.plans) if (item.expiresAt <= now()) this.plans.delete(key);
    while (this.plans.size >= 16) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(plan.id, plan);
    return structuredClone(plan);
  }
  async install(planId: string, digest: string) {
    assert(
      !this.isBusy(),
      409,
      'Wait for current native operations before installing a connector.',
    );
    const plan = this.plans.get(planId);
    assert(
      plan && plan.expiresAt > now() && plan.connector.digest === digest,
      409,
      'This connector review expired or changed. Prepare it again.',
    );
    await this.verifyBinary(plan.connector);
    assert(
      !this.isBusy() && plan.expiresAt > now() && this.plans.get(planId) === plan,
      409,
      'Native activity or connector review changed during installation.',
    );
    assert(
      !this.store.get('connectors', plan.connector.id),
      409,
      'This immutable connector ID is already installed.',
    );
    assert(this.list().length < 64, 409, 'This workspace already has 64 native connectors.');
    this.plans.delete(planId);
    return this.store.put('connectors', plan.connector.id, plan.connector);
  }
  private async verifyBinary(connector: NativeConnector) {
    const current = await this.checkBinary(connector.manifest.executable);
    assert(
      current.executable === connector.executable &&
        current.executableDigest === connector.executableDigest,
      409,
      'The pinned native executable changed. Review a new versioned connector before starting it.',
    );
  }
  async validateAccount(account: Account) {
    if (!account.connector) return null;
    const connector = this.store.get<NativeConnector>('connectors', account.connector.id);
    assert(
      connector?.enabled &&
        connector.digest === account.connector.digest &&
        account.harness === connector.id &&
        account.nativeHome &&
        account.billingMode !== 'subscription' &&
        !account.backend,
      409,
      'This native connector binding is unavailable or changed. Review a compatible account slot.',
    );
    assert(
      (await realpath(account.nativeHome)) === account.nativeHome &&
        (await stat(account.nativeHome)).isDirectory(),
      409,
      'The native connector profile target changed. Link its canonical directory again.',
    );
    await this.verifyBinary(connector);
    assert(
      this.store.get<NativeConnector>('connectors', connector.id)?.enabled,
      409,
      'This native connector was retired during preparation.',
    );
    return connector;
  }
  binding(connectorId: string, harness: string) {
    const connector = this.store.get<NativeConnector>('connectors', connectorId);
    assert(
      connector?.enabled && harness === connector.id,
      409,
      'Choose an enabled connector for this harness.',
    );
    return { id: connector.id, digest: connector.digest };
  }
  async setEnabled(connectorId: string, enabled: boolean) {
    assert(
      !this.isBusy(),
      409,
      'Wait for native workers and operations before changing a connector.',
    );
    const connector = this.store.get<NativeConnector>('connectors', connectorId);
    assert(connector, 404, 'This connector was not found.');
    if (enabled) await this.verifyBinary(connector);
    assert(!this.isBusy(), 409, 'Native work started during this connector check.');
    return this.store.transaction(() => {
      const result = this.store.put('connectors', connector.id, { ...connector, enabled });
      for (const account of this.store
        .all<Account>('accounts')
        .filter((a) => a.connector?.id === connector.id))
        this.store.put('accounts', account.id, {
          ...account,
          connectorReady: enabled,
          state: enabled ? 'configured' : 'unavailable',
          error: enabled ? null : 'The selected native connector is retired.',
        });
      return result;
    });
  }
  remove(connectorId: string) {
    assert(
      !this.isBusy(),
      409,
      'Wait for native workers and operations before removing a connector.',
    );
    assert(
      !this.store.all<Account>('accounts').some((a) => a.connector?.id === connectorId),
      409,
      'Account/history bindings still reference this connector. Retire it or remove only unused account slots first.',
    );
    assert(
      !this.store.all<Run>('runs').some((run) => run.harness === connectorId) &&
        !this.store.all<Work>('work').some((work) => work.harness === connectorId),
      409,
      'Work/history still references this connector. Retire it to preserve its contract.',
    );
    assert(this.store.get('connectors', connectorId), 404, 'This connector was not found.');
    this.store.remove('connectors', connectorId);
  }
  private async initialize(
    worker: AcpWorker,
    connector: NativeConnector,
  ): Promise<InitializeResponse> {
    const init = await boundedAcpRequest(
      worker,
      worker.connection.agent.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'forge', version },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      15000,
    );
    assert(
      init.protocolVersion === 1 &&
        init.agentInfo?.name === connector.manifest.agent.name &&
        init.agentInfo.version === connector.manifest.agent.version,
      409,
      'The native agent did not match this connector protocol/name/version. No task input was sent.',
    );
    return init;
  }
  private async start(
    app: ClientApp,
    account: Account,
    cwd: string,
    credentials?: CredentialMaterial,
  ) {
    const connector = (await this.validateAccount(account))!;
    const home = await realpath(account.nativeHome);
    const release = await acquireProfileLease(home);
    try {
      const worker = await spawnAcpWorker(
        app,
        connector.executable,
        connector.manifest.args,
        cwd,
        connectorEnvironment(connector, account, credentials, home),
      );
      let stopping: Promise<void> | undefined;
      return {
        connection: worker.connection,
        pid: worker.pid,
        get exited() {
          return worker.exited;
        },
        stop: () => (stopping ??= worker.stop().finally(release)),
      };
    } catch (error) {
      release();
      throw error;
    }
  }
  driver(context: DriverContext) {
    const connector = this.store.get<NativeConnector>('connectors', context.account.connector!.id);
    assert(connector, 409, 'The native connector is unavailable.');
    return new AcpDriver({
      harness: connector.id,
      name: connector.manifest.name,
      mode: connector.manifest.mode,
      configModes: true,
      coverage,
      start: (app, ctx) => this.start(app, ctx.account, ctx.work.cwd, ctx.credentials),
      initialize: (worker) => this.initialize(worker, connector),
      configureSession: async (worker, state, sessionId) => {
        if (!connector.manifest.model) return state;
        const models = (state.configOptions ?? []).filter(
          (option) => option.category === 'model' && option.type === 'select',
        );
        assert(
          models.length === 1 && models[0].type === 'select',
          409,
          'This native agent did not advertise model configuration. No model fallback was used.',
        );
        const option = models[0];
        const choices = option.options.flatMap((item) =>
          'options' in item ? item.options : [item],
        );
        assert(
          choices.some((item) => item.value === connector.manifest.model),
          409,
          'The reviewed model is not offered by this native agent. No replacement was selected.',
        );
        if (option.currentValue === connector.manifest.model) return state;
        const changed = await boundedAcpRequest(
          worker,
          worker.connection.agent.request('session/set_config_option', {
            sessionId,
            configId: option.id,
            value: connector.manifest.model,
          }),
          10000,
        );
        return { ...state, configOptions: changed.configOptions };
      },
      verifySession: (state) => {
        if (!connector.manifest.model) return;
        const models = (state.configOptions ?? []).filter(
          (option) => option.category === 'model' && option.type === 'select',
        );
        assert(
          models.length === 1 &&
            models[0].type === 'select' &&
            models[0].currentValue === connector.manifest.model,
          409,
          'The native agent did not confirm the connector model binding. No replacement model was selected.',
        );
      },
      report: (result) => ({
        status: result.stopReason === 'end_turn' ? 'completed' : 'interrupted',
        detail: `ACP stop reason: ${result.stopReason}. Turn completion only; native task effects/acceptance and billable usage need separate verification.`,
      }),
    });
  }
  async probe(account: Account, credentials?: CredentialMaterial) {
    const connector = (await this.validateAccount(account))!;
    const { client } = await import('@agentclientprotocol/sdk');
    const app = client({ name: 'Forge connector probe' }).onRequest(
      'session/request_permission',
      () => ({ outcome: { outcome: 'cancelled' } }),
    );
    const worker = await this.start(app, account, account.nativeHome, credentials);
    try {
      await this.initialize(worker, connector);
      return {
        ...account,
        state: 'configured' as const,
        connectorReady: true,
        identity: null,
        identityKey: null,
        quotas: [],
        plan: 'Native ACP connector; provider identity, limits and billable usage unknown',
        checkedAt: now(),
        error: null,
      };
    } finally {
      await worker.stop();
    }
  }
}
