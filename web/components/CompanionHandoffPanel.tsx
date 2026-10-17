import { useState, type FormEvent } from 'react';
import type { CompanionGrant } from '../../shared/types';
import type { CompanionHandoff, CompanionHandoffPlan } from '../../shared/companion-handoff';
import type { Mutate } from '../api';
import { Dialog, FormError } from './primitives';

export function CompanionReplacement({
  grant,
  mutate,
  onClose,
  onCredential,
}: {
  grant: CompanionGrant;
  mutate: Mutate;
  onClose: () => void;
  onCredential: (value: { grant: CompanionGrant; token: string; endpoint: string }) => void;
}) {
  const [label, setLabel] = useState('Replacement companion');
  const [plan, setPlan] = useState<CompanionHandoffPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function prepare(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setPlan(await mutate('/companions/handoffs/prepare', 'POST', { grantId: grant.id, label }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function stage() {
    if (!plan) return;
    setBusy(true);
    setError('');
    try {
      const result = await mutate<{
        grant: CompanionGrant;
        token: string | null;
        endpoint: string;
      }>('/companions/handoffs/stage', 'POST', { id: plan.id, digest: plan.digest });
      if (!result.token)
        throw new Error(
          'This access was already staged. Its secret is not retained. Cancel the handoff before creating a fresh connection.',
        );
      onCredential({ ...result, token: result.token });
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Replace companion" onClose={onClose}>
      <form className="dialog-form" onSubmit={prepare}>
        <div className="dialog-body form-stack">
          <p>
            Prepare another native MCP client for {grant.label}’s existing profile and project.
            Work, selected memory references and native account bindings stay in Forge.
          </p>
          <label>
            Replacement name
            <input
              autoFocus
              data-autofocus=""
              required
              maxLength={80}
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
                setPlan(null);
              }}
            />
          </label>
          {plan && (
            <section className="memory-launch-review" aria-label="Companion replacement boundary">
              <h3>{plan.boundary.profile.name}</h3>
              <p className="companion-root">{plan.boundary.root}</p>
              <p>
                {plan.boundary.workCount} saved work{' '}
                {plan.boundary.workCount === 1 ? 'record' : 'records'} ·{' '}
                {plan.boundary.memory.length} selected memory{' '}
                {plan.boundary.memory.length === 1 ? 'reference' : 'references'}
              </p>
              <p>
                {plan.from.dispatch
                  ? `${plan.from.runsStarted} of ${plan.from.dispatch.maxRuns} native runs already used. The replacement shares this allowance and the same expiry.`
                  : 'The same access scopes and expiry are retained.'}
              </p>
              <p>
                Staging pauses new writes from the original connection. The replacement can read
                permitted context and acknowledge readiness. Activate it after reviewing native
                planners, schedules and external work.
              </p>
            </section>
          )}
          <p className="source-note">
            Native tools, providers, channels, hidden conversation state and schedules retain their
            native owners. This handoff changes Forge access; it does not start a second model loop
            or migrate native jobs.
          </p>
          <FormError error={error} />
        </div>
        <div className="form-footer">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {plan ? (
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void stage()}
            >
              Stage replacement
            </button>
          ) : (
            <button className="button primary" disabled={busy}>
              Review replacement
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

function HandoffRow({
  handoff,
  mutate,
  disabled,
}: {
  handoff: CompanionHandoff;
  mutate: Mutate;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [error, setError] = useState('');
  async function action(name: 'refresh' | 'activate' | 'abort') {
    setBusy(true);
    setError('');
    try {
      await mutate(`/companions/handoffs/${handoff.id}/${name}`, 'POST', {
        digest: handoff.digest,
        revision: handoff.revision,
        ...(name === 'activate' ? { nativeActivityReviewed: true } : {}),
      });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const open = ['staged', 'ready'].includes(handoff.state);
  return (
    <article className="backend-instance" aria-label={`Handoff to ${handoff.label}`}>
      <h3>{handoff.label}</h3>
      <p>
        {handoff.state === 'staged'
          ? 'Waiting for the replacement client'
          : handoff.state === 'ready'
            ? 'Replacement acknowledged the context boundary'
            : handoff.state === 'activated'
              ? 'Replacement activated; original access revoked'
              : 'Handoff cancelled; replacement access revoked'}
      </p>
      <p className="source-note">
        {handoff.boundary.profile.name} · {handoff.boundary.workCount} saved work{' '}
        {handoff.boundary.workCount === 1 ? 'record' : 'records'}. Native schedules keep their
        native owner.
      </p>
      {open && (
        <>
          <details className="companion-handoff-detail">
            <summary>Native client readiness</summary>
            <p>
              In the replacement client, read forge_workspace and the permitted forge_context for
              relevant work. Then call forge_companion_ready with this boundary:
            </p>
            <pre>{JSON.stringify({ handoffId: handoff.id, digest: handoff.digest }, null, 2)}</pre>
            <p className="source-note">
              The original connection and replacement can read context. Neither can create,
              checkpoint or dispatch work until this handoff is resolved. If the one-time connection
              secret was lost, cancel and stage again.
            </p>
          </details>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
              disabled={disabled || busy}
            />
            <span>
              I reviewed native planners, schedules and external work before changing the active
              Forge connection.
            </span>
          </label>
          <div className="inline-actions">
            <button
              className="button primary small"
              disabled={disabled || busy || !reviewed || handoff.state !== 'ready'}
              onClick={() => void action('activate')}
            >
              Activate replacement
            </button>
            <button
              className="button secondary small"
              disabled={disabled || busy}
              onClick={() => void action('refresh')}
            >
              Refresh context boundary
            </button>
            <button
              className="text-button"
              disabled={disabled || busy}
              onClick={() => void action('abort')}
            >
              Cancel handoff
            </button>
          </div>
        </>
      )}
      <FormError error={error} />
    </article>
  );
}

export function CompanionHandoffList({
  handoffs = [],
  mutate,
  disabled,
}: {
  handoffs?: CompanionHandoff[];
  mutate: Mutate;
  disabled: boolean;
}) {
  if (!handoffs.length) return null;
  return (
    <section className="companion-handoffs" aria-label="Companion handoffs">
      <h3>Companion handoffs</h3>
      {handoffs.slice(0, 10).map((handoff) => (
        <HandoffRow
          key={`${handoff.id}:${handoff.digest}`}
          handoff={handoff}
          mutate={mutate}
          disabled={disabled}
        />
      ))}
    </section>
  );
}
