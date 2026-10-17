import { type Work, type Account, type ContextReview } from '../../shared/types';
import { type Mutate } from '../api';
import { useState, useEffect, type FormEvent } from 'react';
import { Dialog, HarnessMark, FormError } from './primitives';
import { Folder, ShieldCheck, LoaderCircle, Play } from 'lucide-react';
import { executionName, canExecuteAccount } from '../../shared/harnesses';

export function LaunchDialog({
  work,
  account,
  mutate,
  onClose,
  onLaunched,
}: {
  work: Work;
  account?: Account;
  mutate: Mutate;
  onClose: () => void;
  onLaunched: () => void;
}) {
  const [metered, setMetered] = useState(false);
  const [reconciled, setReconciled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<ContextReview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  async function readContext() {
    setReading(true);
    setError('');
    setReview(null);
    setConfirmed(false);
    try {
      const result = await mutate<ContextReview>(`/work/${work.id}/context-review`, 'POST');
      setReview(result);
      setConfirmed(work.contextReceipt?.contentDigest === result.receipt.contentDigest);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setReading(false);
    }
  }
  useEffect(() => {
    void readContext();
  }, [work.id, work.revision]);
  const needsReview = ['failed', 'interrupted'].includes(work.status);
  const claude = work.harness === 'claude';
  const opencode = work.harness === 'opencode';
  const hermes = work.harness === 'hermes';
  const openclaw = work.harness === 'openclaw';
  const requiresMetered = claude || opencode || hermes || openclaw;
  const compatible = canExecuteAccount(account);
  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await mutate(`/work/${work.id}/launch`, 'POST', {
        expectedRevision: work.revision,
        allowMetered: metered,
        reconciled,
        contextDigest: review?.receipt.reviewDigest,
      });
      onLaunched();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Ready to use the native harness?"
      subtitle={`START A ${executionName(work.harness).toUpperCase()} ATTEMPT`}
      onClose={onClose}
    >
      <form className="dialog-body form-stack" onSubmit={start}>
        <div className="binding-box">
          <HarnessMark harness={work.harness} />
          <div>
            <strong>{account?.label}</strong>
            <p>
              {account?.identity ??
                (opencode || hermes || openclaw
                  ? 'Native profile and model are checked before input. Provider identity and quotas remain unknown.'
                  : 'Native identity will be checked before the turn starts.')}
            </p>
          </div>
        </div>
        <p>
          <strong>{work.title}</strong>
        </p>
        <p>
          {executionName(work.harness)} receives this task's goal, acceptance criteria, context and
          checkpoints, with access to the selected project. Native tools and permission rules apply.
          Supported permission requests arrive in Forge.
        </p>
        <div className="path-line">
          <Folder size={16} />
          <code>{work.cwd}</code>
        </div>
        <section className="memory-launch-review">
          <h3>{review ? `Profile: ${review.receipt.profileName}` : 'Reading selected context'}</h3>
          {review && (
            <>
              <p className="source-note">
                {review.memories.length} applicable memory{' '}
                {review.memories.length === 1 ? 'reference' : 'references'}.{' '}
                {review.skipped.length
                  ? `${review.skipped.length} references outside this scope were excluded.`
                  : 'Native sources are checked again when you launch.'}
              </p>
              {work.nativeSessionId &&
                work.contextReceipt?.contentDigest !== review.receipt.contentDigest &&
                (work.contextReceipt || review.requiresReview) && (
                  <p className="source-note">
                    Selected memory changed. This launch starts a fresh native conversation and
                    retains the earlier work history.
                  </p>
                )}
              {review.instructions && (
                <details className="native-details">
                  <summary>Profile instructions</summary>
                  <pre className="memory-excerpt">{review.instructions}</pre>
                </details>
              )}
              {review.memories.map((memory) => (
                <details key={memory.sourceId} className="native-details">
                  <summary>{memory.label}</summary>
                  <pre className="memory-excerpt" tabIndex={0}>
                    {memory.content}
                  </pre>
                </details>
              ))}
              {review.requiresReview && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>I reviewed this profile and selected memory for the native launch.</span>
                </label>
              )}
            </>
          )}
          <button
            type="button"
            className="text-button"
            disabled={reading}
            onClick={() => void readContext()}
          >
            {reading && <LoaderCircle size={14} className="spin" />}Refresh context review
          </button>
        </section>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={metered}
            onChange={(e) => setMetered(e.target.checked)}
            required={requiresMetered}
          />
          <span>
            Allow metered API, external-provider billing, or additional credits for this launch.
            <small>Provider charges are separate from any reported cost estimate.</small>
          </span>
        </label>
        {needsReview && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={reconciled}
              onChange={(e) => setReconciled(e.target.checked)}
              required
            />
            <span>
              I reviewed the previous native attempt, detached tools, and external effects before
              retrying.
            </span>
          </label>
        )}
        <div className="notice">
          <ShieldCheck size={18} />
          <p>
            {openclaw
              ? compatible
                ? 'OpenClaw owns its native tools, memory and model routing. This dedicated Gateway uses guarded permissions: file operations inside the project can run without a prompt. Supported exact command approvals appear here. Existing companion channels and schedules retain their native owner.'
                : 'Choose an explicit dedicated OpenClaw execution profile and native or API billing. Subscription allowance cannot be verified.'
              : hermes
                ? compatible
                  ? 'Hermes owns its tools, skills, memory and provider settings. Native default edit review is checked before input; native command policies still apply. Requests can expire in under a minute. Provider identity, allowance and final task acceptance remain separate.'
                  : 'Choose an explicit Hermes home and native or API billing. Forge cannot require an unverified subscription allowance.'
                : opencode
                  ? compatible
                    ? 'OpenCode v2 owns tools and native permissions. Session allow rules request review while native denials stay in order. These permissions use your host authority. Provider billing and saved native grants remain native.'
                    : 'Choose an explicit OpenCode profile root and native or API billing. Forge cannot verify or require subscription allowance for this route.'
                  : claude
                    ? compatible
                      ? 'This route uses API authentication and native manual permission mode. Existing native rules can allow tools without a prompt. API credentials stay in the referenced environment variable.'
                      : 'Managed Claude turns require an API slot. Native claude.ai subscription sessions continue through their native client under Anthropic’s integration rules.'
                    : 'Forge requests the native untrusted approval policy and workspace-write sandbox. Launch stops if the server does not confirm these settings.'}
          </p>
        </div>
        <FormError error={error} />
        <div className="form-footer">
          <button className="button secondary" type="button" onClick={onClose}>
            Keep as ready
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              !compatible ||
              !review ||
              reading ||
              (review.requiresReview && !confirmed) ||
              (requiresMetered && !metered) ||
              (needsReview && !reconciled)
            }
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}Start native
            attempt
          </button>
        </div>
      </form>
    </Dialog>
  );
}
