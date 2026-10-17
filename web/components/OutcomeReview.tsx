import { useState, type FormEvent } from 'react';
import type { Run, Snapshot, Work } from '../../shared/types';
import type { Mutate } from '../api';
import { FormError } from './primitives';

export function OutcomeReview({
  work,
  runs,
  data,
  mutate,
}: {
  work: Work;
  runs: Run[];
  data: Snapshot;
  mutate: Mutate;
}) {
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const outcome = data.outcomes?.find((row) => row.workId === work.id);
  const current = outcome?.workRevision === work.revision && outcome.generation === work.generation;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await mutate(`/work/${work.id}/outcome`, 'POST', {
        expectedRevision: work.revision,
        decision: values.get('decision'),
        note: values.get('note'),
      });
      setEditing(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (data.mode !== 'local' || !runs.length) return null;
  return (
    <section className="detail-section" aria-label="Work acceptance">
      <h3>Work acceptance</h3>
      <p>
        {current
          ? outcome.decision === 'accepted'
            ? 'You accepted this work.'
            : 'You marked this work for another pass.'
          : outcome
            ? 'Work changed since the last acceptance review.'
            : 'Native completion is recorded. Acceptance is your decision.'}
      </p>
      {current && <p className="preserve">{outcome.note}</p>}
      {!editing && (
        <button
          className="text-button"
          disabled={Boolean(work.activeRunId)}
          onClick={() => setEditing(true)}
        >
          Review outcome
        </button>
      )}
      {editing && (
        <form className="form-stack" onSubmit={save}>
          <label>
            Outcome
            <select name="decision">
              <option value="accepted">Acceptance criteria met</option>
              <option value="needs-work">Needs another pass</option>
            </select>
          </label>
          <label>
            What you verified
            <textarea name="note" rows={3} minLength={5} maxLength={2000} required />
          </label>
          <FormError error={error} />
          <div className="form-footer">
            <button
              type="button"
              className="button secondary small"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button className="button secondary small" disabled={busy || Boolean(work.activeRunId)}>
              Save outcome
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
