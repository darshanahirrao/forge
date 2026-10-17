import { execFile } from 'node:child_process';
import { promisify, inspect } from 'node:util';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Account } from '../shared/types.js';
import { assert, ForgeError } from './errors.js';
import { readPrivateJson } from './private-json.js';
import { accountBinding } from './adapters/binding.js';

const exec = promisify(execFile);
const absolute = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(isAbsolute, 'Use an absolute native path.');
const item = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._:@/+\-]*$/);
export const credentialReferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('private-json'),
      path: absolute,
      key: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('macos-keychain'),
      service: item,
      account: item,
      keychain: absolute.optional(),
    })
    .strict(),
]);

export function credentialTarget(account: Account) {
  assert(
    account.harness !== 'claude' || account.billingMode === 'api',
    409,
    'Claude private references require an API slot. Keep subscription authentication in its native client.',
  );
  const target =
    account.credentialEnv ||
    (account.harness === 'claude' && account.billingMode === 'api' ? 'ANTHROPIC_API_KEY' : '');
  assert(
    target &&
      /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(target) &&
      !/^(PATH$|HOME$|USER$|SHELL$|XDG_|NODE_|PYTHON|LD_|DYLD_|CODEX_|CLAUDE_|OPENCODE_|OPENCLAW_|HERMES_|FORGE_|TMP|TEMP|SystemRoot|COMSPEC|PATHEXT|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$|SSL_)/i.test(
        target,
      ),
    409,
    'Choose a provider credential variable rather than a runtime, proxy or workspace setting.',
  );
  return target;
}

/** A per-account, per-invocation value. It is never part of canonical or exported state. */
export class CredentialMaterial {
  #value: string | null;
  #binding: string;
  #accountId: string;
  #target: string;
  constructor(account: Account, value: string) {
    this.#binding = accountBinding(account);
    this.#accountId = account.id;
    this.#target = credentialTarget(account);
    this.#value = value;
  }
  read(account: Account, target: string) {
    assert(
      this.#value !== null &&
        account.id === this.#accountId &&
        accountBinding(account) === this.#binding &&
        target === this.#target,
      409,
      'The private credential no longer matches this native account binding. Review it again.',
    );
    return this.#value;
  }
  dispose() {
    this.#value = null;
  }
  toJSON() {
    return undefined;
  }
  [inspect.custom]() {
    return '[Private native credential]';
  }
}

export function credentialValue(account: Account, target: string, material?: CredentialMaterial) {
  if (!account.credentialReference) return process.env[target];
  assert(
    material,
    409,
    'Resolve the selected private credential reference before native execution.',
  );
  return material.read(account, target);
}

export async function resolveCredential(account: Account): Promise<CredentialMaterial | undefined> {
  if (!account.credentialReference) return undefined;
  assert(!account.backend, 409, 'Delegated backend credentials remain in the native backend.');
  credentialTarget(account);
  const reference = credentialReferenceSchema.parse(account.credentialReference);
  try {
    let value: unknown;
    if (reference.kind === 'private-json') {
      const data = await readPrivateJson(reference.path);
      assert(
        data !== null &&
          typeof data === 'object' &&
          !Array.isArray(data) &&
          Object.hasOwn(data, reference.key),
        409,
        'The selected private credential key was not found.',
      );
      value = (data as Record<string, unknown>)[reference.key];
    } else {
      assert(
        process.platform === 'darwin',
        409,
        'This reference requires macOS Keychain. Choose a supported local reference for this host.',
      );
      const result = await exec(
        '/usr/bin/security',
        [
          'find-generic-password',
          '-s',
          reference.service,
          '-a',
          reference.account,
          '-w',
          ...(reference.keychain ? [reference.keychain] : []),
        ],
        {
          timeout: 5000,
          maxBuffer: 32768,
          env: {
            PATH: '/usr/bin:/bin',
            LANG: 'C',
            ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
          },
        },
      );
      value = result.stdout.replace(/\r?\n$/, '');
    }
    assert(
      typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 16384 &&
        /^[\x21-\x7e]+$/.test(value),
      409,
      'The reference must contain one nonempty provider credential without whitespace or control characters.',
    );
    return new CredentialMaterial(account, value);
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      409,
      'The selected private credential is unavailable. Check its native file or unlock and authorize the Keychain item, then retry explicitly.',
    );
  }
}
