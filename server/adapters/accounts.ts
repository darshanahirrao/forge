import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { Account, QuotaWindow } from '../../shared/types.js';
import { findBinary } from './discovery.js';
import { NativeRpc } from './rpc.js';
import { assert, safeMessage } from '../errors.js';
import { now } from '../store.js';
import { probeHermesAccount } from './hermes-driver.js';
import { openCodeWorker } from './opencode-worker.js';
const exec = promisify(execFile);

export function nativeEnvironment(account: Account): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (account.nativeHome && account.harness === 'codex') env.CODEX_HOME = account.nativeHome;
  if (account.nativeHome && account.harness === 'claude')
    env.CLAUDE_CONFIG_DIR = account.nativeHome;
  if (account.harness === 'claude' && account.billingMode === 'api') {
    const reference = account.credentialEnv || 'ANTHROPIC_API_KEY';
    assert(
      Boolean(process.env[reference]),
      409,
      `Set the ${reference} environment variable for this API slot before launching.`,
    );
    env.ANTHROPIC_API_KEY = process.env[reference];
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    // This route supports explicit API-key authentication only, never subscription OAuth fallback.
    for (const key of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ])
      delete env[key];
  }
  return env;
}
export function normalizeQuotas(result: any, identity: string, observedAt = now()): QuotaWindow[] {
  const buckets =
    result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
      ? Object.entries(result.rateLimitsByLimitId)
      : [['codex', result?.rateLimits]];
  return buckets.flatMap(([bucket, raw]) => {
    const value = raw as any;
    return ['primary', 'secondary'].flatMap((window) => {
      const w = value?.[window];
      if (
        !w ||
        typeof w.usedPercent !== 'number' ||
        !Number.isFinite(w.usedPercent) ||
        w.usedPercent < 0
      )
        return [];
      const minutes = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null;
      const label = minutes
        ? minutes >= 1440
          ? `${minutes / 1440} day window`
          : `${minutes / 60} hour window`
        : `${window} window`;
      const resetsAt =
        typeof w.resetsAt === 'number' &&
        Number.isFinite(w.resetsAt) &&
        w.resetsAt > 0 &&
        w.resetsAt < 8e12
          ? new Date(w.resetsAt * 1000).toISOString()
          : null;
      return [
        {
          label,
          usedPercent: w.usedPercent,
          resetsAt,
          scope: `${result.accountId ?? identity}:${bucket}:${window}`,
          source: 'native' as const,
          observedAt,
        },
      ];
    });
  });
}
export async function readCodexAccount(rpc: NativeRpc, account: Account): Promise<Account> {
  const result = await rpc.request('account/read', { refreshToken: false });
  assert(
    result?.account || result?.requiresOpenaiAuth === false,
    409,
    'Sign in through the native Codex CLI for this account slot, then check again.',
  );
  const native = result.account;
  let limits: any = null;
  try {
    limits = await rpc.request('account/rateLimits/read');
  } catch {
    /* Quotas can be unavailable with otherwise usable auth. */
  }
  const identity =
    native?.email ??
    (native?.type === 'apiKey' ? 'Native API credential' : 'Native provider configuration');
  const identityKey =
    limits?.accountId || native?.chatgptAccountId || native?.email
      ? createHash('sha256')
          .update(
            JSON.stringify({
              type: native?.type ?? 'external',
              accountId: limits?.accountId ?? native?.chatgptAccountId ?? null,
              email: native?.email ?? null,
            }),
          )
          .digest('hex')
      : null;
  return {
    ...account,
    state: 'verified',
    identity,
    identityKey,
    plan: native?.planType ?? native?.type ?? 'external',
    ordinaryUsageAllowed:
      typeof limits?.ordinaryUsageAllowed === 'boolean' ? limits.ordinaryUsageAllowed : null,
    quotas: normalizeQuotas(limits, identityKey ?? `unknown-account:${account.id}`),
    checkedAt: now(),
    error: null,
  };
}
export async function probeAccount(account: Account): Promise<Account> {
  const binary = await findBinary(account.harness);
  assert(
    binary,
    409,
    `Install ${account.harness} through its native setup, then check this slot again.`,
  );
  if (account.harness === 'codex') {
    const rpc = new NativeRpc({ binary, env: nativeEnvironment(account), timeoutMs: 10000 });
    rpc.on('message', (message) => {
      if (message.id !== undefined) rpc.refuse(message.id);
    });
    try {
      await rpc.initialize();
      return await readCodexAccount(rpc, account);
    } finally {
      await rpc.stop();
    }
  }
  if (account.harness === 'claude') {
    const result = await exec(binary, ['auth', 'status'], {
      env: nativeEnvironment(account),
      timeout: 10000,
      maxBuffer: 512 * 1024,
    }).catch((error) => {
      if (error.code === 1 && error.stdout) return { stdout: String(error.stdout) };
      throw error;
    });
    let value: any;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        'This Claude Code version did not return supported authentication JSON. Update or use native account controls.',
      );
    }
    assert(
      value.loggedIn === true,
      409,
      'This native Claude account is signed out. Sign in with its configuration directory, then check again.',
    );
    return {
      ...account,
      state: 'verified',
      identity: value.email ?? value.authMethod ?? 'Native Claude account',
      identityKey: value.email
        ? createHash('sha256')
            .update(JSON.stringify([value.authMethod, value.email, value.orgId]))
            .digest('hex')
        : null,
      plan: value.subscriptionType ?? value.authMethod ?? null,
      checkedAt: now(),
      error: null,
      quotas: [],
    };
  }
  if (account.harness === 'hermes') return probeHermesAccount(account);
  if (account.harness === 'opencode') {
    const worker = await openCodeWorker(account, account.nativeHome);
    try {
      await worker.client.location.get({ location: { directory: account.nativeHome } });
      return {
        ...account,
        state: 'configured',
        checkedAt: now(),
        identity: null,
        identityKey: null,
        plan: 'Native v2 profile; provider identity and allowance unknown',
        quotas: [],
        error: null,
      };
    } finally {
      await worker.stop();
    }
  }
  throw new Error(
    'Native identity checks for this adapter are not connected yet. The account slot can still be used in work records.',
  );
}
export function failedProbe(account: Account, error: unknown): Account {
  return { ...account, state: 'unavailable', checkedAt: now(), error: safeMessage(error) };
}
