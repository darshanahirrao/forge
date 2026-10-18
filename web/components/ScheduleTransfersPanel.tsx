import { useState } from 'react';
import type { NativeSource } from '../../shared/types';
import type {
  ScheduleTransfer,
  ScheduleTransferPlan,
  ScheduleTransferReview,
} from '../../shared/schedule-transfers';
import type { Mutate } from '../api';
import { Dialog, FormError } from './primitives';
import { age } from '../lib/format';

export function ScheduleTransfersPanel({
  rows,
  sources,
  mutate,
  disabled,
}: {
  rows: ScheduleTransfer[];
  sources: NativeSource[];
  mutate: Mutate;
  disabled: boolean;
}) {
  const [review, setReview] = useState<ScheduleTransferReview | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const label = (id: string) =>
    sources.find((source) => source.id === id)?.label ?? 'Native scheduler';
  if (!rows.length) return null;
  return (
    <>
      <section className="panel" aria-label="Schedule transfers">
        <div className="section-heading">
          <div>
            <h2>Schedule transfers</h2>
            <p>A paused original, a reviewed destination and one native scheduler owner.</p>
          </div>
        </div>
        <div className="native-entry-list">
          {rows.map((row) => (
            <article className="native-entry" key={row.id}>
              <div className="native-entry-copy">
                <h3>
                  {row.title} · {row.state}
                </h3>
                <p>
                  {label(row.sourceId)} → {label(row.targetSourceId)}
                </p>
                <p>{row.detail}</p>
                <small>{age(row.updatedAt)}</small>
                {row.state !== 'cancelled' && (
                  <div className="activity-actions">
                    <button
                      className="button secondary small"
                      disabled={disabled || !!busy}
                      onClick={async () => {
                        setBusy(row.id);
                        setError('');
                        try {
                          setReview(
                            await mutate<ScheduleTransferReview>(
                              `/native/transfers/${row.id}/review`,
                              'POST',
                            ),
                          );
                        } catch (cause) {
                          setError((cause as Error).message);
                        } finally {
                          setBusy('');
                        }
                      }}
                    >
                      {busy === row.id ? 'Reading both owners…' : 'Review transfer'}
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
        <FormError error={error} />
      </section>
      {review && <TransferReview review={review} mutate={mutate} onClose={() => setReview(null)} />}
    </>
  );
}

function NativeDefinitions({ source, target }: { source: string; target: string }) {
  return (
    <details className="native-details">
      <summary>Source and destination definitions</summary>
      <label>
        Source native record<pre className="native-rule">{source}</pre>
      </label>
      <label>
        Destination native record<pre className="native-rule">{target}</pre>
      </label>
    </details>
  );
}

export function MoveScheduleDialog({
  sourceId,
  jobId,
  sources,
  mutate,
  onClose,
}: {
  sourceId: string;
  jobId: string;
  sources: NativeSource[];
  mutate: Mutate;
  onClose: () => void;
}) {
  const [targetSourceId, setTarget] = useState('');
  const [plan, setPlan] = useState<ScheduleTransferPlan | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const targets = sources.filter(
    (source) =>
      source.id !== sourceId &&
      (source.kind === 'hermes-schedules' ||
        (source.kind === 'openclaw-schedules' && source.scheduleControls)),
  );
  return (
    <Dialog
      title={plan ? 'Review schedule move' : 'Move native schedule'}
      subtitle={sources.find((source) => source.id === sourceId)?.label}
      onClose={busy ? () => {} : onClose}
    >
      <form
        className="dialog-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            if (!plan)
              setPlan(
                await mutate<ScheduleTransferPlan>('/native/transfers/prepare', 'POST', {
                  sourceId,
                  jobId,
                  targetSourceId,
                }),
              );
            else if (reviewed) {
              await mutate('/native/transfers/stage', 'POST', {
                id: plan.id,
                digest: plan.digest,
                reviewed: true,
              });
              onClose();
            }
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body form-stack">
          {!plan ? (
            <>
              <p>
                Move a compatible local agent schedule between native profiles. The destination
                stays disabled until you review source activity and activate it separately.
              </p>
              <label>
                Destination scheduler
                <select
                  required
                  value={targetSourceId}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  <option value="">Choose a native scheduler</option>
                  {targets.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.label}
                    </option>
                  ))}
                </select>
              </label>
              {!targets.length && (
                <p>
                  Add another Hermes scheduler or an OpenClaw scheduler with reviewed administrator
                  access first.
                </p>
              )}
              <p className="muted">
                Pinned models, scripts, skills, dependent jobs and channel delivery need native
                mapping before transfer. Compatible instructions and timing are reviewed in the next
                step.
              </p>
            </>
          ) : (
            <>
              <p>
                <strong>{plan.portable.title}</strong>
              </p>
              <pre className="native-rule">{plan.portable.prompt}</pre>
              <pre className="native-rule">{JSON.stringify(plan.portable.schedule, null, 2)}</pre>
              <ul>
                {plan.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
              <p>
                Staging pauses future source scheduling and creates one disabled destination.
                Existing native runs and deliveries retain their owner. Resolve their effects before
                activation.
              </p>
              <NativeDefinitions source={plan.source.definition} target={plan.targetDefinition} />
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                I reviewed both definitions, destination permissions and the timing and execution
                changes.
              </label>
            </>
          )}
          <FormError error={error} />
        </div>
        <footer className="form-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Close
          </button>
          <button className="button" disabled={busy || (plan ? !reviewed : !targetSourceId)}>
            {busy ? 'Reading native result…' : plan ? 'Stage move' : 'Review move'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

function TransferReview({
  review,
  mutate,
  onClose,
}: {
  review: ScheduleTransferReview;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const [absent, setAbsent] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(action: 'activate' | 'cancel' | 'reconcile') {
    setBusy(true);
    setError('');
    try {
      await mutate(`/native/transfers/${review.id}/${action}`, 'POST', {
        revision: review.revision,
        digest: review.digest,
        reviewed: true,
        sourceActivitySettled: true,
        ...(action === 'reconcile' ? { note, targetAbsenceReviewed: absent } : {}),
      });
      onClose();
    } catch (cause) {
      setError(
        `${(cause as Error).message} Close this dialog and read both native owners for a current review.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Review schedule transfer"
      subtitle={review.title}
      onClose={busy ? () => {} : onClose}
    >
      <div className="dialog-form">
        <div className="dialog-body form-stack">
          <p>{review.detail}</p>
          <dl className="detail-list">
            <div>
              <dt>Original</dt>
              <dd>
                {review.source.state} · {review.source.enabled ? 'Enabled' : 'Disabled'}
              </dd>
            </div>
            <div>
              <dt>Destination</dt>
              <dd>
                {review.target
                  ? `${review.target.state} · ${review.target.enabled ? 'Enabled' : 'Disabled'}`
                  : 'Absent or hidden; not confirmed'}
              </dd>
            </div>
          </dl>
          <ul>
            {review.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
          <p>
            Native schedulers retain execution, billing and delivery. Check both runtimes for
            already selected work, pending mutations and external effects. A Forge hold cannot
            prevent another native client from changing a schedule.
          </p>
          <NativeDefinitions
            source={review.source.definition}
            target={review.target?.definition ?? review.targetDefinition}
          />
          <details className="native-details">
            <summary>Retained original definition</summary>
            <pre className="native-rule">{review.originalDefinition}</pre>
          </details>
          {review.state === 'uncertain' && (
            <>
              <label>
                What did you check in native history and pending operations?
                <textarea
                  required
                  minLength={8}
                  maxLength={2000}
                  rows={3}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              {!review.target && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={absent}
                    onChange={(event) => setAbsent(event.target.checked)}
                  />
                  I checked the destination native store and pending operations and confirmed no
                  transferred job exists.
                </label>
              )}
            </>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            I reviewed native permissions and billing, and confirmed both runtimes’ pending
            operations, runs and deliveries are settled.
          </label>
          {!review.canActivate && !review.canCancel && review.state !== 'uncertain' && (
            <p>
              Pause and settle the original and any running destination work through their native
              owners, then read this transfer again.
            </p>
          )}
          <FormError error={error} />
        </div>
        <footer className="form-footer">
          <button className="button secondary" disabled={busy} onClick={onClose}>
            Close
          </button>
          {review.canCancel && (
            <button
              className="button secondary"
              disabled={busy || !checked}
              onClick={() => void act('cancel')}
            >
              Keep both paused
            </button>
          )}
          {review.canActivate && (
            <button
              className="button"
              disabled={busy || !checked}
              onClick={() => void act('activate')}
            >
              Enable destination
            </button>
          )}
          {review.state === 'uncertain' && (
            <button
              className="button"
              disabled={busy || !checked || note.trim().length < 8 || (!review.target && !absent)}
              onClick={() => void act('reconcile')}
            >
              Record outcome
            </button>
          )}
        </footer>
      </div>
    </Dialog>
  );
}
