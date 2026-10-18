import { useState, type FormEvent } from 'react';
import type { NativeSession, Snapshot, Work } from '../../shared/types';
import type { NativeContinuationReview } from '../../shared/native-continuations';
import type { Mutate } from '../api';
import { Dialog, FormError } from './primitives';

export interface NativeContinuationDraft {
  title: string;
  goal: string;
  profileId: string;
}

export function NativeContinuationDialog({
  session,
  work,
  draft,
  data,
  mutate,
  onClose,
  onCreated,
  onLinkAccount,
}: {
  session: NativeSession;
  work?: Work;
  draft?: NativeContinuationDraft;
  data: Snapshot;
  mutate: Mutate;
  onClose: () => void;
  onCreated: (work: Work) => void;
  onLinkAccount: (home: string, draft: NativeContinuationDraft) => void;
}) {
  const source = data.nativeSources.find((row) => row.id === session.sourceId);
  const accounts = data.accounts.filter(
    (account) =>
      account.harness === 'codex' &&
      !account.backend &&
      !account.connector &&
      !account.nativeProvider &&
      account.nativeHome,
  );
  const [accountId, setAccountId] = useState(
    work?.accountId ??
      accounts.find((account) => account.nativeHome === source?.home)?.id ??
      accounts[0]?.id ??
      '',
  );
  const [profileId, setProfileId] = useState(
    draft?.profileId ?? work?.profileId ?? data.defaultProfileId,
  );
  const [title, setTitle] = useState(
    draft?.title ?? work?.title ?? (session.title || 'Continue native chat').slice(0, 140),
  );
  const [goal, setGoal] = useState(
    draft?.goal ??
      work?.goal ??
      'Continue this native conversation and reconcile its current project artifacts.',
  );
  const [review, setReview] = useState<NativeContinuationReview | null>(null),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!review) {
        setReview(
          await mutate<NativeContinuationReview>('/native/continuations/prepare', 'POST', {
            sourceId: session.sourceId,
            sessionId: session.id,
            accountId,
            profileId,
            title,
            goal,
            ...(work ? { workId: work.id, expectedRevision: work.revision } : {}),
          }),
        );
        setConsent(false);
      } else {
        onCreated(
          await mutate<Work>('/native/continuations', 'POST', {
            id: review.id,
            digest: review.digest,
            nativeActivityReviewed: consent,
          }),
        );
      }
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Continue native chat" onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <div className="dialog-body form-stack">
          {!review ? (
            <>
              <p>
                Keep this Codex conversation in a separate native fork. Your next managed launch
                verifies its complete stored history and uses Forge’s normal approval and resource
                controls.
              </p>
              <p className="source-note">
                Use the same native profile as the source. Linking creates no fork or model turn.
                Source workers, approvals and external effects retain their native owner.
              </p>
              <label>
                Work title
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={140}
                  required
                />
              </label>
              <label>
                Next goal
                <textarea
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  maxLength={20000}
                  required
                  rows={3}
                />
              </label>
              {accounts.length ? (
                <label>
                  Native account
                  <select
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                    disabled={Boolean(work)}
                    required
                  >
                    {accounts.map((account) => (
                      <option value={account.id} key={account.id}>
                        {account.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <p>
                    Link a Codex account using this source’s native profile to continue its history.
                  </p>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => onLinkAccount(source?.home ?? '', { title, goal, profileId })}
                  >
                    Link a Codex account
                  </button>
                </>
              )}
              {accounts.length > 0 && !work && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onLinkAccount(source?.home ?? '', { title, goal, profileId })}
                >
                  Link another Codex account
                </button>
              )}
              <label>
                Persistent profile
                <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                  {data.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              {source?.home && (
                <details className="native-details">
                  <summary>Source native profile</summary>
                  <p className="runtime-path">{source.home}</p>
                </details>
              )}
            </>
          ) : (
            <>
              <p>
                {review.source.turns} complete native {review.source.turns === 1 ? 'turn' : 'turns'}{' '}
                · {review.source.items} {review.source.items === 1 ? 'item' : 'items'} ·{' '}
                {review.source.modelProvider}
              </p>
              <div className="launch-context">
                <strong>{review.title}</strong>
                <p>{review.goal}</p>
                <p>
                  {review.account.label} ·{' '}
                  {review.account.identity ?? 'Native identity unavailable'} · {review.profileName}
                </p>
                <p className="runtime-path">{review.source.cwd}</p>
              </div>
              <p className="source-note">
                At launch, Codex copies and verifies these turns, resets the fork’s goal and
                permission review, and counts only new tokens. Tools and project instructions stay
                native.
              </p>
              <p className="source-note">
                Settle the source’s workers, approvals and external effects before launching. A
                stored chat cannot confirm their status.
              </p>
              <details className="native-details">
                <summary>Native history boundary</summary>
                <p className="runtime-path">{review.source.threadId}</p>
                <p className="runtime-path">Through turn {review.source.lastTurnId}</p>
                <p className="runtime-path">SHA-256 {review.source.digest}</p>
              </details>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I reviewed the source’s native workers, pending approvals and external effects and
                will settle them before launching.
              </label>
            </>
          )}
          <FormError error={error} />
        </div>
        <div className="form-footer">
          <button
            type="button"
            className="button secondary"
            onClick={
              review
                ? () => {
                    setReview(null);
                    setConsent(false);
                    setError('');
                  }
                : onClose
            }
          >
            {review ? 'Back' : 'Cancel'}
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={
              busy || !accountId || !title.trim() || !goal.trim() || Boolean(review && !consent)
            }
          >
            {busy
              ? review
                ? 'Linking work…'
                : 'Reading native history…'
              : review
                ? work
                  ? 'Update work review'
                  : 'Link work'
                : 'Review native history'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
