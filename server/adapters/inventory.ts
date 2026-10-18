import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import type {
  NativeInventory,
  NativeSchedule,
  NativeSession,
  NativeSource,
} from '../../shared/types.js';
import { assert } from '../errors.js';
import { now } from '../store.js';
import { NativeRpc } from './rpc.js';
import type { RpcFactory } from './codex-driver.js';
import { findBinary } from './discovery.js';
import { boundedJson, loopbackEndpoint, probeHermes } from './sources.js';

const exec = promisify(execFile);
const PAGE = 100;
const text = (value: unknown, fallback = '', max = 200) =>
  typeof value === 'string' ? value.slice(0, max) : fallback;
function date(value: unknown, seconds = false): string | null {
  const parsed =
    typeof value === 'number'
      ? value * (seconds ? 1000 : 1)
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(parsed) && Math.abs(parsed) < 8.64e15
    ? new Date(parsed).toISOString()
    : null;
}
export async function nativeFile(filename: string, maxBytes = 2 * 1024 * 1024) {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    assert(
      info.isFile() && info.size <= maxBytes,
      409,
      'The native metadata file is not a regular file within the supported size.',
    );
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    assert(length <= maxBytes, 409, 'The native metadata file grew beyond the supported size.');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}
export function codexSessionRows(value: unknown, sourceId: string): NativeSession[] {
  const response = z
    .object({
      data: z
        .array(
          z.object({
            id: z.string().max(200),
            name: z.string().nullable().optional(),
            preview: z.string().optional(),
            cwd: z.string().optional(),
            updatedAt: z.number().optional(),
            status: z.object({ type: z.string() }).optional(),
          }),
        )
        .max(PAGE + 1),
    })
    .parse(value);
  return response.data.slice(0, PAGE).map((row) => ({
    id: row.id,
    sourceId,
    title: text(row.name, text(row.preview, 'Native Codex chat', 160), 160),
    harness: 'codex',
    status:
      row.status?.type === 'notLoaded'
        ? 'Stored session; live state unknown'
        : text(row.status?.type, 'Unknown'),
    cwd: row.cwd ?? '',
    project: row.cwd ? basename(row.cwd) : 'Native workspace',
    updatedAt: date(row.updatedAt, true),
    observedAt: now(),
    source: 'codex/app-server',
    control: 'observed',
  }));
}
export function claudeSessionRows(value: unknown, sourceId: string): NativeSession[] {
  const rows = z
    .array(
      z.object({
        sessionId: z.string().max(200),
        summary: z.string(),
        customTitle: z.string().optional(),
        cwd: z.string().optional(),
        lastModified: z.number(),
      }),
    )
    .max(PAGE + 1)
    .parse(value);
  return rows.slice(0, PAGE).map((row) => ({
    id: row.sessionId,
    sourceId,
    title: text(row.customTitle, text(row.summary, 'Native Claude chat', 160), 160),
    harness: 'claude',
    status: 'Stored session; live state unknown',
    cwd: row.cwd ?? '',
    project: row.cwd ? basename(row.cwd) : 'Native workspace',
    updatedAt: date(row.lastModified),
    observedAt: now(),
    source: 'claude/agent-sdk',
    control: 'observed',
  }));
}
export function hermesSessionRows(value: unknown, sourceId: string): NativeSession[] {
  const rows = z
    .object({
      data: z
        .array(
          z.object({
            id: z.string().max(200),
            title: z.string().nullable().optional(),
            source: z.string().nullable().optional(),
            last_active: z.union([z.number(), z.string()]).nullable().optional(),
            ended_at: z.union([z.number(), z.string()]).nullable().optional(),
          }),
        )
        .max(200),
    })
    .parse(value).data;
  return rows.slice(0, PAGE).map((row) => ({
    id: row.id,
    sourceId,
    title: text(row.title, 'Native Hermes session', 160),
    harness: 'hermes',
    status: row.ended_at ? 'Ended in native records' : 'Stored session; live state unknown',
    project: text(row.source, 'Hermes'),
    updatedAt: date(row.last_active, typeof row.last_active === 'number'),
    observedAt: now(),
    source: 'hermes/api',
    control: 'observed',
  }));
}
export function openclawSessionRows(value: unknown, sourceId: string): NativeSession[] {
  const payload = value as any;
  assert(payload?.ok === true, 502, 'The gateway did not confirm its session-list result.');
  let result = payload.result?.details ?? payload.result;
  if (!Array.isArray(result?.sessions) && Array.isArray(payload.result?.content)) {
    const block = payload.result.content.find(
      (entry: any) => entry.type === 'text' && typeof entry.text === 'string',
    );
    if (block) {
      try {
        result = JSON.parse(block.text);
      } catch {
        /* Reject unsupported native output below. */
      }
    }
  }
  const rows = z
    .object({
      sessions: z
        .array(
          z.object({
            key: z.string().optional(),
            sessionId: z.string().optional(),
            displayName: z.string().optional(),
            label: z.string().optional(),
            updatedAt: z.number().optional(),
            kind: z.string().optional(),
          }),
        )
        .max(1000),
    })
    .parse(result).sessions;
  return rows.slice(0, PAGE).map((row) => {
    const id = row.sessionId ?? row.key;
    assert(id, 502, 'The native session list omitted its identifier.');
    return {
      id,
      sourceId,
      title: text(
        row.displayName,
        text(row.label, text(row.key, 'Native OpenClaw session', 160), 160),
        160,
      ),
      harness: 'openclaw',
      status: 'Observed session; live state unknown',
      project: text(row.kind, 'OpenClaw'),
      updatedAt: date(row.updatedAt),
      observedAt: now(),
      source: 'openclaw/gateway',
      control: 'observed',
    };
  });
}
export function hermesScheduleRows(value: unknown, sourceId: string): NativeSchedule[] {
  const rows = z
    .object({ jobs: z.array(z.record(z.string(), z.unknown())).max(2000) })
    .parse(value).jobs;
  return rows.map((row) => {
    assert(
      typeof row.id === 'string' && row.id.length <= 200,
      502,
      'The native job store omitted its identifier.',
    );
    const schedule = row.schedule as Record<string, unknown> | undefined;
    return {
      id: row.id,
      sourceId,
      title: text(row.name, row.id, 160),
      owner: 'hermes',
      kind: text(schedule?.kind, 'Native schedule'),
      state: text(
        row.state,
        row.enabled === true ? 'enabled' : row.enabled === false ? 'paused' : 'unknown',
      ),
      rule: text(
        row.schedule_display,
        text(schedule?.display, text(schedule?.expr, 'Native rule')),
        1000,
      ),
      nextRunAt: date(row.next_run_at),
      lastRunAt: date(row.last_run_at),
      lastOutcome: typeof row.last_status === 'string' ? row.last_status : null,
      observedAt: now(),
    };
  });
}
export function codexScheduleRow(
  value: unknown,
  sourceId: string,
  fallbackId: string,
): NativeSchedule {
  const row = z.record(z.string(), z.unknown()).parse(value);
  return {
    id: text(row.id, fallbackId),
    sourceId,
    title: text(row.name, fallbackId, 160),
    owner: 'codex',
    kind: text(row.kind, 'Native automation'),
    state: text(row.status, 'unknown'),
    rule: text(row.rrule, 'Native schedule', 1000),
    nextRunAt: null,
    lastRunAt: null,
    lastOutcome: null,
    observedAt: now(),
  };
}

export interface InventoryOptions {
  rpcFactory?: RpcFactory;
  codexBinary?: string;
  t3Reader?: (
    source: NativeSource,
  ) => Promise<{ inventory: NativeInventory; capabilities: string[] }>;
  openClawSchedulesReader?: (
    source: NativeSource,
  ) => Promise<{ inventory: NativeInventory; capabilities: string[] }>;
}
export async function readNativeInventory(
  source: NativeSource,
  options: InventoryOptions = {},
): Promise<{ inventory: NativeInventory; capabilities: string[] }> {
  const checkedAt = now();
  if (source.kind === 'openclaw-schedules') {
    assert(
      options.openClawSchedulesReader,
      409,
      'Pair the native OpenClaw scheduler before reading its jobs.',
    );
    return options.openClawSchedulesReader(source);
  }
  if (source.kind === 't3-code') {
    assert(options.t3Reader, 409, 'Connect T3 Code from Activity to enable native MCP discovery.');
    return options.t3Reader(source);
  }
  if (source.kind === 'codex') {
    const binary = options.codexBinary ?? (await findBinary('codex'));
    assert(binary, 409, 'Install native Codex before reading its session catalog.');
    const rpc = (options.rpcFactory ?? ((opts) => new NativeRpc(opts)))({
      binary,
      env: { ...process.env, CODEX_HOME: source.home },
      timeoutMs: 10000,
    });
    rpc.on('message', (message) => {
      if (message.id !== undefined) rpc.refuse(message.id);
    });
    try {
      await rpc.initialize();
      const response = await rpc.request('thread/list', {
        limit: PAGE,
        sortKey: 'updated_at',
        modelProviders: [],
        useStateDbOnly: true,
      });
      return {
        inventory: {
          sessions: codexSessionRows(response, source.id),
          schedules: [],
          moreAvailable: Boolean(response.nextCursor),
          checkedAt,
        },
        capabilities: ['Native session metadata', 'State database only', 'Observed ownership'],
      };
    } finally {
      await rpc.stop();
    }
  }
  if (source.kind === 'claude') {
    // A separate metadata reader avoids changing the service's global native configuration directory.
    const script =
      'const {listSessions}=await import(process.argv[1]);process.stdout.write(JSON.stringify(await listSessions({limit:101,includeProgrammatic:true})));';
    const result = await exec(
      process.execPath,
      ['--input-type=module', '-e', script, import.meta.resolve('@anthropic-ai/claude-agent-sdk')],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: source.home },
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const raw = JSON.parse(result.stdout);
    return {
      inventory: {
        sessions: claudeSessionRows(raw, source.id),
        schedules: [],
        moreAvailable: raw.length > PAGE,
        checkedAt,
      },
      capabilities: ['Native SDK session catalog', 'Observed ownership'],
    };
  }
  if (source.kind === 'codex-schedules') {
    const root = join(source.home, 'automations');
    const entries = await readdir(root, { withFileTypes: true });
    assert(
      entries.length <= 2000,
      409,
      'This native schedule directory exceeds the supported inventory size.',
    );
    const schedules: NativeSchedule[] = [];
    for (const entry of entries.filter((e) => e.isDirectory())) {
      const raw = await nativeFile(join(root, entry.name, 'automation.toml'), 256 * 1024).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      // Native deletion can leave an empty profile folder; it is not a schedule definition.
      if (raw === null) continue;
      const value = parseToml(raw);
      schedules.push(codexScheduleRow(value, source.id, entry.name));
    }
    return {
      inventory: { sessions: [], schedules, moreAvailable: false, checkedAt },
      capabilities: ['Native automation definitions', 'Read only; native scheduler owns execution'],
    };
  }
  if (source.kind === 'hermes-schedules') {
    const value = JSON.parse(await nativeFile(join(source.home, 'cron', 'jobs.json')));
    return {
      inventory: {
        sessions: [],
        schedules: hermesScheduleRows(value, source.id),
        moreAvailable: false,
        checkedAt,
      },
      capabilities: ['Profile-scoped native job store', 'Read only; no repair or scheduler tick'],
    };
  }
  const endpoint = loopbackEndpoint.parse(source.endpoint);
  const token = source.tokenEnv ? process.env[source.tokenEnv] : undefined;
  assert(
    !source.tokenEnv || token,
    409,
    'The referenced native token environment variable is not set.',
  );
  if (source.kind === 'hermes') {
    const probe = await probeHermes(endpoint, source.tokenEnv);
    assert(
      probe.capabilities.includes('session_resources'),
      409,
      'This Hermes API does not advertise session resources.',
    );
    const value = await boundedJson(
      `${endpoint}/api/sessions?limit=${PAGE}&include_children=true`,
      token,
    );
    return {
      inventory: {
        sessions: hermesSessionRows(value, source.id),
        schedules: [],
        moreAvailable: value.has_more === true,
        checkedAt,
      },
      capabilities: probe.capabilities,
    };
  }
  assert(source.kind === 'openclaw', 400, 'Unknown native inventory adapter.');
  const value = await boundedJson(`${endpoint}/tools/invoke`, token, {
    tool: 'sessions_list',
    action: 'json',
    args: { limit: PAGE, messageLimit: 0 },
  });
  return {
    inventory: {
      sessions: openclawSessionRows(value, source.id),
      schedules: [],
      moreAvailable: false,
      checkedAt,
    },
    capabilities: ['Native sessions_list', 'Observed ownership; gateway tool policy applies'],
  };
}
