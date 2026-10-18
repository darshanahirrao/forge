import { useState } from 'react';
import type { ScheduleReview, NativeControlReceipt } from '../../shared/native-controls';
import type { Mutate } from '../api';
import { Dialog, FormError } from './primitives';
import { age } from '../lib/format';

export function NativeScheduleControl({
  plan,
  source,
  mutate,
  onClose,
  onApplied,
}: {
  plan: ScheduleReview;
  source: string;
  mutate: Mutate;
  onClose: () => void;
  onApplied: (receipt: NativeControlReceipt) => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      title={`Review native ${plan.action}`}
      subtitle={source}
      onClose={busy ? () => {} : onClose}
    >
      <form
        className="dialog-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!reviewed || busy) return;
          setBusy(true);
          setError('');
          try {
            onApplied(
              await mutate<NativeControlReceipt>(`/native/controls/${plan.id}/apply`, 'POST', {
                reviewed: true,
              }),
            );
          } catch (cause) {
            setError(
              `${(cause as Error).message} Check the control receipts before preparing another action.`,
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body form-stack">
          <p>
            <strong>{plan.title}</strong>
          </p>
          <p>
            {plan.state} · {plan.enabled ? 'Enabled' : 'Disabled'} · Next run:{' '}
            {plan.nextRunAt ? new Date(plan.nextRunAt).toLocaleString() : 'Not reported'}
          </p>
          <p>
            {plan.action === 'resume'
              ? 'Resume enables future native scheduling. Its runtime may run models, scripts and deliveries using native permissions and billing. Forge managed-work budgets and quiet mode do not govern this scheduler.'
              : 'Pause prevents future native scheduling. Work and deliveries already running retain their native owner.'}
          </p>
          <p className="muted">
            {plan.contract === 'hermes-builtin-native-flock/1'
              ? 'The entire native job store and configuration must still match this two-minute review.'
              : 'OpenClaw must confirm this exact native job revision and paired operator scope before changing scheduling.'}{' '}
            An uncertain result requires human review before another control.
          </p>
          <label>
            Native rule<pre className="native-rule">{plan.rule}</pre>
          </label>
          {plan.prompt && (
            <label>
              Native instructions<pre className="native-rule">{plan.prompt}</pre>
            </label>
          )}
          {plan.script && (
            <label>
              Native script reference<code className="native-rule">{plan.script}</code>
            </label>
          )}
          <details className="native-details">
            <summary>Complete native job record</summary>
            <pre className="native-rule">{plan.definition}</pre>
          </details>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            I reviewed this job and its native permissions, delivery and billing.
          </label>
          <FormError error={error} />
        </div>
        <footer className="form-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button" disabled={!reviewed || busy}>
            {busy
              ? 'Waiting for native result…'
              : `${plan.action === 'pause' ? 'Pause' : 'Resume'} native schedule`}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

export function NativeControlReceipts({
  receipts,
  mutate,
  disabled,
}: {
  receipts: NativeControlReceipt[];
  mutate: Mutate;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  if (!receipts.length) return null;
  return (
    <section className="panel" aria-label="Native control receipts">
      <div className="section-heading">
        <div>
          <h2>Native control receipts</h2>
          <p>Outcomes retain their evidence. Lost acknowledgements are never replayed.</p>
        </div>
      </div>
      <div className="native-entry-list">
        {receipts.map((receipt) => (
          <article className="native-entry" key={receipt.id}>
            <div className="native-entry-copy">
              <h3>
                {receipt.title} · {receipt.action} · {receipt.state}
              </h3>
              <p>{receipt.detail}</p>
              <small>
                {age(receipt.updatedAt)}
                {receipt.actor.kind === 'tailscale'
                  ? ` · ${receipt.actor.identity}`
                  : ' · Local operator'}
              </small>
              {receipt.observed && (
                <p>
                  Observed: {receipt.observed.state} ·{' '}
                  {receipt.observed.enabled === null
                    ? 'Scheduling state unavailable'
                    : receipt.observed.enabled
                      ? 'Enabled'
                      : 'Disabled'}
                </p>
              )}
              {receipt.review && (
                <p>
                  Reviewed {age(receipt.review.observedAt).toLowerCase()} ·{' '}
                  {receipt.review.observed.state} · {receipt.review.note}
                </p>
              )}
              {receipt.state === 'uncertain' && !receipt.review && (
                <details className="native-details">
                  <summary>Review uncertain outcome</summary>
                  <p>
                    Check the native run history and deliveries for effects that may already have
                    happened. Recording a review reads the current scheduling state and releases
                    this control hold. It does not prove that an earlier effect was cancelled.
                  </p>
                  <form
                    className="form-stack"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const note = new FormData(event.currentTarget).get('note');
                      setBusy(receipt.id);
                      setError('');
                      try {
                        await mutate(`/native/controls/${receipt.id}/review`, 'POST', { note });
                      } catch (cause) {
                        setError((cause as Error).message);
                      } finally {
                        setBusy('');
                      }
                    }}
                  >
                    <label>
                      What did you check in the native runtime?
                      <textarea name="note" required minLength={8} maxLength={2000} rows={3} />
                    </label>
                    <button className="button secondary small" disabled={disabled || !!busy}>
                      {busy === receipt.id
                        ? 'Reading native state…'
                        : 'Read state and record review'}
                    </button>
                  </form>
                </details>
              )}
            </div>
          </article>
        ))}
      </div>
      <FormError error={error} />
    </section>
  );
}
