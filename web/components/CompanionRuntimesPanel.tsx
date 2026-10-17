import { useState, useEffect, useRef, type FormEvent } from 'react';
import type { Snapshot } from '../../shared/types';
import type { CompanionRuntimeReview } from '../../shared/companion-runtime';
import type { Mutate } from '../api';
import { Dialog, FormError } from './primitives';
import { NativeResourceSummary } from './NativeResourceControls';

export function CompanionRuntimesPanel({
  data,
  mutate,
  runtimeFocus,
}: {
  data: Snapshot;
  mutate: Mutate;
  runtimeFocus?: string;
}) {
  const snapshot = data.companionRuntime;
  const focused = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    focused.current?.focus({ preventScroll: true });
    focused.current?.scrollIntoView({ block: 'center' });
  }, [runtimeFocus]);
  const [adding, setAdding] = useState(false),
    [review, setReview] = useState<CompanionRuntimeReview | null>(null);
  const [label, setLabel] = useState(''),
    [accountId, setAccountId] = useState(''),
    [grantId, setGrantId] = useState('');
  const [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  if (!snapshot || data.mode === 'demo') return null;
  const accounts = data.accounts.filter(
    (account) =>
      snapshot.providers.includes(account.harness) &&
      account.nativeHome &&
      !account.backend &&
      !account.connector,
  );
  const grants = (data.companionGrants ?? []).filter(
    (grant) =>
      !grant.revokedAt &&
      grant.expiresAt > data.now &&
      (!grant.lifecycle || ['active', 'staged'].includes(grant.lifecycle)),
  );
  if (!accounts.length && !snapshot.runtimes.length) return null;
  const local = data.access?.kind !== 'tailscale';
  async function action(name: string, run: () => Promise<unknown>) {
    setBusy(name);
    setError('');
    try {
      await run();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function register(event: FormEvent) {
    event.preventDefault();
    await action('register', async () => {
      await mutate('/companion-runtimes', 'POST', { label, accountId, grantId });
      setAdding(false);
    });
  }
  async function prepare(runtimeId: string) {
    await action(runtimeId, async () => {
      const plan = await mutate<CompanionRuntimeReview>(
        `/companion-runtimes/${runtimeId}/prepare`,
        'POST',
        {},
      );
      setConsent(false);
      setReview(plan);
    });
  }
  async function start(event: FormEvent) {
    event.preventDefault();
    if (!review) return;
    await action('start', async () => {
      await mutate('/companion-runtimes/start', 'POST', {
        id: review.id,
        digest: review.digest,
        nativeActivityReviewed: consent,
        nativeSpendingAccepted: consent,
      });
      setReview(null);
    });
  }
  return (
    <section className="companion-runtimes" aria-label="Native companion runtimes">
      <div className="section-heading">
        <div>
          <h3>Native runtimes</h3>
          <p>
            Run the installed gateway for a linked companion. Native tools, memory and scheduling
            keep their native owner.
          </p>
        </div>
        <button
          className="button secondary small"
          disabled={
            !local || !snapshot.supported || !accounts.length || !grants.length || Boolean(busy)
          }
          onClick={() => {
            setAccountId(accounts[0]?.id ?? '');
            setGrantId(grants[0]?.id ?? '');
            setLabel('Native companion');
            setError('');
            setAdding(true);
          }}
        >
          Link runtime
        </button>
      </div>
      {!snapshot.supported && (
        <p className="source-note">
          Managed native gateways require a file-backed macOS or Linux workspace.
        </p>
      )}
      {!grants.length && (
        <p className="source-note">Create companion access above to link a native gateway.</p>
      )}
      {!adding && !review && <FormError error={error} />}
      {snapshot.runtimes.map((runtime) => {
        const launch = snapshot.launches.find((item) => item.id === runtime.currentLaunchId),
          recovery = snapshot.recovery.find((item) => item.launchId === launch?.id);
        const open = Boolean(launch && !launch.exitConfirmed),
          state = !launch
            ? 'Not started'
            : launch.state === 'unknown'
              ? 'Needs review'
              : launch.state;
        return (
          <div
            className="backend-instance"
            key={runtime.id}
            role="group"
            aria-label={runtime.label}
            tabIndex={-1}
            ref={runtime.id === runtimeFocus ? focused : undefined}
          >
            <div className="section-heading">
              <div>
                <h4>{runtime.label}</h4>
                <p>
                  {data.accounts.find((account) => account.id === runtime.accountId)?.label ??
                    runtime.harness}{' '}
                  ·{' '}
                  {data.profiles.find((profile) => profile.id === runtime.profileId)?.name ??
                    'Saved profile'}{' '}
                  · {state}
                </p>
              </div>
              <div className="companion-grant-actions">
                {!open && (
                  <button
                    className="button secondary small"
                    disabled={Boolean(busy)}
                    onClick={() => void prepare(runtime.id)}
                    aria-label={`Start ${runtime.label}`}
                  >
                    Review start
                  </button>
                )}
                {open && ['starting', 'running'].includes(launch!.state) && (
                  <button
                    className="button secondary small"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void action(runtime.id, () =>
                        mutate(`/companion-runtimes/${runtime.id}/stop`, 'POST', {
                          launchId: launch!.id,
                          revision: launch!.revision,
                        }),
                      )
                    }
                    aria-label={`Stop ${runtime.label}`}
                  >
                    Stop gateway
                  </button>
                )}
                {recovery?.state === 'ready' && (
                  <button
                    className="button secondary small"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void action(runtime.id, () =>
                        mutate(
                          `/companion-runtimes/launches/${recovery.launchId}/reconcile`,
                          'POST',
                          { digest: recovery.digest, revision: recovery.revision },
                        ),
                      )
                    }
                    aria-label={`Reconcile ${runtime.label}`}
                  >
                    Reconcile exit
                  </button>
                )}
                <button
                  className="text-button"
                  disabled={Boolean(busy) || open}
                  onClick={() =>
                    void action(runtime.id, () =>
                      mutate(`/companion-runtimes/${runtime.id}`, 'DELETE', {
                        revision: runtime.revision,
                      }),
                    )
                  }
                  aria-label={`Retire ${runtime.label}`}
                >
                  Retire
                </button>
              </div>
            </div>
            {launch && (
              <p className="source-note" role="status">
                {launch.detail}
              </p>
            )}
            {launch?.nativeResources && <NativeResourceSummary receipt={launch.nativeResources} />}
            {recovery && <p className="source-note">{recovery.detail}</p>}
            <p className="source-note">
              Stop the original native gateway before replacing its companion access. A fresh start
              requires another review.
            </p>
          </div>
        );
      })}
      {adding && (
        <Dialog title="Link native runtime" onClose={() => setAdding(false)}>
          <form className="dialog-form" onSubmit={register}>
            <div className="dialog-body form-stack">
              <p>
                Choose an existing native account and companion access for this gateway. Linking
                saves its configuration.
              </p>
              <label>
                Runtime name
                <input
                  autoFocus
                  data-autofocus=""
                  required
                  maxLength={80}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <label>
                Native account
                <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label} · {account.harness}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Companion access
                <select value={grantId} onChange={(event) => setGrantId(event.target.value)}>
                  {grants.map((grant) => (
                    <option key={grant.id} value={grant.id}>
                      {grant.label} ·{' '}
                      {data.profiles.find((profile) => profile.id === grant.profileId)?.name ??
                        'Saved profile'}
                    </option>
                  ))}
                </select>
              </label>
              <FormError error={error} />
            </div>
            <div className="form-footer">
              <button type="button" className="button secondary" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={Boolean(busy) || !label.trim()}
              >
                Link runtime
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {review && (
        <Dialog title="Start native gateway" onClose={() => setReview(null)}>
          <form className="dialog-form" onSubmit={start}>
            <div className="dialog-body form-stack">
              <p>
                Start {review.runtime.label} with the installed {review.account.harness} gateway.
                Its native channels, schedules and provider configuration become active.
              </p>
              <div className="launch-context">
                <strong>{review.account.label}</strong>
                <p className="runtime-path">{review.nativeHome}</p>
                <p>
                  {data.profiles.find((profile) => profile.id === review.runtime.profileId)?.name ??
                    'Saved profile'}{' '}
                  · {review.nativeFiles.filter((file) => file.sha256).length} native profile files
                  in this review
                </p>
              </div>
              <p className="source-note">
                Native gateway model usage follows its own policy and sits outside Forge work
                reservations. Native permissions and external effects retain their native controls.
              </p>
              {review.nativeResources && <NativeResourceSummary receipt={review.nativeResources} />}
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                {review.nativeResources
                  ? 'I reviewed this profile’s channels, schedules and native resource policy and accept its provider usage.'
                  : 'I reviewed this profile’s native channels and schedules and accept its provider usage.'}
              </label>
              <FormError error={error} />
            </div>
            <div className="form-footer">
              <button type="button" className="button secondary" onClick={() => setReview(null)}>
                Cancel
              </button>
              <button type="submit" className="button primary" disabled={Boolean(busy) || !consent}>
                Start gateway
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
