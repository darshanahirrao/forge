import type { Account, Approval, Usage, Work, Run } from '../shared/types.js';
import { Store, id, now } from './store.js';
import { requestDigest } from './adapters/sources.js';

export function seedDemo(store: Store) {
  const stamp = now();
  const accounts: Account[] = [
    {
      id: 'demo-codex',
      label: 'Codex personal',
      harness: 'codex',
      nativeHome: '',
      billingMode: 'subscription',
      state: 'verified',
      identity: 'personal@example.invalid',
      identityKey: 'example-codex',
      plan: 'Example subscription',
      checkedAt: stamp,
      error: null,
      quotas: [
        {
          label: '5 hour window',
          usedPercent: 32,
          resetsAt: new Date(Date.now() + 130 * 60 * 1000).toISOString(),
          scope: 'example-codex:primary',
          source: 'example',
          observedAt: stamp,
        },
      ],
      createdAt: stamp,
    },
    {
      id: 'demo-claude',
      label: 'Claude studio',
      harness: 'claude',
      nativeHome: '',
      billingMode: 'subscription',
      state: 'verified',
      identity: 'studio@example.invalid',
      identityKey: 'example-claude',
      plan: 'Example subscription',
      checkedAt: stamp,
      error: null,
      quotas: [
        {
          label: '5 hour window',
          usedPercent: 76,
          resetsAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
          scope: 'example-claude:primary',
          source: 'example',
          observedAt: stamp,
        },
      ],
      createdAt: stamp,
    },
    {
      id: 'demo-codex-backup',
      label: 'Codex research',
      harness: 'codex',
      nativeHome: '',
      billingMode: 'subscription',
      state: 'configured',
      identity: null,
      identityKey: null,
      plan: null,
      checkedAt: null,
      error: null,
      quotas: [],
      createdAt: stamp,
    },
  ];
  accounts.forEach((a) => store.put('accounts', a.id, a));
  const examples: Partial<Work>[] = [
    {
      id: 'demo-design',
      title: 'Make the workspace feel effortless',
      project: 'Forge',
      harness: 'codex',
      accountId: 'demo-codex',
      status: 'waiting',
      goal: 'Refine the first-run experience and review its accessibility.',
      context:
        'Keep native capabilities in their own harness. The dashboard should explain what needs attention before showing details.',
      acceptance:
        'Keyboard navigation works. Both themes remain readable. No horizontal overflow on mobile.',
    },
    {
      id: 'demo-api',
      title: 'Verify the account handoff contract',
      project: 'Continuity',
      harness: 'claude',
      accountId: 'demo-claude',
      status: 'ready',
      goal: 'Review compatibility and identify any context that cannot transfer.',
      context:
        'Preserve the work record and native evidence. Separate native resume from a new continuation package.',
      acceptance: 'Every unsupported capability is named before a switch.',
    },
    {
      id: 'demo-memory',
      title: 'Connect the project memory sources',
      project: 'Personal workspace',
      harness: 'hermes',
      accountId: null,
      status: 'ready',
      goal: 'Identify user-owned memory sources and record their scope.',
      context:
        'Use existing memory providers. Keep credentials and unrelated project material out of shared context.',
      acceptance: 'Source ownership, correction, and deletion remain with the existing provider.',
    },
    {
      id: 'demo-ledger',
      title: 'Keep every token accountable',
      project: 'Forge',
      harness: 'codex',
      accountId: 'demo-codex',
      status: 'completed',
      goal: 'Check usage counter deduplication across repeated reports.',
      context:
        'Cumulative counters replace snapshots. Estimates are separate from confirmed charges.',
      acceptance: 'Replayed usage events do not inflate totals.',
    },
  ];
  examples.forEach((w, index) => {
    const work: Work = {
      id: w.id!,
      title: w.title!,
      project: w.project!,
      cwd: '',
      goal: w.goal!,
      context: w.context!,
      acceptance: w.acceptance!,
      harness: w.harness!,
      accountId: w.accountId ?? null,
      status: w.status!,
      priority: index === 0 ? 'high' : 'normal',
      generation: index === 0 ? 1 : 0,
      revision: 0,
      nativeSessionId: null,
      activeRunId: null,
      createdAt: new Date(Date.now() - (index + 1) * 3600000).toISOString(),
      updatedAt: stamp,
    };
    store.put('work', work.id, work);
    store.event(
      work.id,
      'checkpoint',
      index === 3 ? 'Usage replay checks passed' : 'Context ready to continue',
      index === 3
        ? 'Fictional result: repeated cumulative reports leave the same total.'
        : 'Fictional work record. No native process is running for this example.',
    );
  });
  const approval: Approval = {
    id: 'demo-approval',
    workId: 'demo-design',
    runId: 'demo-run',
    generation: 1,
    nativeRequestId: 71,
    method: 'item/commandExecution/requestApproval',
    digest: requestDigest('example', {}, 'demo-run', 1),
    title: 'Review the accessibility check',
    detail: 'Example approval. This decision changes only the isolated demo workspace.',
    command: 'npm run test:a11y',
    cwd: 'example-project',
    status: 'pending',
    createdAt: stamp,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    resolvedAt: null,
  };
  store.put('approvals', approval.id, approval);
  const usage: Usage[] = [
    {
      key: id(),
      workId: 'demo-ledger',
      accountId: 'demo-codex',
      harness: 'codex',
      source: 'example',
      scope: 'Fictional example',
      inputTokens: 82000,
      outputTokens: 12500,
      cachedTokens: 44000,
      totalTokens: 94500,
      estimatedUsd: 2.84,
      observedAt: stamp,
    },
    {
      key: id(),
      workId: 'demo-api',
      accountId: 'demo-claude',
      harness: 'claude',
      source: 'example',
      scope: 'Fictional example',
      inputTokens: 134000,
      outputTokens: 24800,
      cachedTokens: 68000,
      totalTokens: 158800,
      estimatedUsd: 4.62,
      observedAt: stamp,
    },
  ];
  usage.forEach((u) => store.saveUsage(u));
  seedContinuityExample(store, stamp, accounts[0]);
}

function seedContinuityExample(store: Store, stamp: string, source: Account) {
  const destination: Account = {
    ...source,
    id: 'demo-hermes',
    label: 'Hermes example',
    harness: 'hermes',
    identity: 'example@example.invalid',
    identityKey: 'example-hermes',
    quotas: [],
  };
  store.put('accounts', destination.id, destination);
  const work: Work = {
    id: 'demo-continuity',
    title: 'One task. Codex to Hermes.',
    project: 'Fictional handoff example',
    cwd: '',
    goal: 'Write a small project summary in Codex, then continue its review in Hermes.',
    context:
      'The same work retains its goal, selected memory and checkpoint. Native tools keep execution ownership. This example is fictional and never touches a project directory.',
    acceptance:
      'Inspect both attempt records and the retained checkpoint, then export the public receipt. Selected-context continuity does not imply lossless native hidden state.',
    harness: 'hermes',
    accountId: destination.id,
    status: 'completed',
    priority: 'normal',
    generation: 2,
    revision: 0,
    nativeSessionId: null,
    activeRunId: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  store.put('work', work.id, work);
  store.event(
    work.id,
    'checkpoint',
    'Fictional checkpoint retained',
    'The example summary is ready for review. Keep the goal and selected project context.',
  );
  store.event(
    work.id,
    'handoff',
    'Fictional Codex to Hermes handoff',
    'One canonical work record; new native conversation; selected context retained. No native process or file operation occurred.',
  );
  for (const [index, harness] of ['codex', 'hermes'].entries()) {
    const run: Run = {
      id: 'demo-continuity-' + harness,
      workId: work.id,
      accountId: index ? destination.id : source.id,
      harness,
      generation: index + 1,
      nativeSessionId: 'fictional-session-' + harness,
      nativeTurnId: 'fictional-turn-' + harness,
      status: 'completed',
      startedAt: stamp,
      endedAt: stamp,
      exitConfirmed: true,
      supervisionId: 'fictional-supervision-' + harness,
    };
    store.put('runs', run.id, run);
    store.saveUsage({
      key: 'demo-continuity-usage-' + harness,
      workId: work.id,
      accountId: run.accountId,
      harness,
      source: 'example',
      scope: 'Fictional example',
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 0,
      totalTokens: 1500,
      estimatedUsd: 0.01,
      observedAt: stamp,
    });
    store.event(
      work.id,
      'assistant',
      'Fictional ' + (index ? 'Hermes review' : 'Codex summary'),
      'Illustrative completed attempt. The public receipt summarizes only safe fields; it excludes goal, memory, file paths and account identifiers.',
    );
  }
}
