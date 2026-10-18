import type { Approval, Run, Usage, WorkspaceMode } from './types.js';
import { usageSummary } from './usage.js';

const names = new Map([
  ['codex', 'Codex'],
  ['claude', 'Claude'],
  ['opencode', 'OpenCode'],
  ['hermes', 'Hermes'],
  ['openclaw', 'OpenClaw'],
]);
const count = (value: number) =>
  Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;

/** Public allowlist: no work/context/account identifiers or free-form native text. */
export function publicReceipt(
  mode: WorkspaceMode,
  runs: Run[],
  usage: Usage[],
  approvals: Approval[],
  checkpoints: number,
) {
  const summary = usageSummary(usage);
  const sequence = [...runs]
    .sort((a, b) => a.generation - b.generation)
    .map((run) => names.get(run.harness ?? '') ?? 'Custom harness')
    .filter((name, index, all) => index === 0 || name !== all[index - 1]);
  return {
    format: 'forge.public-receipt' as const,
    version: 1 as const,
    evidence: mode === 'demo' ? ('fictional-demo' as const) : ('local-records' as const),
    workRecords: 1,
    harnessSequence: sequence.slice(-32),
    sequenceTruncated: sequence.length > 32,
    recordedAttempts: runs.length,
    completedAttempts: runs.filter((run) => run.status === 'completed').length,
    confirmedOriginalClosures: runs.filter(
      (run) => run.supervisionId && run.exitConfirmed === true && !run.settlement,
    ).length,
    savedCheckpoints: count(checkpoints),
    acceptedApprovals: approvals.filter((approval) => approval.status === 'accepted').length,
    pendingApprovals: approvals.filter((approval) => approval.status === 'pending').length,
    reportedTokens: count(summary.totalTokens),
    estimatedUsd: summary.estimatedUsd === null ? null : count(summary.estimatedUsd),
    usageIncomplete: !summary.entries.length || summary.incomplete,
    scope:
      'Locally recorded activity for one canonical work record. No independent attestation of native context, artifacts, provider invoices or external effects.',
    repository: 'https://github.com/darshanahirrao/forge',
  };
}
export type PublicReceipt = ReturnType<typeof publicReceipt>;

export function receiptMarkdown(receipt: PublicReceipt) {
  const cost =
    receipt.estimatedUsd === null
      ? 'USD estimate not reported'
      : '$' + receipt.estimatedUsd.toFixed(4) + ' estimated USD (not an invoice)';
  return [
    receipt.harnessSequence.length > 1 ? '# One work. Multiple harnesses.' : '# Forge work receipt',
    '',
    receipt.evidence === 'fictional-demo'
      ? 'FICTIONAL DEMO. These are illustrative records, not native execution evidence.'
      : 'Recorded locally by Forge. Self-reported activity, not an independent attestation.',
    '',
    receipt.harnessSequence.join(' -> ') || 'No native attempts recorded.',
    ...(receipt.sequenceTruncated ? ['Sequence shows the last 32 harness changes.'] : []),
    '',
    '- One canonical work record',
    '- ' + receipt.recordedAttempts + ' attempts; ' + receipt.completedAttempts + ' completed',
    '- ' + receipt.confirmedOriginalClosures + ' original-process closures recorded',
    '- ' +
      receipt.savedCheckpoints +
      ' saved checkpoint' +
      (receipt.savedCheckpoints === 1 ? '' : 's'),
    '- ' +
      receipt.acceptedApprovals +
      ' accepted approvals; ' +
      receipt.pendingApprovals +
      ' pending',
    '- ' + receipt.reportedTokens + ' reported tokens',
    '- ' + cost + (receipt.usageIncomplete ? '; coverage incomplete' : ''),
    '',
    receipt.scope,
    '',
    'Work titles, projects, prompts, memory, file paths, accounts and identifiers are excluded.',
    '',
    receipt.repository,
    '',
  ].join('\n');
}
