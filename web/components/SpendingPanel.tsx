import { useState, type FormEvent } from 'react';
import type { Snapshot } from '../../shared/types';
import type { SpendAttempt, SpendingPolicy } from '../../shared/spending';
import type { Mutate } from '../api';
import { currency, compact, age } from '../lib/format';
import { Dialog, FormError } from './primitives';

export function SpendingPanel({
  data,
  mutate,
  onWork,
}: {
  data: Snapshot;
  mutate: Mutate;
  onWork: (id: string) => void;
}) {
  const [editing, setEditing] = useState<SpendingPolicy | null>(null);
  const [review, setReview] = useState<SpendAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const spending = data.spending;
  if (!spending) return null;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const values = new FormData(event.currentTarget);
    const amount = (key: string) =>
      String(values.get(key) ?? '').trim() === '' ? null : Number(values.get(key));
    setBusy(true);
    setError('');
    try {
      await mutate('/spending/policy', 'PATCH', {
        expectedRevision: editing.revision,
        monthlyUsd: amount('monthly'),
        workUsd: amount('work'),
        attemptUsd: amount('attempt'),
      });
      setEditing(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await mutate(`/spending/${review.runId}/review`, 'POST', {
        expectedRevision: review.revision,
        usd: Number(values.get('usd')),
        note: String(values.get('note')),
      });
      setReview(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label="Spending and outcomes">
      <div className="section-heading">
        <div>
          <h2>Spending and outcomes</h2>
          <p>{spending.period} UTC. Managed attempts recorded by this Forge workspace.</p>
        </div>
        <button
          className="button secondary small"
          onClick={() => {
            setEditing(spending.policy);
            setError('');
          }}
        >
          Set budgets
        </button>
      </div>
      <dl className="account-facts">
        <div>
          <dt>Month accounted</dt>
          <dd>
            {currency(spending.accountedUsd)}
            {spending.policy.monthlyUsd !== null && ` / ${currency(spending.policy.monthlyUsd)}`}
          </dd>
        </div>
        <div>
          <dt>Open reservations</dt>
          <dd>{currency(spending.reservedUsd)}</dd>
        </div>
        <div>
          <dt>Unresolved costs</dt>
          <dd>{spending.unknownAttempts} attempts</dd>
        </div>
        <div>
          <dt>Attempt tokens</dt>
          <dd>{compact(spending.reportedTokens)} reported</dd>
        </div>
        <div>
          <dt>Accepted work</dt>
          <dd>{spending.acceptedOutcomes} current outcomes</dd>
        </div>
      </dl>
      <p className="source-note">
        {spending.policy.attemptUsd === null
          ? 'Budget admission is off.'
          : `${currency(spending.policy.attemptUsd)} is reserved before each attempt.`}{' '}
        Accounted amounts include native estimates, held reservations and explicit human reviews.
        Native charges, outside sessions and earlier history can differ. Unknown costs never become
        free capacity.
      </p>
      <details className="native-details">
        <summary>Recent attempt receipts ({spending.attempts.length})</summary>
        {spending.attempts.length ? (
          <div
            className="table-scroll"
            role="region"
            aria-label="Managed attempt spending"
            tabIndex={0}
          >
            <table className="process-table">
              <thead>
                <tr>
                  <th scope="col">Work / account</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">USD accounted</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {spending.attempts.map((attempt) => (
                  <tr key={attempt.runId}>
                    <td>
                      <button className="text-button" onClick={() => onWork(attempt.workId)}>
                        {data.work.find((w) => w.id === attempt.workId)?.title ?? 'Saved work'}
                      </button>
                      <small className="source-note">
                        {data.accounts.find((a) => a.id === attempt.accountId)?.label ??
                          'Saved account'}{' '}
                        · {age(attempt.startedAt)}
                      </small>
                    </td>
                    <td className="mono">{compact(attempt.totalTokens)}</td>
                    <td className="mono">{currency(attempt.accountedUsd)}</td>
                    <td>
                      {attempt.state === 'reported'
                        ? 'Native estimate'
                        : attempt.state === 'reviewed'
                          ? 'Human review'
                          : attempt.state === 'reserved'
                            ? 'Reserved'
                            : 'Needs review'}
                      {attempt.issues.length > 0 && (
                        <details>
                          <summary>Coverage</summary>
                          <p>{attempt.issues.join(' ')}</p>
                        </details>
                      )}
                      {attempt.review && (
                        <details>
                          <summary>Review note</summary>
                          <p>{attempt.review.note}</p>
                        </details>
                      )}
                    </td>
                    <td>
                      {attempt.endedAt && !attempt.review && (
                        <button
                          className="text-button"
                          onClick={() => {
                            setReview(attempt);
                            setError('');
                          }}
                        >
                          Review cost
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>
            No managed attempt receipts yet. Native activity and imported usage retain their
            original evidence.
          </p>
        )}
      </details>
      {editing && (
        <Dialog title="Set spending budgets" onClose={() => setEditing(null)}>
          <form className="dialog-body form-stack" onSubmit={save}>
            <p>
              Reserve money before admitting a managed attempt. Leave a field blank to disable that
              limit. Reservations use USD and the month starts at midnight UTC.
            </p>
            <label>
              Monthly budget, USD (optional)
              <input
                name="monthly"
                type="number"
                min="0.000001"
                max="1000000"
                step="0.000001"
                defaultValue={editing.monthlyUsd ?? ''}
              />
            </label>
            <label>
              Budget per work, USD (optional)
              <input
                name="work"
                type="number"
                min="0.000001"
                max="1000000"
                step="0.000001"
                defaultValue={editing.workUsd ?? ''}
              />
            </label>
            <label>
              Reservation per attempt, USD (required with a budget)
              <input
                name="attempt"
                type="number"
                min="0.000001"
                max="1000000"
                step="0.000001"
                defaultValue={editing.attemptUsd ?? ''}
              />
            </label>
            <p className="source-note">
              Claude receives its native query budget. Other harnesses retain their own native
              spending controls. A reservation gates admission; it cannot guarantee a provider
              charge ceiling or stop unreported external spend. An unknown or exceeded amount holds
              further budgeted attempts for review.
            </p>
            <FormError error={error} />
            <div className="form-footer">
              <button type="button" className="button secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Saving' : 'Save budgets'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {review && (
        <Dialog title="Review native spending" onClose={() => setReview(null)}>
          <form className="dialog-body form-stack" onSubmit={record}>
            <p>
              Record the USD amount you verified for this attempt, including included usage if
              confirmed by your provider. Keep the evidence in the note. This creates a human report
              and retains the original native counters.
            </p>
            <label>
              Verified amount, USD
              <input
                name="usd"
                type="number"
                min="0"
                max="1000000"
                step="0.000001"
                defaultValue={review.estimatedUsd ?? ''}
                required
              />
            </label>
            <label>
              Evidence and scope
              <textarea name="note" minLength={5} maxLength={2000} required rows={3} />
            </label>
            <p className="source-note">
              The native owner must be settled first. A spending review never releases an unresolved
              execution lease.
            </p>
            <FormError error={error} />
            <div className="form-footer">
              <button type="button" className="button secondary" onClick={() => setReview(null)}>
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Recording' : 'Record cost review'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
