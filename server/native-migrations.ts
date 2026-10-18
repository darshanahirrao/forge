import { mkdir, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import type { Account, ApprovalActor } from '../shared/types.js';
import type {
  NativeMigration,
  NativeMigrationReview,
  NativeMigrationItem,
} from '../shared/native-migrations.js';
import { Store, id, now } from './store.js';
import { assert, ForgeError } from './errors.js';
import { ExecutionController } from './execution.js';
import { accountBinding } from './adapters/binding.js';
import { acquireProfileLease } from './adapters/profile-lease.js';
import { nativeMigrationBridge, type NativeMigrationBridge } from './adapters/native-migration.js';
import { nativeFileSnapshot } from './native-file-snapshot.js';
import { privateDirectory } from './worker-proof.mjs';

export const nativeMigrationInput = z
  .object({ sourceAccountId: z.string().min(1).max(200), label: z.string().trim().min(1).max(80) })
  .strict();
export const nativeMigrationDecision = z
  .object({
    revision: z.number().int().nonnegative(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    reviewed: z.literal(true),
    reuseCredentialReference: z.boolean().default(false),
    openClawProjectRoot: z.string().trim().min(1).max(2000).refine(isAbsolute).optional(),
  })
  .strict();
interface Stored extends NativeMigration {
  sourceBinding: string;
  sourceRoots: string[];
  items: NativeMigrationItem[];
}

/** Native import into a fresh private profile; activation registers a slot, never a second native scheduler. */
export class NativeMigrations {
  private closing = false;
  private busy = false;
  private done: Promise<unknown> | undefined;
  private abort: AbortController | undefined;
  constructor(
    private store: Store,
    private execution: ExecutionController,
    private directory: string | undefined,
    private admit: () => void | Promise<void>,
    private bridge: NativeMigrationBridge = nativeMigrationBridge,
  ) {
    if (directory) this.directory = realpathSync(directory);
    for (const record of store.db
      .prepare(
        "SELECT data FROM records WHERE collection='native_migrations' AND json_extract(data,'$.state')='preparing'",
      )
      .all()) {
      const row = JSON.parse(String(record.data)) as Stored;
      this.save({
        ...row,
        state: 'failed',
        detail:
          'Preparation ended before a verified native profile was ready. Partial private files were retained; no account or operation was replayed.',
      });
    }
  }
  get isBusy() {
    return this.busy;
  }
  get supported() {
    return Boolean(this.directory && ['darwin', 'linux'].includes(process.platform));
  }
  private save(row: Stored) {
    return this.store.put('native_migrations', row.id, {
      ...row,
      revision: row.revision + 1,
      updatedAt: now(),
    });
  }
  private row(identifier: string) {
    const row = this.store.get<Stored>('native_migrations', identifier);
    assert(row, 404, 'This native profile preparation is unavailable.');
    return row;
  }
  private public(row: Stored): NativeMigration {
    const { sourceBinding: _binding, sourceRoots: _roots, items: _items, ...result } = row;
    return result;
  }
  list() {
    return this.store.db
      .prepare(
        "SELECT json_remove(data,'$.sourceBinding','$.sourceRoots','$.items') AS data FROM records WHERE collection='native_migrations' ORDER BY rowid DESC LIMIT 20",
      )
      .all()
      .map((row) => this.public(JSON.parse(String(row.data))));
  }
  review(identifier: string): NativeMigrationReview {
    const row = this.row(identifier);
    return {
      ...this.public(row),
      items: row.items,
      reportPath: join(row.nativeHome, '..', 'native-report.json'),
    };
  }
  private async checkpoint<T>(body: () => Promise<T>) {
    assert(
      this.supported && !this.busy && !this.closing,
      409,
      'Native profile preparation needs an idle persistent workspace on macOS or Linux.',
    );
    await this.admit();
    assert(!this.busy && !this.closing, 409, 'Wait for the current native profile operation.');
    this.busy = true;
    this.abort = new AbortController();
    const done = this.execution.atWorkspaceCheckpoint('native-profile-import', body);
    this.done = done;
    try {
      return await done;
    } finally {
      this.busy = false;
      this.done = undefined;
      this.abort = undefined;
    }
  }
  private source(row: Stored) {
    const account = this.store.account(row.sourceAccountId);
    assert(
      accountBinding(account) === row.sourceBinding,
      409,
      'The source native account changed. Prepare a fresh native profile.',
    );
    return account;
  }
  private async lease(home: string) {
    return acquireProfileLease(home).catch(() => {
      throw new ForgeError(
        409,
        'Stop and reconcile the original source native owner before preparing or activating this import.',
      );
    });
  }
  private async root(row: Stored) {
    const expected = join(
      this.directory!,
      'native-migrations',
      z.string().uuid().parse(row.id),
      'profile',
    );
    const stat = await lstat(expected);
    assert(
      row.nativeHome === expected &&
        (await realpath(expected)) === expected &&
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (!process.getuid || stat.uid === process.getuid()),
      409,
      'The staged native profile path changed. Keep its private files for review.',
    );
    return expected;
  }
  prepare(value: unknown, actor: ApprovalActor) {
    return this.checkpoint(async () => {
      assert(actor.kind === 'local', 403, 'Review native profile imports on the local Forge host.');
      const input = nativeMigrationInput.parse(value),
        account = this.store.account(input.sourceAccountId);
      assert(
        !account.backend &&
          !account.connector &&
          ['hermes', 'openclaw'].includes(account.harness) &&
          account.nativeHome &&
          isAbsolute(account.nativeHome),
        409,
        'Choose an explicit native Hermes or OpenClaw account.',
      );
      assert(
        (await realpath(account.nativeHome)) === account.nativeHome,
        409,
        'The source native profile path changed.',
      );
      const release = await this.lease(account.nativeHome);
      const identifier = id(),
        operationRoot = join(this.directory!, 'native-migrations', identifier),
        target = join(operationRoot, 'profile');
      let row: Stored = {
        id: identifier,
        revision: 0,
        state: 'preparing',
        sourceAccountId: account.id,
        sourceHarness: account.harness as 'hermes' | 'openclaw',
        targetHarness: account.harness === 'hermes' ? 'openclaw' : 'hermes',
        label: input.label,
        nativeHome: target,
        createdAt: now(),
        updatedAt: now(),
        actor,
        detail:
          'The installed native importer is preparing a separate private profile. No account or scheduler is active.',
        credentialsAvailable: Boolean(account.credentialReference || account.credentialEnv),
        sourceBinding: accountBinding(account),
        sourceRoots: [],
        items: [],
      };
      try {
        this.store.put('native_migrations', row.id, row);
        assert(
          !target.startsWith(account.nativeHome + '/') &&
            !account.nativeHome.startsWith(target + '/'),
          409,
          'Keep the staged native profile separate from the source native home.',
        );
        await mkdir(join(this.directory!, 'native-migrations'), { recursive: true, mode: 0o700 });
        privateDirectory(join(this.directory!, 'native-migrations'));
        await mkdir(operationRoot, { mode: 0o700 });
        await mkdir(target, { mode: 0o700 });
        privateDirectory(operationRoot);
        privateDirectory(target);
        const result = await this.bridge({
          sourceHarness: row.sourceHarness,
          targetHarness: row.targetHarness,
          source: account.nativeHome,
          target,
          operationRoot,
          signal: this.abort!.signal,
        });
        this.source(row);
        await this.root(row);
        assert(
          result.items.length <= 2000 &&
            result.sourceRoots.length <= 6000 &&
            result.sourceRoots.every(isAbsolute),
          409,
          'The native importer exceeded its metadata review contract.',
        );
        const imported = result.items.filter(
            (item) => item.status === 'migrated' && item.kind !== 'archive',
          ).length,
          archived = result.items.filter(
            (item) =>
              item.status === 'archived' || (item.kind === 'archive' && item.status === 'migrated'),
          ).length,
          skipped = result.items.filter((item) => item.status === 'skipped').length,
          overflowed = result.items.reduce((sum, item) => sum + item.overflowedEntries, 0);
        assert(
          imported > 0,
          409,
          'The native importer did not import any compatible profile items.',
        );
        const files = await nativeFileSnapshot([operationRoot], true);
        this.abort!.signal.throwIfAborted();
        row = this.save({
          ...row,
          state: 'ready',
          nativeVersion: result.nativeVersion,
          sourceDigest: result.sourceDigest,
          sourceRoots: result.sourceRoots,
          items: result.items,
          digest: files.digest,
          files: files.files,
          bytes: files.bytes,
          summary: { imported, archived, skipped, overflowed },
          detail:
            'The native profile is ready for local review. Archived items and memory overflow remain explicit. Credentials, jobs and channels are not activated.',
        });
        return this.review(row.id);
      } catch (error) {
        const reason =
          error instanceof ForgeError
            ? error.message
            : 'The native utility or its file evidence could not be verified.';
        this.save({
          ...row,
          state: 'failed',
          detail:
            reason +
            ' Any private partial files were retained. No account was activated; inspect the private native report and prepare again explicitly.',
        });
        return this.review(row.id);
      } finally {
        release();
      }
    });
  }
  activate(identifier: string, value: unknown, actor: ApprovalActor) {
    return this.checkpoint(async () => {
      assert(actor.kind === 'local', 403, 'Review native profile imports on the local Forge host.');
      const input = nativeMigrationDecision.parse(value),
        row = this.row(identifier);
      if (row.state === 'activated') {
        assert(
          row.digest === input.digest &&
            row.reviewedProjectRoot === input.openClawProjectRoot &&
            row.reusedCredentialReference === input.reuseCredentialReference,
          409,
          'The native profile review or credential choice changed.',
        );
        return this.store.account(row.accountId!);
      }
      assert(
        row.state === 'ready' && row.revision === input.revision && row.digest === input.digest,
        409,
        'The native profile changed. Read its current preparation before activation.',
      );
      const source = this.source(row),
        home = await this.root(row),
        release = await this.lease(source.nativeHome);
      try {
        if (input.openClawProjectRoot) {
          assert(
            row.targetHarness === 'openclaw',
            409,
            'Native project access applies only to a dedicated OpenClaw Gateway.',
          );
          const project = await lstat(input.openClawProjectRoot);
          assert(
            project.isDirectory() &&
              !project.isSymbolicLink() &&
              (await realpath(input.openClawProjectRoot)) === input.openClawProjectRoot,
            409,
            'Choose an existing canonical project directory for native OpenClaw access.',
          );
        }
        assert(
          !input.reuseCredentialReference || row.credentialsAvailable,
          409,
          'This source has no provider credential reference to reuse.',
        );
        const original = await nativeFileSnapshot(row.sourceRoots),
          staged = await nativeFileSnapshot([join(home, '..')]);
        this.abort!.signal.throwIfAborted();
        assert(
          original.digest === row.sourceDigest && staged.digest === row.digest,
          409,
          'Source or staged native files changed after preparation. Prepare a fresh copy before activation.',
        );
        this.source(row);
        assert(
          !this.store.all<Account>('accounts').some((account) => account.nativeHome === home),
          409,
          'This private native profile is already referenced by an account.',
        );
        const account: Account = {
          id: id(),
          label: row.label,
          harness: row.targetHarness,
          nativeHome: home,
          ...(input.openClawProjectRoot ? { openClawProjectRoot: input.openClawProjectRoot } : {}),
          billingMode: source.billingMode,
          state: 'configured',
          identity: null,
          identityKey: null,
          plan: null,
          checkedAt: null,
          error: null,
          quotas: [],
          createdAt: now(),
          ...(input.reuseCredentialReference && (source.credentialReference || source.credentialEnv)
            ? {
                ...(source.credentialReference
                  ? { credentialReference: source.credentialReference }
                  : {}),
                ...(source.credentialEnv ? { credentialEnv: source.credentialEnv } : {}),
              }
            : {}),
        };
        this.store.transaction(() => {
          this.store.put('accounts', account.id, account);
          this.save({
            ...row,
            state: 'activated',
            accountId: account.id,
            acceptedBy: actor,
            reusedCredentialReference: input.reuseCredentialReference,
            ...(input.openClawProjectRoot
              ? { reviewedProjectRoot: input.openClawProjectRoot }
              : {}),
            detail:
              'The reviewed native profile is registered. Check its native provider credentials before use. Existing work/profile handoff retains native launch reviews; schedules and channels need separate setup.',
          });
        });
        return account;
      } finally {
        release();
      }
    });
  }
  dismiss(identifier: string, revision: number) {
    return this.checkpoint(async () => {
      const row = this.row(identifier);
      assert(
        row.state !== 'activated' && row.state !== 'preparing' && row.revision === revision,
        409,
        'Only an inactive, current native preparation can be dismissed.',
      );
      return this.public(
        this.save({
          ...row,
          state: 'dismissed',
          detail:
            'Preparation dismissed. Private files are retained for native review and do not have an account or automatic cleanup authority.',
        }),
      );
    });
  }
  async close() {
    this.closing = true;
    this.abort?.abort();
    await this.done?.catch(() => {});
  }
}
