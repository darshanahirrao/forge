import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { NativeRuntimeProvider } from '../shared/extensions.js';
import type { CompanionProviderDefinition } from './companion-providers.js';
import { extensionPaths } from './extension-config.js';
import { assert } from './errors.js';

export interface ForgeExtension {
  format: 'forge.extension';
  version: 1;
  id: string;
  name: string;
  release: string;
  companions: (CompanionProviderDefinition & { id: string; name: string })[];
}
export interface LoadedExtensions {
  providers: Record<string, CompanionProviderDefinition>;
  runtimes: readonly NativeRuntimeProvider[];
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (max: number) => z.string().trim().min(1).max(max);
const definitionSchema = z
  .object({
    contract: z.literal(1),
    id: z.string().regex(/^ext\.[a-z][a-z0-9.-]{1,75}$/),
    name: text(80),
    nativeVersion: text(80),
    profileFiles: z
      .array(
        z
          .string()
          .max(200)
          .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
          .refine((path) => !path.split('/').some((part) => part === '..' || part === '.')),
      )
      .min(1)
      .max(16),
    connect: z.custom<CompanionProviderDefinition['connect']>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();
const extensionSchema = z
  .object({
    format: z.literal('forge.extension'),
    version: z.literal(1),
    id: text(100).regex(/^[a-z][a-z0-9.-]+$/),
    name: text(80),
    release: text(80),
    companions: z.array(definitionSchema).min(1).max(16),
  })
  .strict();

async function entrySnapshot(path: string) {
  const canonical = await realpath(path);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    assert(
      before.isFile() &&
        before.size <= 1024 * 1024 &&
        before.nlink === 1 &&
        (process.platform === 'win32' ||
          (before.uid === process.getuid?.() && (before.mode & 0o022) === 0)),
      409,
      'Use an owned regular extension module without group/world write access, at most 1 MiB.',
    );
    const buffer = Buffer.alloc(1024 * 1024 + 1),
      result = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    assert(
      result.bytesRead === before.size &&
        before.ino === after.ino &&
        before.mtimeMs === after.mtimeMs &&
        before.size === after.size &&
        (await realpath(path)) === canonical,
      409,
      'The extension entry changed while loading. Restart with a stable installed module.',
    );
    return {
      path: canonical,
      digest: createHash('sha256').update(buffer.subarray(0, result.bytesRead)).digest('hex'),
    };
  } finally {
    await file.close();
  }
}

/** Explicit trusted local Node modules, loaded once at startup. No browser-uploaded code or auto-discovery. */
export async function loadExtensions(paths: readonly string[] = []): Promise<LoadedExtensions> {
  const selected = extensionPaths(JSON.stringify(paths));
  const providers: LoadedExtensions['providers'] = Object.create(null),
    runtimes: NativeRuntimeProvider[] = [];
  const ids = new Set<string>(),
    entries = new Set<string>();
  for (const path of selected) {
    const entry = await entrySnapshot(path);
    assert(!entries.has(entry.path), 409, 'An extension entry was configured more than once.');
    entries.add(entry.path);
    let exported: unknown;
    let timer: NodeJS.Timeout | undefined;
    try {
      exported = (
        await Promise.race([
          import(pathToFileURL(entry.path).href + '?forge=' + entry.digest),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Extension initialization deadline exceeded.')),
              10000,
            );
          }),
        ])
      ).default;
    } catch {
      assert(
        false,
        409,
        'A local extension module did not initialize within its supported startup deadline. Check its installation and dependencies.',
      );
    } finally {
      clearTimeout(timer);
    }
    const definition = extensionSchema.parse(exported);
    assert(!ids.has(definition.id), 409, 'Extension IDs must be unique across startup modules.');
    ids.add(definition.id);
    assert(
      (await entrySnapshot(path)).digest === entry.digest,
      409,
      'The extension entry changed during module initialization. Restart before using its providers.',
    );
    for (const provider of definition.companions) {
      assert(
        !Object.hasOwn(providers, provider.id),
        409,
        'Native runtime provider IDs must be unique.',
      );
      const metadata: NativeRuntimeProvider = Object.freeze({
        id: provider.id,
        name: provider.name,
        nativeVersion: provider.nativeVersion,
        extensionId: definition.id,
        extensionName: definition.name,
        extensionVersion: definition.release,
        digest: hash([
          definition.id,
          definition.release,
          entry.digest,
          provider.id,
          provider.nativeVersion,
          provider.profileFiles,
        ]),
      });
      runtimes.push(metadata);
      providers[provider.id] = Object.freeze({
        contract: 1,
        nativeVersion: provider.nativeVersion,
        profileFiles: Object.freeze([...provider.profileFiles]),
        connect: provider.connect,
        extension: metadata,
      });
    }
  }
  return { providers: Object.freeze(providers), runtimes: Object.freeze(runtimes) };
}

export function defineExtension<T extends ForgeExtension>(extension: T): T {
  return extension;
}
