import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { ArtifactFingerprint, Run, Work, WorkCapsule } from '../shared/types.js';
import { managedHarnesses } from '../shared/harnesses.js';
import { assert } from './errors.js';
import { ExecutionController } from './execution.js';
import { Store, id, now } from './store.js';

const exec = promisify(execFile);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const capsuleCoverage =
  'Goal, acceptance criteria, project context, all saved user checkpoints, selected file fingerprints, and up to five recent result excerpts. Native conversations remain linked to their original sessions. Native credential stores, live permissions, hidden state and unselected or excluded file contents stay outside the portable data.';

export function contextDigest(store: Store, work: Work) {
  return hash({
    title: work.title,
    goal: work.goal,
    acceptance: work.acceptance,
    context: work.context,
    profileId: work.profileId,
    cwd: work.cwd,
    checkpoints: store
      .checkpoints(work.id)
      .map((e) => ({ id: e.id, note: e.detail, createdAt: e.createdAt })),
  });
}
function protectedPath(path: string) {
  return path
    .split('/')
    .some(
      (part) =>
        ['.git', 'node_modules', '.venv', 'auth.json', 'credentials.json'].includes(part) ||
        /^\.env(?:\.|$)/i.test(part) ||
        /\.(?:pem|key|sqlite(?:-.*)?|db(?:-.*)?|log)$/i.test(part),
    );
}
function localPath(path: string) {
  assert(
    !isAbsolute(path) && !/[\x00-\x1f]/.test(path),
    400,
    'Checkpoint files must use paths relative to the project.',
  );
  const normalized = path.replaceAll('\\', '/');
  assert(
    normalized && normalized.split('/').every((part) => part && part !== '.' && part !== '..'),
    400,
    'Checkpoint paths cannot escape the selected project.',
  );
  return normalized;
}
export async function artifactSnapshot(cwd: string, requested?: string[]) {
  const root = await realpath(cwd).catch(() => null);
  assert(
    root,
    409,
    'The project directory is unavailable. Restore its location before preparing a checkpoint.',
  );
  const inventory: WorkCapsule['inventory'] = requested?.length ? 'explicit' : 'git';
  let paths: string[];
  if (inventory === 'git') {
    const result = await exec(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      { cwd: root, maxBuffer: 2 * 1024 * 1024, timeout: 10000 },
    ).catch(() => null);
    assert(
      result,
      409,
      'This project has no available Git inventory. Select the files to verify, one relative path per line.',
    );
    paths = result.stdout.split('\0').filter(Boolean);
  } else paths = requested!;
  paths = [...new Set(paths.map(localPath))].sort();
  assert(
    paths.length > 0 && paths.length <= MAX_FILES,
    409,
    `Choose between 1 and ${MAX_FILES} checkpoint files. Use a smaller explicit selection for a large project.`,
  );
  const artifacts: ArtifactFingerprint[] = [];
  const excluded: WorkCapsule['excluded'] = [];
  let total = 0;
  for (const path of paths) {
    if (protectedPath(path)) {
      excluded.push({ path, reason: 'Credential, dependency or runtime data' });
      continue;
    }
    const filename = resolve(root, path);
    assert(filename.startsWith(root + sep), 400, 'A checkpoint path escaped the project.');
    const canonical = await realpath(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!canonical) {
      artifacts.push({ path, state: 'missing', sha256: null, bytes: 0, mode: 0 });
      continue;
    }
    assert(
      canonical === filename,
      409,
      `Checkpoint file ${path} uses a symbolic link. Select a regular file within the project.`,
    );
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat({ bigint: true });
      assert(before.isFile(), 409, `Checkpoint path ${path} is not a regular file.`);
      assert(
        before.size <= BigInt(MAX_FILE_BYTES),
        409,
        `Checkpoint file ${path} exceeds the 5 MB limit. Select a smaller set of regular files.`,
      );
      total += Number(before.size);
      assert(
        total <= MAX_TOTAL_BYTES,
        409,
        'This checkpoint exceeds 50 MB of file content. Choose a smaller explicit selection.',
      );
      const sha256 = createHash('sha256')
        .update(await file.readFile())
        .digest('hex');
      const after = await file.stat({ bigint: true });
      assert(
        before.ino === after.ino &&
          before.size === after.size &&
          before.mtimeNs === after.mtimeNs &&
          before.ctimeNs === after.ctimeNs,
        409,
        `Checkpoint file ${path} changed while being read. Prepare the checkpoint again.`,
      );
      artifacts.push({
        path,
        state: 'present',
        sha256,
        bytes: Number(after.size),
        mode: Number(after.mode & 0o7777n),
      });
    } finally {
      await file.close();
    }
  }
  assert(
    artifacts.length > 0,
    409,
    'The selected files only contain excluded data. Choose project artifacts to verify.',
  );
  return {
    inventory,
    artifacts,
    excluded,
    artifactDigest: hash({ inventory, artifacts, excluded }),
  };
}

export class Continuity {
  constructor(
    private store: Store,
    private execution: ExecutionController,
  ) {}
  private source(work: Work) {
    const run = this.store
      .all<Run>('runs')
      .find(
        (r) =>
          r.workId === work.id &&
          r.generation === work.generation &&
          r.accountId === work.accountId,
      );
    if (!run) {
      assert(
        !work.nativeSessionId,
        409,
        'No source exit receipt exists for this native session. Continue through its native client.',
      );
      return null;
    }
    assert(
      run.nativeSessionId === work.nativeSessionId,
      409,
      'The source native session does not match its execution receipt.',
    );
    assert(
      run &&
        run.exitConfirmed &&
        run.endedAt &&
        ['completed', 'failed', 'interrupted'].includes(run.status),
      409,
      'Native worker exit was not confirmed for this binding. Inspect native activity; this work cannot be handed off automatically.',
    );
    return run;
  }
  async capture(workId: string, revision: number, paths?: string[]) {
    return this.execution.atCheckpoint(workId, revision, async (work) => {
      const run = this.source(work);
      const checkpoints = this.store
        .checkpoints(workId)
        .map((e) => ({ id: e.id, note: e.detail, createdAt: e.createdAt }));
      const results = this.store
        .assistantResults(workId)
        .filter((event) => {
          const origin = this.store
            .all<Run>('runs')
            .find(
              (candidate) =>
                candidate.workId === workId && candidate.generation === event.generation,
            );
          return run?.contextReceipt
            ? origin?.contextReceipt?.contentDigest === run.contextReceipt.contentDigest
            : !origin?.contextReceipt;
        })
        .reverse()
        .map((e) => ({
          eventId: e.id,
          excerpt: e.detail.slice(0, 4000),
          clipped: e.detail.length > 4000,
          createdAt: e.createdAt,
        }));
      assert(
        JSON.stringify({
          goal: work.goal,
          acceptance: work.acceptance,
          context: work.context,
          checkpoints,
          results,
        }).length <= 90000,
        409,
        'This portable context is too large. Curate the saved work context before preparing a handoff.',
      );
      const snapshot = await artifactSnapshot(work.cwd, paths);
      return this.store.transaction(() => {
        assert(
          this.store.work(workId).revision === revision && !this.store.work(workId).activeRunId,
          409,
          'The work changed while its checkpoint was prepared. Review and prepare again.',
        );
        const capsule: WorkCapsule = {
          format: 'forge.work-capsule',
          version: 1,
          id: id(),
          workId,
          baseRevision: revision,
          parentCapsuleId: work.capsuleId ?? null,
          generation: work.generation,
          source: {
            harness: work.harness,
            accountId: work.accountId,
            nativeSessionId: work.nativeSessionId,
            runId: run?.id ?? null,
          },
          title: work.title,
          goal: work.goal,
          acceptance: work.acceptance,
          context: work.context,
          checkpoints,
          results,
          ...snapshot,
          contextDigest: contextDigest(this.store, work),
          createdAt: now(),
          coverage: capsuleCoverage,
          ...(run?.contextReceipt ? { contextReceipt: run.contextReceipt } : {}),
        };
        this.store.put('capsules', capsule.id, capsule);
        const updated = this.store.updateWork(workId, { capsuleId: capsule.id });
        this.store.event(
          workId,
          'capsule',
          'Portable checkpoint prepared',
          `${capsule.artifacts.length} selected file states verified. ${capsule.coverage}`,
        );
        return { capsule, work: updated };
      });
    });
  }
  async handoff(
    workId: string,
    revision: number,
    capsuleId: string,
    targetAccountId: string,
    reconciled: boolean,
  ) {
    return this.execution.atCheckpoint(workId, revision, async (work) => {
      const capsule = this.store.get<WorkCapsule>('capsules', capsuleId);
      assert(
        capsule &&
          capsule.workId === workId &&
          work.capsuleId === capsuleId &&
          capsule.baseRevision + 1 === revision &&
          capsule.generation === work.generation &&
          capsule.contextDigest === contextDigest(this.store, work),
        409,
        'This checkpoint is stale. Prepare it again from the current work and files.',
      );
      const run = this.source(work);
      assert(
        !run || reconciled,
        409,
        'Review native activity, detached tools and external effects at this checkpoint before switching.',
      );
      const account = this.store.account(targetAccountId);
      assert(account.id !== work.accountId, 400, 'Choose a different native account or harness.');
      assert(
        managedHarnesses.includes(account.harness) &&
          (account.harness !== 'claude' || account.billingMode === 'api') &&
          (account.harness !== 'opencode' ||
            (Boolean(account.nativeHome) && account.billingMode !== 'subscription')),
        409,
        'This account has no compatible managed execution route. Choose a Codex slot, Claude API slot, or explicit OpenCode native/API profile.',
      );
      const snapshot = await artifactSnapshot(
        work.cwd,
        capsule.inventory === 'explicit'
          ? [...capsule.artifacts.map((a) => a.path), ...capsule.excluded.map((e) => e.path)]
          : undefined,
      );
      assert(
        snapshot.artifactDigest === capsule.artifactDigest,
        409,
        'Project files changed after the checkpoint. Prepare a fresh checkpoint before switching.',
      );
      return this.store.transaction(() => {
        const current = this.store.work(workId);
        const currentAccount = this.store.account(targetAccountId);
        assert(
          currentAccount.harness === account.harness &&
            currentAccount.nativeHome === account.nativeHome &&
            currentAccount.billingMode === account.billingMode &&
            currentAccount.credentialEnv === account.credentialEnv,
          409,
          'The destination account configuration changed during verification. Review the target again.',
        );
        assert(
          current.revision === revision &&
            !current.activeRunId &&
            contextDigest(this.store, current) === capsule.contextDigest,
          409,
          'The work changed while files were checked. Prepare a fresh checkpoint.',
        );
        if (run) this.store.invalidateApprovals(run.id);
        const updated = this.store.updateWork(workId, {
          harness: account.harness,
          accountId: account.id,
          nativeSessionId: null,
          status: 'ready',
          generation: work.generation + 1,
        });
        this.store.event(
          workId,
          'handoff',
          'Work moved to a new native binding',
          `Continue with ${account.label}. ${capsule.artifacts.length} selected file states verified; goals, checkpoints and usage history retained. The original native session remains linked to checkpoint ${capsule.id}.`,
          {
            version: 1,
            capsuleId,
            from: capsule.source,
            to: { harness: account.harness, accountId: account.id },
            fileCount: capsule.artifacts.length,
          },
        );
        return updated;
      });
    });
  }
}
