import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { release } from 'node:os';
import { constants, lstatSync, openSync, readFileSync, closeSync, fstatSync } from 'node:fs';
import { z } from 'zod';
import type { Account, ApprovalActor } from '../shared/types.js';
import type {
  NativeResourceBackend,
  NativeResourcePolicy,
  NativeResourceReceipt,
  NativeResourceSnapshot,
} from '../shared/resource-governance.js';
import { Store, now } from './store.js';
import { assert } from './errors.js';

const exec = promisify(execFile);
const binary = '/usr/sbin/taskpolicy';
const key = 'native-resource-policy';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const memory = z.number().int().min(64).max(65536).nullable();
export const resourceConfiguration = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    lowPriority: z.boolean(),
    rootMemoryMiB: memory,
    effectsReviewed: z.literal(true),
  })
  .strict();
const receiptSchema = z
  .object({
    contract: z.literal('forge.native-resources/1'),
    policyRevision: z.number().int().positive(),
    lowPriority: z.boolean(),
    rootMemoryMiB: memory,
    backend: z
      .object({
        kind: z.literal('macos-taskpolicy'),
        priority: z.literal('utility-qos'),
        release: z.string().regex(/^27\.[0-9.]+$/),
        binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
let cached: { identity: string; backend: NativeResourceBackend } | undefined;

/** Read-only native capability binding; no process or watchdog is started. */
function backend(): NativeResourceBackend | null {
  if (process.platform !== 'darwin' || release().split('.')[0] !== '27') return null;
  try {
    const info = lstatSync(binary);
    assert(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.uid === 0 &&
        !(info.mode & 0o022) &&
        info.size <= 1024 * 1024,
      409,
      'The native resource-policy binary is unavailable.',
    );
    const identity = `${release()}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    if (cached?.identity === identity) return cached.backend;
    const fd = openSync(binary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      assert(
        opened.ino === info.ino && opened.dev === info.dev && opened.size === info.size,
        409,
        'The native resource-policy binary changed.',
      );
      const data = readFileSync(fd);
      const after = fstatSync(fd);
      assert(
        data.length === info.size && after.mtimeMs === info.mtimeMs,
        409,
        'The native resource-policy binary changed.',
      );
      const value: NativeResourceBackend = {
        kind: 'macos-taskpolicy',
        priority: 'utility-qos',
        release: release(),
        binarySha256: createHash('sha256').update(data).digest('hex'),
      };
      cached = { identity, backend: value };
      return value;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
export function validateResourceReceipt(value: NativeResourceReceipt) {
  const receipt = receiptSchema.parse(value);
  const { digest, ...body } = receipt;
  assert(
    (receipt.lowPriority || receipt.rootMemoryMiB !== null) && hash(body) === digest,
    409,
    'The native resource-policy receipt changed.',
  );
  return receipt;
}
/** Preserve original PID/stdin/stdout through native SETEXEC, leaving the signing owner uncapped. */
export function resourceCommand(
  receipt: NativeResourceReceipt | undefined,
  command: string,
  args: readonly string[],
) {
  if (!receipt) return { command, args };
  const value = validateResourceReceipt(receipt);
  assert(
    hash(backend()) === hash(value.backend),
    409,
    'Native resource support changed after review. Review Resources again.',
  );
  return {
    command: binary,
    args: [
      ...(value.lowPriority ? ['-c', 'utility'] : []),
      ...(value.rootMemoryMiB === null ? [] : ['-m', String(value.rootMemoryMiB)]),
      command,
      ...args,
    ],
  };
}

export class ResourceGovernance {
  private tasks = new Set<Promise<unknown>>();
  private closing = false;
  constructor(
    private store: Store,
    private persistent: boolean,
    private mayConfigure: () => boolean = () => true,
  ) {}
  policy(): NativeResourcePolicy {
    return (
      this.store.get<NativeResourcePolicy>('config', key) ?? {
        revision: 0,
        lowPriority: false,
        rootMemoryMiB: null,
        hostBinding: null,
        changedAt: null,
      }
    );
  }
  private active(
    policy: Pick<NativeResourcePolicy, 'lowPriority' | 'rootMemoryMiB'> = this.policy(),
  ) {
    return policy.lowPriority || policy.rootMemoryMiB !== null;
  }
  snapshot(): NativeResourceSnapshot {
    const current = backend(),
      policy = this.policy();
    const supported = this.persistent && current !== null;
    const reviewNeeded =
      this.active(policy) && (!supported || policy.hostBinding !== hash(current));
    return {
      supported,
      policy,
      reviewNeeded,
      detail: reviewNeeded
        ? 'Native resource support changed. Review the policy on this host before launching.'
        : supported
          ? 'Native utility scheduling and original-process memory limits are available on this evaluated macOS release.'
          : 'Native process limits require a persistent workspace on the evaluated Darwin 27 host. Existing pressure protection and quiet mode remain available.',
    };
  }
  configure(value: unknown, actor: ApprovalActor) {
    assert(!this.closing, 409, 'The workspace is closing.');
    assert(
      this.mayConfigure(),
      409,
      'Wait for native startup to finish before changing resource policy.',
    );
    const task = this.configurePolicy(value, actor);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  private async configurePolicy(value: unknown, actor: ApprovalActor) {
    const input = resourceConfiguration.parse(value),
      previous = this.policy();
    assert(
      input.expectedRevision === previous.revision,
      409,
      'Native resource policy changed. Review the current policy.',
    );
    const current = backend();
    if (input.lowPriority || input.rootMemoryMiB !== null) {
      assert(
        this.persistent && current,
        409,
        'Native resource limits are unavailable on this host.',
      );
      // Exercise only a finite native no-op. No model, account or service is invoked.
      await exec(
        binary,
        [
          ...(input.lowPriority ? ['-c', 'utility'] : []),
          ...(input.rootMemoryMiB === null ? [] : ['-m', String(input.rootMemoryMiB)]),
          '/usr/bin/true',
        ],
        { timeout: 1500, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin:/usr/sbin' } },
      );
      assert(
        hash(backend()) === hash(current),
        409,
        'Native resource support changed during review.',
      );
    }
    assert(
      !this.closing && this.mayConfigure() && this.policy().revision === previous.revision,
      409,
      'Native resource policy changed during review or the workspace is closing.',
    );
    const policy: NativeResourcePolicy = {
      revision: previous.revision + 1,
      lowPriority: input.lowPriority,
      rootMemoryMiB: input.rootMemoryMiB,
      hostBinding: this.active(input) ? hash(current) : null,
      changedAt: now(),
      actor,
    };
    this.store.put('config', key, policy);
    return this.snapshot();
  }
  review(): NativeResourceReceipt | undefined {
    assert(!this.closing, 409, 'The workspace is closing.');
    const policy = this.policy();
    if (!this.active(policy)) return undefined;
    const current = backend();
    assert(
      this.persistent && current && policy.hostBinding === hash(current),
      409,
      'Review native resource policy on this host in Resources before launching.',
    );
    const body = {
      contract: 'forge.native-resources/1' as const,
      policyRevision: policy.revision,
      lowPriority: policy.lowPriority,
      rootMemoryMiB: policy.rootMemoryMiB,
      backend: structuredClone(current),
    };
    return { ...body, digest: hash(body) };
  }
  assertCurrent(receipt?: NativeResourceReceipt, account?: Account) {
    if (receipt) validateResourceReceipt(receipt);
    assert(
      this.review()?.digest === receipt?.digest,
      409,
      'Native resource policy changed after launch review. Review the current context.',
    );
    assert(
      !receipt || !account?.backend,
      409,
      'The selected delegated backend owns its resource policy. Choose native defaults or a locally owned native account.',
    );
  }
  async close() {
    this.closing = true;
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }
}
