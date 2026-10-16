import {
  type Work,
  type Snapshot,
  type WorkspaceMode,
  type Approval,
  type WorkEvent,
} from '../../shared/types';
import { type Mutate } from '../api';
import { executionName, managedHarnesses } from '../../shared/harnesses';
import { useState, type FormEvent } from 'react';
import { Dialog, Status, HarnessMark, FormError } from './primitives';
import { names, age } from '../lib/format';
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
  data,
  mode,
  mutate,
  onClose,
  onEdit,
  onLaunch,
  onApproval,
  onExport,
  onStop,
  busy,
}: {
  work: Work;
  events: WorkEvent[];
  data: Snapshot;
  mode: WorkspaceMode;
  mutate: Mutate;
  onClose: () => void;
  onEdit: () => void;
  onLaunch: () => void;
  onApproval: (approval: Approval) => void;
  onExport: () => void;
  onStop: () => void;
  busy: string;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
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
  return (
    <Dialog title={work.title} subtitle={work.project} onClose={onClose} sheet>
      <div className="dialog-body detail-body">
        <div className="detail-state">
          <Status value={work.status} />
          <span className="source-note">
            {mode === 'demo'
              ? 'Fictional work record'
              : work.nativeSessionId
                ? 'Native session bound'
                : 'Tracked work record'}
          </span>
        </div>
        <div className="binding-box">
          <HarnessMark harness={work.harness} />
          <div>
            <strong>{names[work.harness]}</strong>
            <p>{account?.label ?? 'Choose a native account to run this task.'}</p>
          </div>
          <button className="text-button" disabled={Boolean(work.activeRunId)} onClick={onEdit}>
            Edit context <ChevronRight size={14} />
          </button>
        </div>
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
          <button className="button danger" disabled={busy === 'stop'} onClick={onStop}>
            <Pause size={16} />
            Stop managed attempt
          </button>
        ) : managedHarnesses.includes(work.harness) && mode !== 'demo' ? (
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
            {executionName(work.harness)}
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
