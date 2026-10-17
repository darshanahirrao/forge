import { useEffect, useState, type FormEvent } from 'react';
import type { Account, Snapshot, Work } from '../../shared/types';
import type { RouteReview } from '../../shared/routing';
import { canExecuteAccount } from '../../shared/harnesses';
import type { Mutate } from '../api';
import { Dialog, FormError } from './primitives';
import { harnessName } from '../lib/format';

export function RoutingPanel({
  work,
  data,
  mutate,
}: {
  work: Work;
  data: Snapshot;
  mutate: Mutate;
}) {
  const [review, setReview] = useState<RouteReview | null>(null);
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const [pool, setPool] = useState<string[]>([]),
    [metered, setMetered] = useState(false),
    [unknown, setUnknown] = useState(false);
  const [age, setAge] = useState(300),
    [reconciled, setReconciled] = useState(false),
    [paths, setPaths] = useState('');
  const available = data.accounts.filter(canExecuteAccount);
  async function load() {
    try {
      setReview(await mutate<RouteReview>(`/work/${work.id}/route`, 'GET'));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  useEffect(() => {
    if (data.mode === 'local') void load();
  }, [work.id, work.revision]);
  if (data.mode !== 'local') return null;
  function edit() {
    setPool(review?.policy?.accountIds ?? (work.accountId ? [work.accountId] : []));
    setMetered(review?.policy?.allowMetered ?? false);
    setUnknown(review?.policy?.allowUnreportedQuota ?? false);
    setAge(review?.policy?.maxEvidenceAgeSeconds ?? 300);
    setError('');
    setEditing(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy('save');
    setError('');
    try {
      await mutate(`/work/${work.id}/route`, 'PUT', {
        expectedRevision: work.revision,
        expectedPolicyRevision: review?.policy?.revision ?? 0,
        accountIds: pool,
        allowMetered: metered,
        allowUnreportedQuota: unknown,
        maxEvidenceAgeSeconds: age,
      });
      setEditing(false);
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function refresh() {
    setBusy('refresh');
    setError('');
    try {
      setReview(await mutate<RouteReview>(`/work/${work.id}/route/refresh`, 'POST'));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function prepare() {
    if (!review?.planId) return;
    setBusy('prepare');
    setError('');
    try {
      await mutate(`/work/${work.id}/route/prepare`, 'POST', {
        planId: review.planId,
        digest: review.digest,
        reconciled,
        ...(paths.trim()
          ? {
              paths: paths
                .split('\n')
                .map((path) => path.trim())
                .filter(Boolean),
            }
          : {}),
      });
      setReconciled(false);
      await load();
    } catch (cause) {
      setError((cause as Error).message);
      await load();
    } finally {
      setBusy('');
    }
  }
  async function remove() {
    setBusy('remove');
    setError('');
    try {
      await mutate(`/work/${work.id}/route`, 'DELETE', { expectedRevision: work.revision });
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }
  function reorder(index: number, direction: number) {
    const changed = [...pool];
    [changed[index], changed[index + direction]] = [changed[index + direction], changed[index]];
    setPool(changed);
  }
  const chosen = data.accounts.find((account) => account.id === review?.recommendedAccountId);
  const needsHandoff = Boolean(work.nativeSessionId || work.capsuleId || work.generation);
  return (
    <section className="detail-section" aria-label="Account routing">
      <div className="section-heading">
        <div>
          <h3>Account routing</h3>
          <p>
            {review?.policy
              ? `${review.policy.accountIds.length} authorized slots, in preference order.`
              : 'Choose an ordered pool for this project and profile.'}
          </p>
        </div>
        <button
          className="text-button"
          disabled={Boolean(work.activeRunId) || Boolean(busy) || !available.length}
          onClick={edit}
        >
          {review?.policy ? 'Edit route' : 'Set account route'}
        </button>
      </div>
      {review?.policy && (
        <>
          <p>
            {chosen
              ? `Recommended: ${chosen.label}.`
              : 'No authorized account currently meets this route.'}{' '}
            {review.policy.allowMetered
              ? 'Metered billing permitted.'
              : 'Metered billing excluded.'}
          </p>
          <ol className="routing-list">
            {review.candidates.map((candidate) => (
              <li key={candidate.accountId}>
                <strong>{candidate.label}</strong>
                <span>
                  {harnessName(candidate.harness)} ·{' '}
                  {candidate.eligible ? 'Eligible' : candidate.reasons.join(' ')}
                  {candidate.sharedIdentity
                    ? ' · Shares a native identity; adds no independent limit.'
                    : ''}
                </span>
              </li>
            ))}
          </ol>
          <button
            className="text-button"
            disabled={Boolean(busy) || Boolean(work.activeRunId)}
            onClick={() => void refresh()}
          >
            {busy === 'refresh' ? 'Reading native status' : 'Refresh native evidence'}
          </button>
          {chosen && chosen.id !== work.accountId && (
            <div className="form-stack">
              {needsHandoff && (
                <>
                  <p className="source-note">
                    This uses the existing verified checkpoint and handoff. Goals, files, profile
                    and work history stay attached. Native hidden state follows the target harness’s
                    supported continuation.
                  </p>
                  <label>
                    Checkpoint files, one relative path per line (optional for Git projects)
                    <textarea
                      rows={2}
                      value={paths}
                      onChange={(event) => setPaths(event.target.value)}
                    />
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={reconciled}
                      onChange={(event) => setReconciled(event.target.checked)}
                    />
                    <span>
                      I reviewed native activity and external effects before moving this work.
                    </span>
                  </label>
                </>
              )}
              <button
                className="button secondary small"
                disabled={
                  Boolean(busy) || Boolean(work.activeRunId) || (needsHandoff && !reconciled)
                }
                onClick={() => void prepare()}
              >
                {busy === 'prepare'
                  ? 'Preparing native binding'
                  : `Use recommended account: ${chosen.label}`}
              </button>
            </div>
          )}
          <details className="native-details">
            <summary>Routing scope and controls</summary>
            <p className="source-note">
              This exact project directory and profile are authorized. Native home, credential
              reference, identity or model changes require a new review. Evidence is valid for{' '}
              {review.policy.maxEvidenceAgeSeconds} seconds. Shared buckets are never added
              together. Refresh performs at most four sequential native checks and creates no
              resident router. Failed or interrupted native work is never retried automatically.
            </p>
            <button
              className="text-button"
              disabled={Boolean(busy) || Boolean(work.activeRunId)}
              onClick={() => void remove()}
            >
              Remove account route
            </button>
          </details>
        </>
      )}
      <FormError error={error} />
      {editing && (
        <Dialog title="Authorize account routing" onClose={() => setEditing(false)}>
          <form className="dialog-form" onSubmit={save}>
            <div className="dialog-body form-stack">
              <p>
                Choose the accounts that may receive this work’s project, profile and selected
                context. Forge recommends the first eligible slot. Native permissions and billing
                stay with each account.
              </p>
              <p className="path-line">
                <code>{work.cwd}</code>
              </p>
              <ol className="routing-list">
                {pool.map((accountId, index) => {
                  const account = data.accounts.find((value) => value.id === accountId);
                  return (
                    <li key={accountId}>
                      <strong>{account?.label ?? 'Missing account'}</strong>
                      <span>
                        {account ? harnessName(account.harness) : 'Reconnect before saving.'}
                      </span>
                      <div className="routing-actions">
                        <button
                          className="text-button"
                          type="button"
                          disabled={index === 0}
                          onClick={() => reorder(index, -1)}
                          aria-label={`Move ${account?.label ?? accountId} earlier`}
                        >
                          Earlier
                        </button>
                        <button
                          className="text-button"
                          type="button"
                          disabled={index === pool.length - 1}
                          onClick={() => reorder(index, 1)}
                          aria-label={`Move ${account?.label ?? accountId} later`}
                        >
                          Later
                        </button>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setPool(pool.filter((key) => key !== accountId))}
                          aria-label={`Remove ${account?.label ?? accountId} from route`}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <label>
                Add native account
                <select
                  value=""
                  onChange={(event) => {
                    if (event.target.value) setPool([...pool, event.target.value]);
                  }}
                >
                  <option value="">Choose another slot</option>
                  {available
                    .filter((account) => !pool.includes(account.id))
                    .map((account: Account) => (
                      <option key={account.id} value={account.id}>
                        {account.label} · {harnessName(account.harness)}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Maximum native evidence age, seconds
                <input
                  type="number"
                  min={30}
                  max={900}
                  value={age}
                  required
                  onChange={(event) => setAge(Number(event.target.value))}
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={metered}
                  onChange={(event) => setMetered(event.target.checked)}
                />
                <span>
                  Allow accounts with API, external-provider or unverifiable native billing.
                </span>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={unknown}
                  onChange={(event) => setUnknown(event.target.checked)}
                />
                <span>
                  Allow unreported quota or identity evidence. Unknown allowance can fail at the
                  native provider; reported exhausted buckets remain excluded.
                </span>
              </label>
              <p className="source-note">
                Check accounts natively before saving to pin their current identities. Saving starts
                no worker or model request. Budget admission and launch context review still apply.
              </p>
              <FormError error={error} />
            </div>
            <div className="form-footer">
              <button type="button" className="button secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                className="button primary"
                disabled={Boolean(busy) || pool.length === 0 || pool.length > 16}
              >
                {busy === 'save' ? 'Saving' : 'Authorize route'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
