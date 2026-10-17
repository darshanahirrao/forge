import { useState, useEffect, useRef } from 'react';
import type { Account, Work, WorkCapsule } from '../../shared/types';
import { canExecuteAccount } from '../../shared/harnesses';
import { type Mutate, download } from '../api';
import { Dialog, FormError, HarnessMark } from './primitives';
import { ArrowRightLeft, Check, FolderCheck, LoaderCircle, ArrowDownToLine } from 'lucide-react';
import { harnessName } from '../lib/format';

export function HandoffDialog({
  work,
  accounts,
  mutate,
  onClose,
  onMoved,
}: {
  work: Work;
  accounts: Account[];
  mutate: Mutate;
  onClose: () => void;
  onMoved: () => void;
}) {
  const eligible = accounts.filter((a) => a.id !== work.accountId && canExecuteAccount(a));
  const [target, setTarget] = useState(eligible[0]?.id ?? '');
  const [paths, setPaths] = useState('');
  const [prepared, setPrepared] = useState<{ capsule: WorkCapsule; work: Work } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const review = useRef<HTMLElement>(null);
  const destinationSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (prepared) review.current?.focus();
    else destinationSelect.current?.focus();
  }, [prepared?.capsule.id]);
  const destination = accounts.find((a) => a.id === target);
  const stale = prepared && work.revision > prepared.work.revision;
  async function prepare() {
    setBusy('prepare');
    setError('');
    setPrepared(null);
    setReviewed(false);
    try {
      const selected = paths
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean);
      setPrepared(
        await mutate(`/work/${work.id}/capsules`, 'POST', {
          expectedRevision: work.revision,
          ...(selected.length ? { paths: selected } : {}),
        }),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function move() {
    if (!prepared) return;
    setBusy('move');
    setError('');
    try {
      await mutate(`/work/${work.id}/handoff`, 'POST', {
        expectedRevision: prepared.work.revision,
        capsuleId: prepared.capsule.id,
        targetAccountId: target,
        reconciled: reviewed,
      });
      onMoved();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <Dialog
      title="Keep the work. Change the harness."
      subtitle="VERIFIED HANDOFF"
      onClose={onClose}
    >
      <div className="dialog-body form-stack">
        <p className="form-intro">
          The same work record, goal, checkpoints, files and usage history stay together. The next
          account starts a fresh native session with its own permissions. Original native sessions
          remain linked in the timeline.
        </p>
        {!prepared && (
          <>
            <div className="binding-box">
              <HarnessMark harness={work.harness} />
              <div>
                <strong>{work.title}</strong>
                <p>
                  {accounts.find((a) => a.id === work.accountId)?.label ??
                    harnessName(work.harness)}
                </p>
              </div>
            </div>
            <label>
              Continue with
              <select
                ref={destinationSelect}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={Boolean(busy)}
              >
                {eligible.length ? (
                  eligible.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} · {harnessName(a.harness)}
                    </option>
                  ))
                ) : (
                  <option value="">Add another compatible native account first</option>
                )}
              </select>
            </label>
            {destination && (
              <small>
                Native credentials and access are checked again on launch. Selecting an account does
                not start a worker or permit metered spending.
              </small>
            )}
            <label>
              Files to verify <span className="optional">Optional</span>
              <textarea
                rows={3}
                value={paths}
                onChange={(e) => {
                  setPaths(e.target.value);
                  setPrepared(null);
                  setReviewed(false);
                }}
                placeholder={
                  'Leave empty to use the project’s Git inventory.\nFor a custom selection: one relative file path per line.'
                }
                disabled={Boolean(busy)}
              />
              <small>
                Git includes tracked and nonignored files. A custom selection verifies only the
                listed files. Credentials and runtime data are excluded.
              </small>
            </label>
          </>
        )}
        {prepared && (
          <section
            ref={review}
            tabIndex={-1}
            className="form-stack"
            aria-label="Prepared handoff checkpoint"
          >
            {destination && (
              <div className="binding-box">
                <HarnessMark harness={destination.harness} />
                <div>
                  <strong>{destination.label}</strong>
                  <p>
                    {harnessName(destination.harness)} ·{' '}
                    {destination.backend &&
                    accounts.find((account) => account.id === work.accountId)?.backend?.id ===
                      destination.backend.id
                      ? 'T3 manages native continuation'
                      : 'A new native session'}
                  </p>
                </div>
              </div>
            )}
            <div className="notice">
              <Check size={18} />
              <p>
                <strong>
                  {prepared.capsule.artifacts.length} file{' '}
                  {prepared.capsule.artifacts.length === 1 ? 'state' : 'states'} verified.
                </strong>{' '}
                {prepared.capsule.checkpoints.length} user{' '}
                {prepared.capsule.checkpoints.length === 1 ? 'checkpoint' : 'checkpoints'} and{' '}
                {prepared.capsule.results.length} recent result{' '}
                {prepared.capsule.results.length === 1 ? 'excerpt' : 'excerpts'} carry forward.
              </p>
            </div>
            <details className="native-details checkpoint-files">
              <summary>Context carried forward</summary>
              <p className="source-note">{prepared.capsule.coverage}</p>
            </details>
            <details className="native-details checkpoint-files">
              <summary>Verified files and exclusions</summary>
              <ul>
                {prepared.capsule.artifacts.slice(0, 50).map((a) => (
                  <li key={a.path}>
                    <code>{a.path}</code> ·{' '}
                    {a.state === 'missing'
                      ? 'Verified absent'
                      : `${a.bytes.toLocaleString()} bytes`}
                  </li>
                ))}
                {prepared.capsule.artifacts.length > 50 && (
                  <li>More files are included in the downloadable checkpoint.</li>
                )}
                {prepared.capsule.excluded.slice(0, 50).map((e) => (
                  <li key={e.path}>
                    <code>{e.path}</code> · Excluded: {e.reason}
                  </li>
                ))}
                {prepared.capsule.excluded.length > 50 && (
                  <li>More exclusions are listed in the downloadable checkpoint.</li>
                )}
              </ul>
            </details>
            <button
              className="text-button"
              onClick={() =>
                void download(
                  `/work/${work.id}/capsules/${prepared.capsule.id}`,
                  `forge-checkpoint-${prepared.capsule.id}.json`,
                  'local',
                ).catch((error) => setError((error as Error).message))
              }
            >
              <ArrowDownToLine size={15} />
              Download this work checkpoint
            </button>
            <button
              className="text-button"
              onClick={() => {
                setPrepared(null);
                setReviewed(false);
                setError('');
              }}
            >
              Change destination or files
            </button>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              <span>
                I reviewed native activity, detached tools and external effects at this checkpoint.
                <small>
                  Forge confirms its worker exited. Other processes and external actions need their
                  own reconciliation.
                </small>
              </span>
            </label>
            {stale && (
              <p className="form-error" role="alert">
                This work changed. Prepare a fresh checkpoint before switching.
              </p>
            )}
          </section>
        )}
        <FormError error={error} />
        <div className="form-footer handoff-footer">
          <button className="button secondary" onClick={onClose} disabled={Boolean(busy)}>
            Keep current binding
          </button>
          {prepared ? (
            <button
              className="button primary"
              onClick={() => void move()}
              disabled={!prepared || !reviewed || !destination || Boolean(busy) || Boolean(stale)}
            >
              {busy === 'move' ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <ArrowRightLeft size={16} />
              )}
              Switch at this checkpoint
            </button>
          ) : (
            <button
              className="button primary"
              disabled={Boolean(busy) || !destination}
              onClick={() => void prepare()}
            >
              {busy === 'prepare' ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <FolderCheck size={16} />
              )}
              Prepare checkpoint
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
