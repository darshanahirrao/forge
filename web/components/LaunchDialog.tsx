import {
  type Work,
  type Account,
  type ContextReview,
  type MemoryPressure,
} from '../../shared/types';
import { type Mutate } from '../api';
import { useState, useEffect, useRef, type FormEvent } from 'react';
import { Dialog, HarnessMark, FormError } from './primitives';
import { Folder, ShieldCheck, LoaderCircle, Play } from 'lucide-react';
import { executionName, canExecuteAccount } from '../../shared/harnesses';
import type { SpendReview } from '../../shared/spending';
import { currency } from '../lib/format';
import type { RouteReview } from '../../shared/routing';
import { NativeResourceSummary } from './NativeResourceControls';
import { memoryPressureDescription } from '../../shared/memory-pressure';

export function LaunchDialog({
  work,
  account,
  mutate,
  onClose,
  onLaunched,
  memoryPressure,
  memoryProtection = true,
  onResources,
  onRouted,
  onSpending,
  unresolvedWorkers = 0,
  onNativeReview,
}: {
  work: Work;
  account?: Account;
  mutate: Mutate;
  onClose: () => void;
  onLaunched: () => void;
  memoryPressure?: MemoryPressure;
  memoryProtection?: boolean;
  onResources?: () => void;
  onRouted: (work: Work) => void;
  onSpending: () => void;
  unresolvedWorkers?: number;
  onNativeReview?: () => void;
}) {
  const [metered, setMetered] = useState(false);
  const [reconciled, setReconciled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<ContextReview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  const [spending, setSpending] = useState<SpendReview | null>(null);
  const [route, setRoute] = useState<RouteReview | null>(null);
  const reviewRequest = useRef(0);
  async function readContext() {
    const requestId = ++reviewRequest.current;
    setReading(true);
    setError('');
    setReview(null);
    setSpending(null);
    setRoute(null);
    setConfirmed(false);
    try {
      const result = await mutate<ContextReview>(`/work/${work.id}/context-review`, 'POST');
      const cost = await mutate<{ review: SpendReview }>(`/work/${work.id}/spending`, 'GET');
      const route = await mutate<RouteReview>(`/work/${work.id}/route`, 'GET');
      if (requestId !== reviewRequest.current) return;
      setSpending(cost.review);
      setRoute(route);
      setReview(result);
      setConfirmed(
        work.contextReceipt?.contentDigest === result.receipt.contentDigest &&
          work.contextReceipt?.nativeResourcePolicyDigest ===
            result.receipt.nativeResourcePolicyDigest,
      );
    } catch (cause) {
      if (requestId === reviewRequest.current) setError((cause as Error).message);
    } finally {
      if (requestId === reviewRequest.current) setReading(false);
    }
  }
  useEffect(() => {
    void readContext();
    return () => {
      reviewRequest.current++;
    };
  }, [work.id, work.revision]);
  const needsReview =
    ['failed', 'interrupted'].includes(work.status) || work.nativeOrigin?.state === 'pending';
  const claude = work.harness === 'claude';
  const opencode = work.harness === 'opencode';
  const hermes = work.harness === 'hermes';
  const openclaw = work.harness === 'openclaw';
  const requiresMetered =
    Boolean(
      account?.backend ||
      account?.connector ||
      (work.nativeOrigin &&
        work.nativeOrigin.state !== 'context-only' &&
        work.nativeOrigin.modelProvider !== 'openai'),
    ) ||
    claude ||
    opencode ||
    hermes ||
    openclaw;
  const compatible = canExecuteAccount(account);
  const pressureHigh =
    memoryProtection && ['warning', 'critical'].includes(memoryPressure?.state ?? 'unknown');
  const routeMismatch = Boolean(route?.policy && route.recommendedAccountId !== work.accountId);
  const resourceBackendMismatch = Boolean(review?.nativeResources && account?.backend);
  async function prepareRoute() {
    if (!route?.planId) return;
    setBusy(true);
    setError('');
    try {
      onRouted(
        await mutate<Work>(`/work/${work.id}/route/prepare`, 'POST', {
          planId: route.planId,
          digest: route.digest,
          reconciled,
        }),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
        spendingRevision: spending?.policyRevision,
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
      subtitle={`START A ${executionName(work.harness, account).toUpperCase()} ATTEMPT`}
      onClose={onClose}
    >
      <form className="dialog-form" onSubmit={start}>
        <div className="dialog-body form-stack">
          <div className="binding-box">
            <HarnessMark harness={work.harness} />
            <div>
              <strong>{account?.label}</strong>
              <p>
                {account?.identity ??
                  (account?.connector
                    ? 'The reviewed native agent contract is checked before input. Provider identity and quotas remain unknown.'
                    : opencode || hermes || openclaw
                      ? 'Native profile and model are checked before input. Provider identity and quotas remain unknown.'
                      : 'Native identity will be checked before the turn starts.')}
              </p>
            </div>
          </div>
          <p>
            <strong>{work.title}</strong>
          </p>
          {work.nativeOrigin?.state === 'pending' && (
            <div className="launch-context">
              <strong>Continue the reviewed native chat</strong>
              <p>
                {work.nativeOrigin.turns} native turns and {work.nativeOrigin.items} items will be
                rechecked and copied before task input. Settle the original chat’s workers,
                approvals and external effects in its native client first.
              </p>
              {onNativeReview && (
                <button type="button" className="text-button" onClick={onNativeReview}>
                  Refresh native history review
                </button>
              )}
            </div>
          )}
          {account?.openClawProjectRoot && (
            <p className="source-note">
              This dedicated OpenClaw Gateway uses native administrator API scope to create a
              guarded session in its reviewed project: <code>{account.openClawProjectRoot}</code>.
              Other project directories are refused.
            </p>
          )}
          <p>
            {executionName(work.harness, account)} receives this task's goal, acceptance criteria,
            context and checkpoints, with access to the selected project. Native tools and
            permission rules apply. Supported permission requests arrive in Forge.
          </p>
          {account?.connector && (
            <p className="source-note">
              This connector pins the native agent protocol, name, version and permission mode. ACP
              turn completion does not verify task acceptance or effects. Provider identity,
              subscription allowance and billable usage are unknown; no dollar or token counter will
              be fabricated.
            </p>
          )}
          <div className="path-line">
            <Folder size={16} />
            <code>{work.cwd}</code>
          </div>
          {review?.nativeResources && (
            <section className="detail-section" aria-label="Native launch resource policy">
              <h3>Native process policy</h3>
              <NativeResourceSummary receipt={review.nativeResources} />
            </section>
          )}
          {resourceBackendMismatch && (
            <p role="status" className="source-note">
              The delegated backend owns its resource policy. Choose a locally owned account or
              review native defaults in Resources.{' '}
              <button type="button" className="text-button" onClick={onResources}>
                Review resources
              </button>
            </p>
          )}
          {routeMismatch && (
            <section className="detail-section" aria-label="Recommended account">
              <h3>Account routing</h3>
              <p>
                {route?.recommendedAccountId
                  ? `The approved route recommends ${route.candidates.find((candidate) => candidate.accountId === route.recommendedAccountId)?.label}. Prepare that binding before its context review and launch.`
                  : 'No account meets the approved route. Refresh evidence or review the route in this work panel.'}
              </p>
              {route?.recommendedAccountId && (
                <>
                  {Boolean(work.generation || work.nativeSessionId || work.capsuleId) && (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={reconciled}
                        onChange={(event) => setReconciled(event.target.checked)}
                      />
                      <span>
                        I reviewed native activity and external effects before this routed handoff.
                      </span>
                    </label>
                  )}
                  <button
                    className="button secondary small"
                    type="button"
                    disabled={
                      busy ||
                      (Boolean(work.generation || work.nativeSessionId || work.capsuleId) &&
                        !reconciled)
                    }
                    onClick={() => void prepareRoute()}
                  >
                    Prepare recommended account
                  </button>
                </>
              )}
              <button type="button" className="text-button" onClick={onClose}>
                Review account route
              </button>
            </section>
          )}
          {unresolvedWorkers > 0 && (
            <div className="notice" role="status">
              <div>
                <strong>A prior native exit needs review.</strong>
                <p>
                  {unresolvedWorkers} unconfirmed{' '}
                  {unresolvedWorkers === 1 ? 'worker holds' : 'workers hold'} new managed launches.
                  Review the original exit evidence before starting.
                </p>
                <button type="button" className="text-button" onClick={onResources}>
                  Review worker recovery
                </button>
              </div>
            </div>
          )}
          {pressureHigh && (
            <div className="notice" role="status">
              <div>
                <strong>New native work is waiting for memory headroom.</strong>
                <p>
                  {memoryPressureDescription(memoryPressure)} Wait for it to ease, or review your
                  resource policy before launching.
                </p>
                <button type="button" className="text-button" onClick={onResources}>
                  Review Resources
                </button>
              </div>
            </div>
          )}
          {memoryProtection && (!memoryPressure || memoryPressure.state === 'unknown') && (
            <p className="source-note">
              {memoryPressureDescription(memoryPressure)} Quiet mode can still pause new managed
              work.
            </p>
          )}
          <section className="memory-launch-review">
            <h3>
              {review ? `Profile: ${review.receipt.profileName}` : 'Reading selected context'}
            </h3>
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
                    <span>
                      {review.nativeResources
                        ? 'I reviewed this context and native resource policy for the launch.'
                        : 'I reviewed this profile and selected memory for the native launch.'}
                    </span>
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
          {spending && (
            <section className="detail-section" aria-label="Launch spending review">
              <h3>Spending admission</h3>
              <p>
                {spending.reserveUsd === null
                  ? 'Budget admission is off. Native usage is still recorded.'
                  : `${currency(spending.reserveUsd)} will be reserved for this attempt. ${currency(spending.monthAccountedUsd)} is accounted for in ${spending.period} UTC.`}
              </p>
              {spending.reason && (
                <>
                  <p className="form-error" role="status">
                    {spending.reason}
                  </p>
                  <button type="button" className="text-button" onClick={onSpending}>
                    Review spending in Accounts
                  </button>
                </>
              )}
            </section>
          )}
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
                {work.nativeOrigin?.state === 'pending'
                  ? 'I settled the source chat’s native workers, approvals, detached tools and external effects before continuing.'
                  : 'I reviewed the previous native attempt, detached tools, and external effects before retrying.'}
              </span>
            </label>
          )}
          <div className="notice">
            <ShieldCheck size={18} />
            <p>
              {account?.backend
                ? 'T3 owns this provider instance, native conversation and tools. Forge starts one supervised run with T3’s approval-required mode. Supported exact requests appear here; other native decisions remain in T3. Native provider billing applies.'
                : openclaw
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
        </div>
        <div className="form-footer">
          <button className="button secondary" type="button" onClick={onClose}>
            Keep as ready
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              unresolvedWorkers > 0 ||
              pressureHigh ||
              !compatible ||
              !review ||
              !spending?.allowed ||
              !route ||
              routeMismatch ||
              resourceBackendMismatch ||
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
