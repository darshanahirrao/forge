import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NativeSession, RuntimeProbe, Usage } from '../../shared/types.js';
import { findBinary } from './discovery.js';
import { assert } from '../errors.js';
import { now } from '../store.js';
const exec = promisify(execFile);

export const loopbackEndpoint = z
  .string()
  .max(300)
  .transform((value) => value.replace(/\/$/, ''))
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === '/'
      );
    } catch {
      return false;
    }
  }, 'Use a local HTTP API address, such as http://127.0.0.1:8642, without a path or credentials.');

export async function boundedJson(url: string, token?: string, body?: unknown): Promise<any> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3500),
    redirect: 'error',
  });
  assert(
    response.ok,
    502,
    response.status === 401 || response.status === 403
      ? 'The native API requires authorization. Set the referenced environment variable and restart Forge.'
      : `The native API returned HTTP ${response.status}. Check its native setup.`,
  );
  const reader = response.body?.getReader();
  assert(reader, 502, 'The native API returned an empty response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      assert(
        length <= 512 * 1024,
        502,
        'The native response exceeded the supported inventory size.',
      );
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function probeHermes(endpoint: string, tokenEnv?: string): Promise<RuntimeProbe> {
  const base = loopbackEndpoint.parse(endpoint);
  const token = tokenEnv ? process.env[tokenEnv] : undefined;
  assert(
    !tokenEnv || token,
    409,
    'The named environment variable is not set. Set it before starting Forge, then reconnect.',
  );
  const health = await boundedJson(`${base}/health`, token);
  assert(
    health.platform === 'hermes-agent' && health.status === 'ok',
    502,
    'This address did not identify a healthy Hermes API server.',
  );
  const capabilities = await boundedJson(`${base}/v1/capabilities`, token);
  assert(
    capabilities.platform === 'hermes-agent' &&
      capabilities.features &&
      typeof capabilities.features === 'object',
    502,
    'This Hermes version did not advertise the supported capability contract.',
  );
  return {
    status: 'connected',
    endpoint: base,
    version: typeof health.version === 'string' ? health.version : null,
    capabilities: Object.entries(capabilities.features)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name),
    checkedAt: now(),
    error: null,
  };
}
export function normalizeDeckSessions(value: unknown): NativeSession[] {
  const rows = z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        tool: z.string(),
        status: z.string(),
        path: z.string().optional(),
      }),
    )
    .max(1000)
    .parse(value);
  return rows.map((s) => ({
    id: s.id,
    title: s.title,
    harness: s.tool,
    status: s.status,
    project: s.path ? basename(s.path) : 'Native workspace',
    source: 'agent-deck',
  }));
}
export async function readDeckSessions(): Promise<NativeSession[]> {
  const binary = await findBinary('agent-deck');
  assert(
    binary,
    409,
    'Agent Deck is not installed. Connect an existing installation to read its sessions.',
  );
  const result = await exec(binary, ['list', '--json'], {
    timeout: 8000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return normalizeDeckSessions(JSON.parse(result.stdout));
}
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export function normalizeCcusage(value: unknown): Usage[] {
  const report = z
    .object({
      unpricedModels: z.unknown().optional(),
      missingPricing: z.unknown().optional(),
      daily: z
        .array(
          z.object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            inputTokens: tokens,
            outputTokens: tokens,
            cacheCreationTokens: tokens.optional().default(0),
            cacheReadTokens: tokens.optional().default(0),
            totalCost: z.number().finite().nonnegative().nullable().optional(),
            totalTokens: tokens.optional(),
            unpricedModels: z.array(z.unknown()).optional(),
            missingPricing: z.boolean().optional(),
          }),
        )
        .max(3660),
    })
    .parse(value);
  const missing = (value: unknown) =>
    value === true ||
    (Array.isArray(value) && value.length > 0) ||
    (typeof value === 'object' && value !== null && Object.keys(value).length > 0);
  return report.daily.map((row) => ({
    key: `ccusage:claude:daily:${row.date}`,
    workId: null,
    accountId: null,
    harness: 'claude',
    source: 'ccusage',
    scope: `Claude daily aggregate ${row.date}`,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cacheReadTokens,
    totalTokens:
      row.totalTokens ??
      row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
    estimatedUsd:
      row.missingPricing ||
      row.unpricedModels?.length ||
      missing(report.unpricedModels) ||
      missing(report.missingPricing)
        ? null
        : (row.totalCost ?? null),
    observedAt: now(),
  }));
}
export async function readCcusage(): Promise<Usage[]> {
  const binary = await findBinary('ccusage');
  assert(
    binary,
    409,
    'ccusage is not installed. Connect its native CLI to read usage without a custom transcript parser.',
  );
  const result = await exec(binary, ['daily', '--json'], {
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return normalizeCcusage(JSON.parse(result.stdout));
}
export function requestDigest(method: string, params: unknown, runId: string, generation: number) {
  return createHash('sha256')
    .update(JSON.stringify({ method, params, runId, generation }))
    .digest('hex');
}
