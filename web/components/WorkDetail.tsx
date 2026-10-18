import {
  type Work,
  type Snapshot,
  type WorkspaceMode,
  type Approval,
  type WorkEvent,
  type Run,
} from '../../shared/types';
import { type Mutate } from '../api';
import { executionName, managedHarnesses, canExecuteAccount } from '../../shared/harnesses';
import { useState, type FormEvent } from 'react';
import { Dialog, Status, HarnessMark, FormError } from './primitives';
import { harnessName, age } from '../lib/format';
import { OutcomeReview } from './OutcomeReview';
import { RoutingPanel } from './RoutingPanel';
import { NativeResourceSummary } from './NativeResourceControls';
import { ShareReceiptDialog } from './ShareReceiptDialog';
import {
  ChevronRight,
  ShieldCheck,
  ArrowRight,
  Folder,
  LoaderCircle,
  Check,
  ArrowDownToLine,
  Pause,
  Play,
} from 'lucide-react';

export function WorkDetail({
  work,
  events,
  runs,
  data,
  mode,
  mutate,
  onClose,
  onEdit,
  onLaunch,
  onHandoff,
  onApproval,
  onExport,
  onStop,
  busy,
}: {
  work: Work;
  events: WorkEvent[];
  runs: Run[];
  data: Snapshot;
  mode: WorkspaceMode;
  mutate: Mutate;
  onClose: () => void;
  onEdit: () => void;
  onLaunch: () => void;
  onHandoff: () => void;
  onApproval: (approval: Approval) => void;
  onExport: () => void;
  onStop: () => void;
  busy: string;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(false);
  const nativeResources = runs.find((run) => run.generation === work.generation)?.nativeResources;
  async function checkpoint(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await mutate(`/work/${work.id}/checkpoint`, 'POST', { note });
      setNote('');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const account = data.accounts.find((a) => a.id === work.accountId);
  const pending = data.approvals.find((a) => a.workId === work.id && a.status === 'pending');
  const unsettled = runs.find((run) => run.settlement && !run.settlement.confirmed);
  async function reconcile(interrupt: boolean) {
    if (!unsettled) return;
    setSaving(true);
    setError('');
    try {
      await mutate(`/runs/${unsettled.id}/reconcile`, 'POST', { interrupt });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }
  if (sharing)
    return <ShareReceiptDialog workId={work.id} mode={mode} onClose={() => setSharing(false)} />;
  return (
    <Dialog title={work.title} subtitle={work.project} onClose={onClose} sheet>
      <div className="dialog-body detail-body">
        {unsettled && work.status === 'interrupted' && (
          <section className="form-stack" aria-label="Native run recovery">
            <h3>Native outcome needs reconciliation</h3>
            <p>
              T3 may still own this run. Check its exact outcome before launching more work. Neither
              action sends another message or grants a pending approval.
            </p>
            <div className="connection-actions">
              <button
                className="button secondary small"
                disabled={saving}
                onClick={() => void reconcile(false)}
              >
                Check native outcome
              </button>
              <button
                className="button secondary small"
                disabled={saving}
                onClick={() => void reconcile(true)}
              >
                Stop native run and reconcile
              </button>
            </div>
          </section>
        )}
        <div className="detail-state">
          <Status value={work.status} />
          <span className="source-note">
            {mode === 'demo'
              ? 'Fictional work record'
              : work.nativeSessionId
                ? 'Native session bound'
                : work.capsuleId
                  ? 'Portable checkpoint retained'
                  : 'Tracked work record'}
          </span>
          <button className="text-button" onClick={() => setSharing(true)}>
            Share receipt
          </button>
        </div>
        {work.nativeOrigin && (
          <details className="native-details">
            <summary>
              {work.nativeOrigin.state === 'pending'
                ? 'Native chat ready for a reviewed fork'
                : work.nativeOrigin.state === 'bound'
                  ? 'Native source history retained'
                  : 'Native source retained as provenance'}
            </summary>
            <p>
              {work.nativeOrigin.turns} source turns · {work.nativeOrigin.items} items ·{' '}
              {work.nativeOrigin.modelProvider}
            </p>
            <p className="runtime-path">Source {work.nativeOrigin.threadId}</p>
            <p className="source-note">
              The source chat retains its native owner. History copying and new token accounting are
              verified at the managed continuation boundary.
            </p>
          </details>
        )}
        {mode === 'local' &&
          !work.activeRunId &&
          (work.nativeSessionId || work.capsuleId || work.nativeOrigin) && (
            <button className="button secondary small" onClick={onHandoff}>
              Change harness or account
            </button>
          )}
        <div className="binding-box">
          <HarnessMark harness={work.harness} />
          <div>
            <strong>{account?.nativeExecutor?.name ?? harnessName(work.harness)}</strong>
            <p>{account?.label ?? 'Choose a native account to run this task.'}</p>
          </div>
          <button className="text-button" disabled={Boolean(work.activeRunId)} onClick={onEdit}>
            Edit context <ChevronRight size={14} />
          </button>
        </div>
        {runs.length > 0 && (
          <section className="detail-section">
            <h3>Recorded native attempts</h3>
            <p className="source-note">
              The latest {runs.length} attempt records for this work. Native sessions keep their own
              state; selected context moves through reviewed handoffs.
            </p>
            <ol className="attempt-history" aria-label="Recorded native attempts">
              {[...runs]
                .sort((a, b) => a.generation - b.generation)
                .map((run) => {
                  const nativeAccount = data.accounts.find((item) => item.id === run.accountId);
                  return (
                    <li key={run.id}>
                      <HarnessMark harness={run.harness ?? nativeAccount?.harness ?? 'unknown'} />
                      <div>
                        <strong>
                          {executionName(
                            run.harness ?? nativeAccount?.harness ?? 'unknown',
                            nativeAccount,
                          )}
                        </strong>
                        <span>
                          Attempt {run.generation} ·{' '}
                          {nativeAccount?.label ?? 'Retained native account'}
                        </span>
                        <span>
                          {run.settlement
                            ? run.settlement.confirmed
                              ? 'Native outcome reconciled'
                              : 'Native outcome needs review'
                            : run.exitConfirmed
                              ? 'Original closure recorded'
                              : 'Original closure unconfirmed'}
                        </span>
                      </div>
                      <Status value={run.status} />
                    </li>
                  );
                })}
            </ol>
          </section>
        )}
        {nativeResources && <NativeResourceSummary receipt={nativeResources} />}
        {pending && (
          <div className="notice notice-attention">
            <ShieldCheck size={18} />
            <p>A native request is waiting for your decision.</p>
            <button className="text-button" onClick={() => onApproval(pending)}>
              Review <ArrowRight size={14} />
            </button>
          </div>
        )}
        <section className="detail-section">
          <h3>The goal</h3>
          <p className="preserve">{work.goal}</p>
        </section>
        {work.acceptance && (
          <section className="detail-section">
            <h3>Acceptance criteria</h3>
            <p className="preserve">{work.acceptance}</p>
          </section>
        )}
        {work.context && (
          <section className="detail-section">
            <h3>Context to carry forward</h3>
            <p className="preserve">{work.context}</p>
          </section>
        )}
        <OutcomeReview work={work} runs={runs} data={data} mutate={mutate} />
        <RoutingPanel work={work} data={data} mutate={mutate} />
        {work.cwd && (
          <div className="path-line">
            <Folder size={15} />
            <code>{work.cwd}</code>
          </div>
        )}
        <section className="detail-section">
          <h3>Activity &amp; receipts</h3>
          <ol className="detail-timeline" role="list">
            {events.map((event) => (
              <li key={event.id}>
                <span className="event-mark" aria-hidden="true">
                  <span />
                </span>
                <div>
                  <div className="event-heading">
                    <strong>{event.title}</strong>
                    <time dateTime={event.createdAt}>{age(event.createdAt)}</time>
                  </div>
                  {event.detail &&
                    (event.detail.length > 350 ? (
                      <details>
                        <summary>
                          {event.kind === 'assistant'
                            ? 'Read native response'
                            : 'Read receipt details'}
                        </summary>
                        <p className={`preserve ${event.kind === 'command' ? 'mono' : ''}`}>
                          {event.detail}
                        </p>
                      </details>
                    ) : (
                      <p className="preserve">{event.detail}</p>
                    ))}
                </div>
              </li>
            ))}
          </ol>
        </section>
        <form className="checkpoint-form" onSubmit={checkpoint}>
          <label>
            Leave a checkpoint
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What is verified, what remains, and where should the next attempt begin?"
              required
              maxLength={20000}
            />
          </label>
          <FormError error={error} />
          <button className="button secondary small" disabled={saving || !note.trim()}>
            {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}Save
            checkpoint
          </button>
        </form>
      </div>
      <footer className="sheet-footer">
        <button className="button secondary" onClick={onExport} disabled={busy === 'export'}>
          <ArrowDownToLine size={15} />
          Export context
        </button>
        {work.activeRunId ? (
          <button
            className="button danger"
            disabled={busy === 'stop' || Boolean(work.stopRequestedAt)}
            onClick={onStop}
          >
            <Pause size={16} />
            {work.stopRequestedAt ? 'Waiting for native shutdown' : 'Stop managed attempt'}
          </button>
        ) : (canExecuteAccount(account) || managedHarnesses.includes(work.harness)) &&
          mode !== 'demo' ? (
          <button
            className="button primary"
            onClick={onLaunch}
            disabled={!work.accountId || !work.cwd}
            title={
              !work.accountId || !work.cwd
                ? 'Edit the task to add a native account and project directory'
                : 'Review account and permissions before launch'
            }
          >
            <Play size={16} />
            {work.nativeSessionId ? 'Continue with ' : 'Run with '}
            {executionName(work.harness, account)}
          </button>
        ) : (
          <span className="source-note">
            {mode === 'demo'
              ? 'Demo never starts native execution.'
              : 'Continue through the native harness.'}
          </span>
        )}
      </footer>
    </Dialog>
  );
}
