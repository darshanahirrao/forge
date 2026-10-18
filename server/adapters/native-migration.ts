import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, basename } from 'node:path';
import { z } from 'zod';
import type {
  NativeMigrationHarness,
  NativeMigrationItem,
} from '../../shared/native-migrations.js';
import { assert } from '../errors.js';
import { nativeFileSnapshot } from '../native-file-snapshot.js';
import { writePrivateJson } from '../private-json.js';
import { findBinary } from './discovery.js';
import { hermesPython } from './hermes-install.js';
import { openClawInstallation } from './openclaw-worker.js';

const exec = promisify(execFile);
const hermesScriptHash = '20a3c8d30cb49c73eb45a9da2ca7854748b2ef7ed9d25552ce6476abcb32cd25';
export interface NativeMigrationRequest {
  sourceHarness: NativeMigrationHarness;
  targetHarness: NativeMigrationHarness;
  source: string;
  target: string;
  operationRoot: string;
  signal?: AbortSignal;
  /** Native user-home namespace, supplied by isolated hosts and conformance fixtures. */
  nativeUserHome?: string;
}
export interface NativeMigrationResult {
  nativeVersion: string;
  sourceRoots: string[];
  sourceDigest: string;
  items: NativeMigrationItem[];
}
export type NativeMigrationBridge = (
  request: NativeMigrationRequest,
) => Promise<NativeMigrationResult>;
const rawItem = z
  .object({
    id: z.string().max(300).optional(),
    kind: z.string().max(100),
    status: z.string().max(40),
    source: z.string().max(4096).nullable().optional(),
    target: z.string().max(4096).nullable().optional(),
    destination: z.string().max(4096).nullable().optional(),
    sensitive: z.boolean().optional(),
    message: z.string().max(2000).optional(),
    reason: z.string().max(2000).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const reportSchema = z.object({ items: z.array(rawItem).max(2000) }).passthrough();
const inside = (root: string, path: string) => path === root || path.startsWith(root + '/');
function report(value: unknown, request: NativeMigrationRequest) {
  const result = reportSchema.parse(value);
  for (const item of result.items) {
    assert(
      !['error', 'conflict'].includes(item.status),
      409,
      'The native importer reported an error or conflict. Keep its private report for review.',
    );
    assert(
      !item.sensitive || item.status === 'skipped',
      409,
      'The native importer did not confirm that credentials were excluded. No account was activated.',
    );
    const destination = item.target ?? item.destination;
    if (destination && isAbsolute(destination))
      assert(
        inside(request.target, destination.split('#')[0]),
        409,
        'The native importer proposed a destination outside its private staged profile.',
      );
  }
  return result;
}
function sourceRoots(value: ReturnType<typeof report>, request: NativeMigrationRequest) {
  const roots = new Set<string>([
    join(request.source, request.sourceHarness === 'hermes' ? 'config.yaml' : 'openclaw.json'),
    join(request.source, 'skills'),
    join(request.source, 'cron'),
  ]);
  if (request.sourceHarness === 'hermes')
    for (const name of ['SOUL.md', 'AGENTS.md', 'memories']) roots.add(join(request.source, name));
  for (const item of value.items) {
    if (!item.source || !isAbsolute(item.source)) continue;
    const path = item.source.split('#')[0];
    roots.add(path);
    if (
      request.sourceHarness === 'openclaw' &&
      ['MEMORY.md', 'USER.md', 'SOUL.md', 'AGENTS.md'].includes(basename(path))
    ) {
      const workspace = dirname(path);
      for (const name of [
        'MEMORY.md',
        'USER.md',
        'SOUL.md',
        'AGENTS.md',
        'memory',
        'skills',
        '.agents/skills',
      ])
        roots.add(join(workspace, name));
    }
  }
  return [...roots].sort();
}
/** Native utilities own translation. This bridge supplies an isolated destination and verifies their evidence. */
export const nativeMigrationBridge: NativeMigrationBridge = async (request) => {
  assert(
    request.sourceHarness !== request.targetHarness,
    400,
    'Choose a different native runtime.',
  );
  const sandbox = join(request.operationRoot, 'os-home');
  await mkdir(sandbox, { mode: 0o700 });
  // Keep native '~' workspace/shared-skill resolution. No provider secrets or
  // runtime preload variables are inherited; source discovery is explicit.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: 'C',
    HOME: request.nativeUserHome ?? process.env.HOME ?? sandbox,
    NO_COLOR: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const workspace = join(request.target, 'workspace');
  await mkdir(workspace, { mode: 0o700 });
  let command: string, base: string[], nativeVersion: string;
  if (request.targetHarness === 'openclaw') {
    Object.assign(env, {
      OPENCLAW_HOME: request.target,
      OPENCLAW_STATE_DIR: request.target,
      OPENCLAW_CONFIG_PATH: join(request.target, 'openclaw.json'),
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_HIDE_BANNER: '1',
      OPENCLAW_SUPPRESS_NOTES: '1',
    });
    await writeFile(
      join(request.target, 'openclaw.json'),
      JSON.stringify({
        agents: { defaults: { workspace, heartbeat: { every: '0m' } } },
        gateway: { mode: 'local', reload: { mode: 'off' } },
        cron: { enabled: false },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    const installation = await openClawInstallation(env);
    command = installation.node;
    base = [installation.binary, 'migrate'];
    nativeVersion = 'OpenClaw 2026.10.4 / bundled Hermes migration';
  } else {
    env.HERMES_HOME = request.target;
    const binary = await findBinary('hermes');
    assert(binary, 409, 'Install the supported native Hermes migration utility.');
    command = await hermesPython(binary);
    const metadata = await exec(
      command,
      [
        '-c',
        'import importlib.util,json; print(json.dumps(importlib.util.find_spec("hermes_cli").origin))',
      ],
      { env, cwd: request.operationRoot, timeout: 8000, maxBuffer: 8192, signal: request.signal },
    );
    const origin = z.string().refine(isAbsolute).parse(JSON.parse(metadata.stdout));
    const script = join(
      dirname(dirname(origin)),
      'optional-skills',
      'migration',
      'openclaw-migration',
      'scripts',
      'openclaw_to_hermes.py',
    );
    const scriptBytes = await readFile(script);
    assert(
      createHash('sha256').update(scriptBytes).digest('hex') === hermesScriptHash,
      409,
      'This Hermes migration utility differs from the evaluated native contract. Evaluate it before importing.',
    );
    base = [
      script,
      '--source',
      request.source,
      '--target',
      request.target,
      '--workspace-target',
      workspace,
      '--preset',
      'full',
      '--json',
    ];
    nativeVersion = 'Hermes 0.17.0 / native OpenClaw migration ' + hermesScriptHash.slice(0, 12);
  }
  const call = async (apply: boolean) => {
    const args =
      request.targetHarness === 'openclaw'
        ? [
            ...base,
            apply ? 'apply' : 'plan',
            'hermes',
            '--from',
            request.source,
            '--no-auth-credentials',
            '--json',
            ...(apply
              ? ['--yes', '--backup-output', join(request.operationRoot, 'native-backup.tar.gz')]
              : []),
          ]
        : [...base, ...(apply ? ['--execute'] : [])];
    const output = await exec(command, args, {
      env,
      cwd: request.operationRoot,
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
      signal: request.signal,
    });
    const value: unknown = JSON.parse(output.stdout);
    await writePrivateJson(join(request.operationRoot, 'native-report.json'), value);
    return report(value, request);
  };
  const preview = await call(false);
  const roots = sourceRoots(preview, request),
    before = await nativeFileSnapshot(roots);
  const applied = await call(true);
  assert(
    applied.items.every((item) => ['migrated', 'archived', 'skipped'].includes(item.status)),
    409,
    'The native importer did not finish every reported item. Keep the private stage for review.',
  );
  const after = await nativeFileSnapshot(roots);
  assert(
    after.digest === before.digest,
    409,
    'Native source files changed during import. Keep the private stage and prepare a fresh copy.',
  );
  return {
    nativeVersion,
    sourceRoots: roots,
    sourceDigest: after.digest,
    items: applied.items.map((item) => ({
      kind: item.kind,
      status: item.status,
      source: item.source ?? null,
      target: item.target ?? item.destination ?? null,
      note: item.message ?? item.reason ?? '',
      overflowedEntries:
        typeof item.details?.overflowed_entries === 'number'
          ? Math.max(0, Math.min(100000, item.details.overflowed_entries))
          : 0,
    })),
  };
};
