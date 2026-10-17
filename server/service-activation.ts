import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type {
  ActivationReceipt,
  ActivationState,
  AvailabilityReview,
} from '../shared/availability.js';
import { assert } from './errors.js';
import { readPrivateJson, writePrivateJson } from './private-json.js';
import {
  controlService,
  installService,
  installedServiceDefinition,
  serviceContext,
  serviceDefinitionLoaded,
  verifyServiceDefinition,
  workspaceAvailable,
  type ServiceReceipt,
} from './background-service.js';

const exec = promisify(execFile);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z
  .string()
  .max(4000)
  .refine((v) => isAbsolute(v) && !/[\x00-\x1f\x7f]/.test(v));
const reviewSchema = z
  .object({
    id: z.string().uuid(),
    digest: sha,
    expiresAt: z.string().datetime(),
    action: z.enum(['install-and-start', 'start-installed']),
    installationId: z.string().uuid(),
    dataDirectory: absolute,
    definition: absolute,
    executable: absolute,
    runner: absolute,
    port: z.number().int().min(1024).max(65535),
    phonePort: z.number().int().min(1024).max(65535).nullable(),
    phoneOrigin: z.string().max(2000).nullable(),
    phoneUsers: z.array(z.string().max(254)).max(20),
    environment: z.record(z.string().max(128), z.string().max(4000)),
    startsAtLogin: z.boolean(),
  })
  .strict();
const stateSchema = z.enum([
  'submitted',
  'committed',
  'waiting',
  'installing',
  'starting',
  'running',
  'aborted',
  'failed',
  'uncertain',
]);
const intentSchema = z
  .object({
    version: z.literal(1),
    review: reviewSchema,
    definition: z.unknown(),
    parentPid: z.number().int().positive(),
    requestedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    state: stateSchema,
    detail: z.string().max(600),
    actor: z.literal('local-human'),
    outcomeReview: z
      .object({
        at: z.string().datetime(),
        note: z.string().min(1).max(1000),
        native: z.literal('not-loaded'),
      })
      .strict()
      .optional(),
  })
  .strict();
export interface ActivationIntent extends Omit<z.infer<typeof intentSchema>, 'definition'> {
  definition: ServiceReceipt;
}
export function activationPath(directory: string, id: string) {
  assert(z.string().uuid().safeParse(id).success, 409, 'The background handoff ID is invalid.');
  return join(directory, `.forge-activation-${id}.json`);
}
export const activationDigest = (review: Omit<AvailabilityReview, 'digest'>) =>
  createHash('sha256').update(JSON.stringify(review)).digest('hex');
export function activationReceipt(intent: ActivationIntent): ActivationReceipt {
  return {
    id: intent.review.id,
    digest: intent.review.digest,
    installationId: intent.review.installationId,
    state: intent.state,
    requestedAt: intent.requestedAt,
    updatedAt: intent.updatedAt,
    detail: intent.detail,
    ...(intent.outcomeReview ? { review: intent.outcomeReview } : {}),
  };
}
export async function readActivation(filename: string): Promise<ActivationIntent> {
  const value = intentSchema.parse(await readPrivateJson(filename));
  const { digest, ...unsigned } = value.review;
  assert(digest === activationDigest(unsigned), 409, 'The background handoff review changed.');
  return value as ActivationIntent;
}

/** A native exclusive lease survives HTTP shutdown and releases only when the helper exits. */
export async function activationLease(
  directory: string,
  acquire = false,
): Promise<(() => void) | null> {
  const filename = join(directory, '.forge-activation-owner.sqlite');
  if (!acquire) {
    const info = await lstat(filename).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return () => {};
    assert(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.uid === process.getuid?.() &&
        (info.mode & 0o077) === 0,
      409,
      'The background handoff ownership file must be private and user-owned.',
    );
  }
  const handle = await open(
    filename,
    (acquire ? constants.O_CREAT | constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW,
    0o600,
  );
  const info = await handle.stat();
  await handle.close();
  assert(
    info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0,
    409,
    'The background handoff ownership file must be private and user-owned.',
  );
  const db = new DatabaseSync(filename, { readOnly: !acquire });
  try {
    db.exec('PRAGMA busy_timeout=0');
    if (acquire)
      db.exec(
        'PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE',
      );
    else db.prepare('PRAGMA user_version').get();
  } catch (error) {
    db.close();
    if (
      (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR' &&
      /locked/.test(String((error as Error).message))
    )
      return null;
    throw error;
  }
  if (!acquire) {
    db.close();
    return () => {};
  }
  return () => db.close();
}

export type ActivationLaunch = (
  filename: string,
  intent: ActivationIntent,
  commit: () => void,
) => Promise<'committed' | 'aborted' | 'uncertain'>;
export const launchActivation: ActivationLaunch = async (filename, intent, commit) => {
  const child = spawn(
    intent.definition.node,
    [join(intent.definition.root, 'bin', 'service-activate.mjs'), filename],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { HOME: intent.definition.environment.HOME, PATH: '/usr/bin:/bin', LANG: 'C' },
    },
  );
  return new Promise((resolve) => {
    let sent = false,
      finished = false;
    const finish = (result: 'committed' | 'aborted' | 'uncertain') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        if (child.connected) child.disconnect();
      } catch {
        /* The child may already have closed its private channel. */
      }
      child.unref();
      resolve(result);
    };
    const timer = setTimeout(() => finish(sent ? 'uncertain' : 'aborted'), 8000);
    child.on('error', () => finish(sent ? 'uncertain' : 'aborted'));
    child.on('exit', () => finish(sent ? 'uncertain' : 'aborted'));
    child.on('message', (value) => {
      if (
        finished ||
        !value ||
        typeof value !== 'object' ||
        !('type' in value) ||
        !('id' in value) ||
        value.id !== intent.review.id
      )
        return;
      if (value.type === 'ready' && !sent) {
        try {
          commit();
          sent = true;
          child.send({ type: 'commit', id: intent.review.id }, (error) => {
            if (error) finish('uncertain');
          });
        } catch {
          finish(sent ? 'uncertain' : 'aborted');
        }
      } else if (value.type === 'committed' && sent) finish('committed');
    });
  });
};

async function actualParent() {
  const { stdout } = await exec('/bin/ps', ['-o', 'ppid=', '-p', String(process.pid)], {
    timeout: 2000,
    maxBuffer: 128,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  });
  assert(/^\s*\d+\s*$/.test(stdout), 409, 'The background handoff parent could not be verified.');
  return Number(stdout.trim());
}
async function waitForCommit(id: string) {
  return new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      process.off('message', message);
      process.off('disconnect', disconnect);
      resolve(ok);
    };
    const message = (value: unknown) => {
      if (
        value &&
        typeof value === 'object' &&
        'type' in value &&
        'id' in value &&
        value.type === 'commit' &&
        value.id === id
      )
        finish(true);
    };
    const disconnect = () => finish(false);
    const timer = setTimeout(() => finish(false), 5000);
    process.on('message', message);
    process.once('disconnect', disconnect);
    process.send?.({ type: 'ready', id });
  });
}

/** One bounded, explicitly reviewed handoff. Never a persistent supervisor or task replay loop. */
export async function activateService(filename: string) {
  let intent: ActivationIntent | undefined,
    release: (() => void) | null = null,
    effect = false,
    committed = false,
    writable = false;
  const save = async (state: ActivationState, detail: string) => {
    if (!intent || !writable) return;
    intent = { ...intent, state, detail, updatedAt: new Date().toISOString() };
    await writePrivateJson(filename, intent);
  };
  try {
    intent = await readActivation(filename);
    const submitted = intent.definition;
    assert(
      process.connected &&
        process.ppid === intent.parentPid &&
        (await actualParent()) === intent.parentPid,
      409,
      'Background activation requires its original foreground process and private IPC.',
    );
    assert(
      filename === activationPath(submitted.dataDirectory, intent.review.id) &&
        intent.state === 'submitted',
      409,
      'The background handoff is not a new reviewed request.',
    );
    writable = true;
    const c = serviceContext({ agentDirectory: submitted.agentDirectory });
    const checked = await verifyServiceDefinition(submitted, c);
    const r = checked;
    intent.definition = checked;
    const review = intent.review;
    assert(
      review.installationId === checked.id &&
        review.dataDirectory === checked.dataDirectory &&
        review.executable === checked.node &&
        review.runner === checked.runner &&
        review.definition === join(checked.agentDirectory, `${checked.label}.plist`) &&
        review.port === checked.port &&
        review.phonePort === (checked.phone?.port ?? null) &&
        review.phoneOrigin === (checked.phone?.origin ?? null) &&
        JSON.stringify(review.phoneUsers) === JSON.stringify(checked.phone?.users ?? []) &&
        JSON.stringify(review.environment) === JSON.stringify(checked.environment),
      409,
      'The reviewed background service definition changed.',
    );
    const fresh = () =>
      assert(
        Date.now() < Date.parse(review.expiresAt),
        409,
        'The background handoff review expired.',
      );
    fresh();
    release = await activationLease(r.dataDirectory, true);
    assert(release, 409, 'Another background handoff still owns this workspace.');
    if (!(await waitForCommit(review.id))) {
      await save(
        'aborted',
        'The foreground process did not commit this handoff. No native service action was taken.',
      );
      return;
    }
    fresh();
    committed = true;
    await save(
      'committed',
      'The reviewed handoff was committed. Waiting for the foreground process to release this workspace.',
    );
    await new Promise<void>((resolve, reject) =>
      process.send?.({ type: 'committed', id: review.id }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    await save(
      'waiting',
      'Waiting for the original foreground process and its SQLite ownership to exit.',
    );
    const deadline = Math.min(Date.now() + 60000, Date.parse(review.expiresAt));
    let idle = false;
    while (Date.now() < deadline) {
      if ((await actualParent()) !== intent.parentPid && workspaceAvailable(r.dataDirectory)) {
        idle = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(
      idle,
      409,
      'The foreground process did not release this workspace before the handoff deadline.',
    );
    fresh();
    const existing = await installedServiceDefinition(r.dataDirectory, c);
    if (review.action === 'install-and-start') {
      assert(!existing, 409, 'A native service installation appeared after review.');
      fresh();
      effect = true;
      await save('installing', 'Installing the exact reviewed native user-service definition.');
      await installService(
        {
          dataDirectory: r.dataDirectory,
          port: r.port,
          phone: r.phone,
          environment: r.environment,
        },
        c,
        checked,
      );
    } else
      assert(
        existing?.configurationHash === r.configurationHash,
        409,
        'The existing service installation changed after review.',
      );
    assert(
      !(await serviceDefinitionLoaded(r, c)),
      409,
      'A native service owner appeared after review.',
    );
    fresh();
    effect = true;
    await save(
      'starting',
      'Starting the exact native service. Saved work is never automatically replayed.',
    );
    const status = await controlService('start', r.dataDirectory, c);
    await save(
      status.state === 'running' ? 'running' : 'uncertain',
      status.state === 'running'
        ? 'Native service identity and health agree. This workspace is available in the background.'
        : 'Native startup was submitted, but matching health was not confirmed. Review native service status; this request will not replay.',
    );
  } catch {
    await save(
      effect || committed ? 'uncertain' : 'failed',
      effect || committed
        ? 'The committed handoff outcome needs review. Check native service status. This request will not replay.'
        : 'The handoff could not be prepared. No native service action was taken.',
    ).catch(() => {});
  } finally {
    release?.();
    if (process.connected) process.disconnect();
  }
}
