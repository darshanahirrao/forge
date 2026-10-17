import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hermesPython } from './hermes-install.js';
import type { ClientApp, PromptResponse } from '@agentclientprotocol/sdk';
import type { Account, Usage } from '../../shared/types.js';
import { version } from '../../shared/version.js';
import { assert } from '../errors.js';
import { credentialValue, type CredentialMaterial } from '../credentials.js';
import { now } from '../store.js';
import { findBinary } from './discovery.js';
import { acquireProfileLease } from './profile-lease.js';
import {
  spawnAcpWorker,
  boundedAcpRequest,
  type AcpWorker,
  type AcpWorkerFactory,
} from './acp-worker.js';
import type { DriverContext } from './driver.js';
import { AcpDriver } from './acp-driver.js';

export function hermesEnvironment(
  account: Pick<Account, 'nativeHome' | 'credentialEnv'> &
    Partial<Pick<Account, 'credentialReference'>>,
  credentials?: CredentialMaterial,
): NodeJS.ProcessEnv {
  assert(account.nativeHome, 409, 'Choose an explicit native Hermes home before launching.');
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ])
    if (process.env[key]) env[key] = process.env[key];
  env.HERMES_HOME = account.nativeHome;
  if (account.credentialEnv) {
    assert(
      !/^(PATH|HOME|CODEX_HOME|XDG_|HERMES_|FORGE_DATA_DIR|TMP|TEMP|SystemRoot|COMSPEC)/i.test(
        account.credentialEnv,
      ),
      409,
      'Choose a provider credential variable, not a runtime setting.',
    );
    assert(
      credentialValue(account as Account, account.credentialEnv, credentials),
      409,
      `Set ${account.credentialEnv} before launching.`,
    );
    env[account.credentialEnv] = credentialValue(
      account as Account,
      account.credentialEnv,
      credentials,
    );
  }
  return env;
}
export async function startHermesWorker(
  app: ClientApp,
  account: Account,
  cwd: string,
  credentials?: CredentialMaterial,
): Promise<AcpWorker> {
  const env = hermesEnvironment(account, credentials);
  const binary = await findBinary('hermes');
  assert(binary, 409, 'Install Hermes with its ACP extra through its native setup first.');
  const python = await hermesPython(binary);
  const release = await acquireProfileLease(account.nativeHome);
  try {
    const worker = await spawnAcpWorker(
      app,
      python,
      [fileURLToPath(new URL('./hermes-native.py', import.meta.url))],
      cwd,
      env,
    );
    let stopped: Promise<void> | null = null;
    return {
      pid: worker.pid,
      connection: worker.connection,
      get exited() {
        return worker.exited;
      },
      stop: () => (stopped ??= worker.stop().finally(release)),
    };
  } catch (error) {
    release();
    throw error;
  }
}
export async function initializeHermesWorker(worker: AcpWorker) {
  const { PROTOCOL_VERSION } = await import('@agentclientprotocol/sdk');
  const agent = worker.connection.agent;
  const init = await boundedAcpRequest(
    worker,
    agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'forge', version },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }),
    15000,
  );
  assert(
    init.protocolVersion === 1 &&
      init.agentInfo?.name === 'hermes-agent' &&
      init.agentInfo.version === '0.17.0' &&
      (init._meta?.forge as { hermesNativeResult?: number } | undefined)?.hermesNativeResult === 1,
    409,
    'This Hermes ACP version did not confirm the native ownership and outcome-reporting contract. No input was sent.',
  );
  const methods = (init.authMethods ?? []).filter(
    (method) => (method as { type?: string }).type !== 'terminal',
  );
  assert(
    methods.length === 1,
    409,
    'Configure an active native Hermes provider through Hermes before launching. Forge does not start interactive sign-in.',
  );
  await boundedAcpRequest(
    worker,
    agent.request('authenticate', { methodId: methods[0].id }),
    10000,
  );
  return init;
}
export async function probeHermesAccount(
  account: Account,
  credentials?: CredentialMaterial,
): Promise<Account> {
  const { client } = await import('@agentclientprotocol/sdk');
  const app = client({ name: 'Forge status probe' }).onRequest(
    'session/request_permission',
    () => ({ outcome: { outcome: 'cancelled' } }),
  );
  const worker = await startHermesWorker(app, account, account.nativeHome, credentials);
  try {
    await initializeHermesWorker(worker);
    return {
      ...account,
      state: 'configured',
      identity: null,
      identityKey: null,
      plan: 'Native Hermes ACP; provider identity and allowance unknown',
      quotas: [],
      checkedAt: now(),
      error: null,
    };
  } finally {
    await worker.stop();
  }
}
/** Hermes retains its stricter native provenance, mode and outcome contract. */
export class HermesDriver extends AcpDriver {
  constructor(factory?: AcpWorkerFactory) {
    super(
      {
        harness: 'hermes',
        name: 'Hermes',
        mode: 'default',
        coverage:
          'Native tools, memory, skills and provider configuration remain in the selected Hermes home. Native command rules and default edit review apply.',
        start: (app, context) =>
          startHermesWorker(app, context.account, context.work.cwd, context.credentials),
        initialize: initializeHermesWorker,
        verifySession: (state, sessionId) => {
          const native = state._meta?.hermes as
            { sessionProvenance?: { acpSessionId?: string } } | undefined;
          assert(
            native?.sessionProvenance?.acpSessionId === sessionId,
            409,
            'Hermes did not confirm the selected native session. A missing session cannot silently become a fresh conversation.',
          );
        },
        report: (result, context, sessionId) => {
          const report = hermesReport(result, sessionId);
          const status =
            report.interrupted || result.stopReason === 'cancelled'
              ? 'interrupted'
              : report.failed || report.cleanupFailed
                ? 'failed'
                : report.reported && report.completed && result.stopReason === 'end_turn'
                  ? 'completed'
                  : 'interrupted';
          return {
            status,
            usage: report.usage ? hermesUsage(context, report) : undefined,
            detail: `ACP stop reason: ${result.stopReason}. Native outcome ${report.reported ? 'reported' : 'unavailable'}; the task's acceptance criteria remain separate.`,
          };
        },
      },
      factory,
    );
  }
}

const count = z.number().finite().nonnegative().nullable().optional();
export const hermesReportSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  reported: z.boolean(),
  completed: z.boolean().optional(),
  failed: z.boolean().optional(),
  interrupted: z.boolean().optional(),
  cleanupFailed: z.boolean().optional(),
  usage: z
    .object({
      inputTokens: count,
      outputTokens: count,
      totalTokens: count,
      thoughtTokens: count,
      cachedReadTokens: count,
      cachedWriteTokens: count,
    })
    .optional(),
  estimatedUsd: count,
  costStatus: z.string().max(80).optional(),
});
export type HermesReport = z.infer<typeof hermesReportSchema>;
export function hermesReport(result: PromptResponse, sessionId: string): HermesReport {
  const data = hermesReportSchema.parse(
    (result._meta?.forge as { hermesTurn?: unknown } | undefined)?.hermesTurn,
  );
  assert(
    data.sessionId === sessionId,
    502,
    'The native Hermes turn evidence changed session scope.',
  );
  return data;
}
export function hermesUsage(context: DriverContext, result: HermesReport): Usage {
  const u = result.usage!;
  assert(
    [u.inputTokens, u.outputTokens, u.totalTokens].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
    ),
    502,
    'Hermes did not report complete native usage counters.',
  );
  // Native counters reset on construction. One owned worker receives one prompt, including native queued continuations.
  return {
    key: `hermes-acp:${context.run.id}`,
    counterScope: 'run',
    workId: context.work.id,
    accountId: context.account.id,
    harness: 'hermes',
    source: 'hermes/acp',
    scope: `Native root worker counters; context pressure excluded; native cost status ${result.costStatus || 'unknown'}`,
    inputTokens: u.inputTokens!,
    outputTokens: u.outputTokens!,
    cachedTokens: u.cachedReadTokens ?? 0,
    reasoningTokens: u.thoughtTokens ?? 0,
    cacheWriteTokens: u.cachedWriteTokens ?? 0,
    totalTokens: u.totalTokens!,
    estimatedUsd: ['actual', 'estimated', 'included'].includes(result.costStatus || '')
      ? (result.estimatedUsd ?? null)
      : null,
    observedAt: now(),
  };
}
