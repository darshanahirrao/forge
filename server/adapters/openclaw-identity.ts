import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { open, writeFile, realpath } from 'node:fs/promises';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { WorkerProofDescriptor } from '../../shared/recovery.js';
import { assert } from '../errors.js';
import { readWorkerExit, scopeHash } from '../worker-proof.mjs';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const deviceSchema = z.object({
  deviceId: hash,
  publicKeyPem: z.string().max(2048),
  privateKeyPem: z.string().max(4096),
});
const descriptorSchema = z.object({
  id: z.string().uuid(),
  scope: z.record(z.string(), z.unknown()),
  scopeHash: hash,
  directory: z.string().max(4096).refine(isAbsolute),
  publicKey: z.string().min(16).max(2048),
  guardianPid: z.number().int().min(2),
});
const identitySchema = z.object({
  version: z.literal(2),
  cleanExit: z.boolean(),
  device: deviceSchema,
  attemptId: z.string().uuid().optional(),
  closure: z
    .object({
      attemptId: z.string().uuid(),
      root: z.string().max(4096).refine(isAbsolute),
      deviceId: hash,
      descriptor: descriptorSchema,
    })
    .optional(),
});
export type OpenClawIdentity = z.infer<typeof identitySchema>;
const identityPath = (root: string) => join(root, '.forge-openclaw.json');
const unconfirmed =
  'This OpenClaw profile has an unconfirmed native exit. Keep its ownership marker and review exact original closure; legacy or missing evidence cannot be reset automatically.';

export function rawPublicKey(pem: string) {
  const key = createPublicKey(pem);
  assert(key.asymmetricKeyType === 'ed25519', 409, 'Invalid Forge OpenClaw device key.');
  const raw = key.export({ format: 'jwk' }).x;
  assert(raw, 409, 'Invalid Forge OpenClaw public key.');
  return raw;
}
export function newOpenClawIdentity(): OpenClawIdentity {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = createHash('sha256')
    .update(Buffer.from(rawPublicKey(publicKeyPem), 'base64url'))
    .digest('hex');
  return { version: 2, cleanExit: true, device: { deviceId, publicKeyPem, privateKeyPem } };
}
function validateDevice(identity: OpenClawIdentity) {
  const raw = rawPublicKey(identity.device.publicKeyPem);
  assert(
    rawPublicKey(identity.device.privateKeyPem) === raw &&
      createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('hex') ===
        identity.device.deviceId,
    409,
    'The Forge OpenClaw device identity does not match its key pair.',
  );
}
async function privateRead(filename: string) {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    assert(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.size < 16384 &&
        (stat.mode & 0o077) === 0 &&
        (!process.getuid || stat.uid === process.getuid()),
      409,
      'Forge OpenClaw identity must be a private regular file.',
    );
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
/** Only this attempt's captured signing identity can retire an SDK marker after parent loss. */
export async function readOpenClawIdentity(root: string): Promise<OpenClawIdentity | null> {
  const filename = identityPath(root);
  const raw = await privateRead(filename).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return null;
  const value = JSON.parse(raw);
  let identity: OpenClawIdentity;
  if (value.version === 1) {
    const legacy = z
      .object({ version: z.literal(1), cleanExit: z.boolean(), device: deviceSchema })
      .parse(value);
    assert(legacy.cleanExit, 409, unconfirmed);
    identity = { ...legacy, version: 2 };
    validateDevice(identity);
    // Preserve the prior private format before the first version-2 write.
    const backup = `${filename}.before-v2`;
    await writeFile(backup, raw, { flag: 'wx', mode: 0o600, flush: true }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
      assert(
        (await privateRead(backup)) === raw,
        409,
        'The OpenClaw identity rollback copy differs. Keep both files for review.',
      );
    });
  } else identity = identitySchema.parse(value);
  validateDevice(identity);
  if (!identity.cleanExit) {
    const closure = identity.closure;
    assert(
      closure &&
        closure.attemptId === identity.attemptId &&
        closure.root === (await realpath(root)) &&
        closure.deviceId === identity.device.deviceId,
      409,
      unconfirmed,
    );
    assert(closure.descriptor.scopeHash === scopeHash(closure.descriptor.scope), 409, unconfirmed);
    try {
      readWorkerExit(closure.descriptor);
    } catch {
      assert(false, 409, unconfirmed);
    }
    // This changes no canonical run, outcome, approval or spending reservation.
    identity.cleanExit = true;
    saveOpenClawIdentity(root, identity);
  }
  return identity;
}
/** Atomic private replacement, with the file and containing directory durable before native launch. */
export function saveOpenClawIdentity(root: string, identity: OpenClawIdentity) {
  const filename = identityPath(root),
    temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(identity));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, filename);
    const directory = openSync(root, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function armOpenClawIdentity(
  root: string,
  identity: OpenClawIdentity,
  descriptor: WorkerProofDescriptor<object>,
) {
  assert(!identity.cleanExit && identity.attemptId && !identity.closure, 409, unconfirmed);
  const captured = descriptorSchema.parse(descriptor);
  assert(captured.scopeHash === scopeHash(captured.scope), 409, unconfirmed);
  identity.closure = {
    attemptId: identity.attemptId,
    root: realpathSync(root),
    deviceId: identity.device.deviceId,
    descriptor: captured,
  };
  saveOpenClawIdentity(root, identity);
}
/** Expose no private identity content through normal status or work snapshots. */
export async function createOpenClawIdentity(root: string, identity: OpenClawIdentity) {
  await writeFile(identityPath(root), JSON.stringify(identity), {
    mode: 0o600,
    flag: 'wx',
    flush: true,
  });
}
