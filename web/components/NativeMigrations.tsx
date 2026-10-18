import { useState } from 'react';
import { ArrowRightLeft, LoaderCircle } from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import type { NativeMigrationReview } from '../../shared/native-migrations';
import type { Mutate } from '../api';
import { request } from '../api';
import { Dialog, FormError } from './primitives';
import { harnessName } from '../lib/format';
import { canExecuteAccount } from '../../shared/harnesses';

export function NativeMigrations({
  data,
  mutate,
  onHandoff,
}: {
  data: Snapshot;
  mutate: Mutate;
  onHandoff: (workId: string, accountId: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [review, setReview] = useState<NativeMigrationReview | null>(null),
    [source, setSource] = useState(''),
    [label, setLabel] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [accepted, setAccepted] = useState(false),
    [reuse, setReuse] = useState(false),
    [workId, setWorkId] = useState('');
  const [projectRoot, setProjectRoot] = useState('');
  const continuations = data.work.filter(
    (work) =>
      work.accountId === review?.sourceAccountId &&
      !work.activeRunId &&
      (review?.state !== 'activated' ||
        canExecuteAccount(data.accounts.find((account) => account.id === review.accountId))) &&
      (review?.state !== 'activated' ||
        review.targetHarness !== 'openclaw' ||
        review.reviewedProjectRoot === work.cwd),
  );
  const sources = data.accounts.filter(
      (account) =>
        !account.backend &&
        !account.connector &&
        account.nativeHome &&
        ['hermes', 'openclaw'].includes(account.harness),
    ),
    chosen = sources.find((account) => account.id === (source || sources[0]?.id)),
    local = data.mode === 'local' && data.access?.kind === 'local',
    supported = data.nativeMigrations?.supported === true,
    rows = data.nativeMigrations?.rows.filter((row) => row.state !== 'dismissed') ?? [];
  const close = () => {
    if (!busy) {
      setOpen(false);
      setReview(null);
      setError('');
      setAccepted(false);
      setReuse(false);
      setWorkId('');
      setProjectRoot('');
    }
  };
  const show = async (identifier: string) => {
    setError('');
    setBusy(true);
    try {
      const result = await request<NativeMigrationReview>(
        `/native/migrations/${identifier}`,
        data.mode,
      );
      setReview(result);
      setAccepted(false);
      setReuse(false);
      setProjectRoot('');
      setOpen(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel" aria-label="Native profile imports">
      <div className="section-heading">
        <div>
          <h2>Native profile imports</h2>
          <p>Carry native memory, instructions and compatible skills into another runtime.</p>
        </div>
        <button
          className="button secondary small"
          disabled={
            !local ||
            !supported ||
            busy ||
            !sources.length ||
            rows.some((row) => row.state === 'preparing')
          }
          onClick={() => {
            setReview(null);
            setError('');
            setAccepted(false);
            setReuse(false);
            setOpen(true);
          }}
        >
          <ArrowRightLeft size={14} />
          Import native profile
        </button>
      </div>
      {!sources.length && (
        <p className="source-note">
          Add an existing Hermes or OpenClaw account to choose its native profile.
        </p>
      )}
      {!local && (
        <p className="source-note">Prepare and activate native profiles on the local Forge host.</p>
      )}
      {rows.length > 0 && (
        <div className="native-entry-list">
          {rows.map((row) => (
            <article className="native-entry" key={row.id}>
              <div className="native-entry-copy">
                <h3>
                  {row.label} · {row.state}
                </h3>
                <p>
                  {harnessName(row.sourceHarness)} to {harnessName(row.targetHarness)}
                </p>
                <p>{row.detail}</p>
                {row.summary && (
                  <small>
                    {row.summary.imported} imported · {row.summary.archived} archived ·{' '}
                    {row.summary.skipped} skipped · {row.summary.overflowed} memory entries
                    overflowed
                  </small>
                )}
              </div>
              <button
                className="button secondary small"
                disabled={!local || busy || row.state === 'preparing'}
                onClick={() => void show(row.id)}
              >
                Review import
              </button>
            </article>
          ))}
        </div>
      )}
      <FormError error={open ? '' : error} />
      {open && (
        <Dialog
          title={review ? 'Review native profile import' : 'Import native profile'}
          subtitle="NATIVE MIGRATION"
          onClose={close}
        >
          <form
            className="dialog-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError('');
              try {
                if (!review) {
                  if (!chosen) return;
                  const result = await mutate<NativeMigrationReview>(
                    '/native/migrations/prepare',
                    'POST',
                    {
                      sourceAccountId: chosen.id,
                      label:
                        label.trim() ||
                        `${chosen.label} · ${chosen.harness === 'hermes' ? 'OpenClaw' : 'Hermes'}`,
                    },
                  );
                  setReview(result);
                  setAccepted(false);
                  setReuse(false);
                } else if (review.state === 'ready') {
                  await mutate(`/native/migrations/${review.id}/activate`, 'POST', {
                    revision: review.revision,
                    digest: review.digest,
                    reviewed: true,
                    reuseCredentialReference: reuse,
                    ...(projectRoot.trim() ? { openClawProjectRoot: projectRoot.trim() } : {}),
                  });
                  setReview(
                    await request<NativeMigrationReview>(
                      `/native/migrations/${review.id}`,
                      data.mode,
                    ),
                  );
                }
              } catch (cause) {
                setError((cause as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="dialog-body form-stack">
              {!review ? (
                <>
                  <label>
                    Source native account
                    <select
                      value={chosen?.id ?? ''}
                      onChange={(event) => {
                        setSource(event.target.value);
                        setLabel('');
                      }}
                    >
                      {sources.map((account) => (
                        <option value={account.id} key={account.id}>
                          {account.label} · {harnessName(account.harness)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    New account label
                    <input
                      value={label}
                      maxLength={80}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder={
                        chosen
                          ? `${chosen.label} · ${chosen.harness === 'hermes' ? 'OpenClaw' : 'Hermes'}`
                          : 'Native account'
                      }
                    />
                  </label>
                  <p>
                    Prepare a separate {chosen?.harness === 'hermes' ? 'OpenClaw' : 'Hermes'}{' '}
                    profile using its installed native importer. The original profile stays in
                    place. Stop its managed native owner before preparing.
                  </p>
                  <p className="source-note">
                    Native shared skills and compatible configuration may be included. Review
                    imported permissions, archived items and memory limits before adding the new
                    account. Credentials and scheduled jobs are not activated by preparation.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    <strong>{review.label}</strong> · {harnessName(review.sourceHarness)} to{' '}
                    {harnessName(review.targetHarness)}
                  </p>
                  <p>{review.detail}</p>
                  {review.summary && (
                    <p>
                      {review.summary.imported} imported · {review.summary.archived} archived ·{' '}
                      {review.summary.skipped} skipped · {review.summary.overflowed} memory entries
                      overflowed
                    </p>
                  )}
                  {!!review.summary?.overflowed && (
                    <p className="inline-note">
                      The target native memory limit kept some entries in its overflow archive.
                      Those entries are preserved but are not active native memory.
                    </p>
                  )}
                  <details className="native-details">
                    <summary>Native items and private paths</summary>
                    <p className="source-note">
                      {review.nativeVersion ?? 'Native importer unavailable'}
                    </p>
                    <p>
                      Private profile<code className="native-rule">{review.nativeHome}</code>
                    </p>
                    <p>
                      Native report<code className="native-rule">{review.reportPath}</code>
                    </p>
                    {review.items.map((item, index) => (
                      <div className="form-stack" key={index}>
                        <strong>
                          {item.kind} · {item.status}
                        </strong>
                        {item.note && <p>{item.note}</p>}
                        {item.target && <code className="native-rule">{item.target}</code>}
                      </div>
                    ))}
                  </details>
                  {review.state === 'ready' && (
                    <>
                      {review.targetHarness === 'openclaw' && (
                        <label>
                          Native project directory <span className="optional">Optional</span>
                          <input
                            value={projectRoot}
                            onChange={(event) => setProjectRoot(event.target.value)}
                            placeholder={continuations[0]?.cwd || '/absolute/project/path'}
                          />
                          <small>
                            Permit guarded sessions in this exact project while keeping imported
                            memory in its private native workspace. The dedicated Gateway needs
                            native administrator API scope for this project. Other project
                            directories are refused.
                          </small>
                        </label>
                      )}
                      <p className="source-note">
                        Native memory and skills belong to this copied profile. Native archives,
                        chat histories, external memory engines, channels and schedules retain the
                        coverage shown above. Adding the account does not switch running work or
                        start a gateway. Native entry grouping and correction behavior can differ.
                      </p>
                      {review.credentialsAvailable && (
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={reuse}
                            onChange={(event) => setReuse(event.target.checked)}
                          />
                          Reuse the source provider credential reference
                        </label>
                      )}
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={accepted}
                          onChange={(event) => setAccepted(event.target.checked)}
                        />
                        I reviewed imported permissions, memory limits and archived items.
                      </label>
                    </>
                  )}
                  {review.state === 'activated' && continuations.length > 0 && (
                    <label>
                      Continue existing work
                      <select
                        value={workId || continuations[0]?.id || ''}
                        onChange={(event) => setWorkId(event.target.value)}
                      >
                        {continuations.map((work) => (
                          <option key={work.id} value={work.id}>
                            {work.title}
                          </option>
                        ))}
                      </select>
                      <small>
                        Prepare the existing work checkpoint next. Its history and profile stay
                        together; review native effects before switching.
                      </small>
                    </label>
                  )}
                  {review.state === 'activated' &&
                    review.targetHarness === 'openclaw' &&
                    !review.reviewedProjectRoot && (
                      <p className="source-note">
                        This account is ready for native setup. To continue project work here, link
                        a slot to this private profile using Add account and Reviewed native
                        project.
                      </p>
                    )}
                </>
              )}
              <FormError error={error} />
            </div>
            <footer className="form-footer">
              <button type="button" className="button secondary" disabled={busy} onClick={close}>
                Close
              </button>
              {review && ['ready', 'failed'].includes(review.state) && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      await mutate(`/native/migrations/${review.id}/dismiss`, 'POST', {
                        revision: review.revision,
                      });
                      setBusy(false);
                      close();
                    } catch (cause) {
                      setError((cause as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Dismiss
                </button>
              )}
              {(!review || review.state === 'ready') && (
                <button className="button primary" disabled={busy || Boolean(review && !accepted)}>
                  {busy ? (
                    <>
                      <LoaderCircle size={16} className="spin" />
                      Working…
                    </>
                  ) : review ? (
                    'Add account'
                  ) : (
                    'Prepare native profile'
                  )}
                </button>
              )}
              {review?.state === 'activated' && review.accountId && continuations.length > 0 && (
                <button
                  className="button primary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    onHandoff(workId || continuations[0].id, review.accountId!);
                    close();
                  }}
                >
                  Continue existing work
                </button>
              )}
            </footer>
          </form>
        </Dialog>
      )}
    </section>
  );
}
