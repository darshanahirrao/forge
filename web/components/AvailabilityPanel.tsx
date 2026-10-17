import { useState } from 'react';
import type { Snapshot } from '../../shared/types';
import type {
  ActivationReceipt,
  AvailabilityReview,
  AvailabilitySnapshot,
} from '../../shared/availability';
import type { Mutate } from '../api';
import { Dialog, FormError } from './primitives';

export function AvailabilityPanel({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [plan, setPlan] = useState<AvailabilityReview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<AvailabilitySnapshot | null>(null);
  const [resolveOpen, setResolveOpen] = useState(false);
  const state = checked ?? data.availability;
  const running = state?.runtime === 'launchd' || data.service?.mode === 'launchd';
  const held =
    !!state?.receipt &&
    !state.receipt.review &&
    !['running', 'failed', 'aborted'].includes(state.receipt.state);
  const disabled =
    data.mode !== 'local' ||
    data.access?.kind === 'tailscale' ||
    !state?.supported ||
    data.work.some((w) => w.activeRunId) ||
    busy ||
    submitted ||
    held ||
    state.transitioning;
  return (
    <section className="panel" aria-label="Workspace availability">
      <div className="section-heading">
        <div>
          <h2>
            {running ? 'Forge is running in the background.' : 'Keep your workspace available.'}
          </h2>
          <p>
            {state?.detail ??
              'The optional macOS user service keeps Forge available outside Codex. Other platforms can run it in the foreground.'}
          </p>
        </div>
        {!running && (
          <button
            className="button secondary small"
            disabled={disabled}
            onClick={async () => {
              setBusy(true);
              setError('');
              setReviewed(false);
              setChecked(null);
              try {
                setPlan(await mutate<AvailabilityReview>('/availability/prepare', 'POST', {}));
              } catch (cause) {
                setError((cause as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Review background setup
          </button>
        )}
      </div>
      {(submitted || state?.transitioning) && !running && (
        <p role="status">
          Handing this workspace to the native service. The connection may briefly close. Saved work
          stays in the same database.
        </p>
      )}
      {state?.receipt && (
        <p className="source-note">
          Last handoff: {state.receipt.state}. {state.receipt.detail}
        </p>
      )}
      {state?.receipt?.review && (
        <p className="source-note">Inactive native state reviewed: {state.receipt.review.note}</p>
      )}
      {held &&
        !state?.transitioning &&
        !running &&
        data.mode === 'local' &&
        data.access?.kind !== 'tailscale' && (
          <button
            className="button secondary small"
            disabled={busy}
            onClick={() => {
              setResolveOpen(true);
              setReviewed(false);
              setError('');
            }}
          >
            Review inactive handoff
          </button>
        )}
      {(submitted || held) && !running && (
        <button
          className="button secondary small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const result = await mutate<AvailabilitySnapshot>('/availability', 'GET');
              setChecked(result);
              if (
                !result.transitioning &&
                (!result.receipt ||
                  !!result.receipt.review ||
                  ['failed', 'aborted', 'running'].includes(result.receipt.state))
              ) {
                setSubmitted(false);
                setPlan(null);
              }
            } catch {
              setError('The workspace is reconnecting. Check availability again in a moment.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Check current availability
        </button>
      )}
      <p className="panel-footnote">
        {running && state?.startsAtLogin ? 'Starts at macOS login. ' : ''}
        {running && state && !state.startsAtLogin
          ? 'This custom service definition does not start automatically at login. '
          : ''}
        Runs while you are logged in and the Mac is awake. Phone access requires your private
        gateway. Provider secrets stay in their native homes or selected private references.
      </p>
      <details className="native-details">
        <summary>Native service commands</summary>
        <p>
          For manual setup, install the definition, stop the foreground process with Ctrl+C, then
          start the service.
        </p>
        <pre className="service-commands" tabIndex={0}>
          <code>
            node bin/forge.mjs service install{'\n'}node bin/forge.mjs service start{'\n'}node
            bin/forge.mjs service status{'\n'}node bin/forge.mjs service stop{'\n'}node
            bin/forge.mjs service uninstall
          </code>
        </pre>
        <p className="source-note">
          Run from the Forge source directory with this workspace's data-directory option if
          customized. Stop preserves saved work. Uninstall removes only the verified service
          definition and receipt.
        </p>
      </details>
      {!plan && <FormError error={error} />}
      {plan && !submitted && (
        <Dialog
          title="Review background setup"
          onClose={() => {
            if (!busy) {
              setPlan(null);
              setError('');
            }
          }}
        >
          <form
            className="dialog-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError('');
              setSubmitted(true);
              try {
                const receipt = await mutate<ActivationReceipt>('/availability/activate', 'POST', {
                  planId: plan.id,
                  digest: plan.digest,
                  reviewed: true,
                });
                setPlan(null);
                if (receipt.state === 'aborted' || receipt.state === 'failed') {
                  setSubmitted(false);
                  setChecked(null);
                  setError(receipt.detail);
                }
              } catch {
                setPlan(null);
                setError(
                  'The activation response was not confirmed. Check current availability before preparing another handoff.',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="dialog-body form-stack">
              <p>
                {plan.action === 'install-and-start'
                  ? 'Install and start the native macOS user service.'
                  : 'Start the existing, unchanged native macOS service.'}{' '}
                This foreground process will close after its response. The background service opens
                the same saved workspace.
              </p>
              <p>
                {plan.startsAtLogin
                  ? 'The service starts at login and restarts after an abnormal exit.'
                  : 'This custom definition directory does not start automatically at login.'}{' '}
                It runs while you are logged in and awake. Native tasks are not automatically
                replayed after restart.
              </p>
              <label>
                Workspace directory<code className="native-rule">{plan.dataDirectory}</code>
              </label>
              <label>
                Native service definition<code className="native-rule">{plan.definition}</code>
              </label>
              <label>
                Executable<code className="native-rule">{plan.executable}</code>
              </label>
              <label>
                Service runner<code className="native-rule">{plan.runner}</code>
              </label>
              <p>
                Local port: {plan.port}.{' '}
                {plan.phonePort
                  ? `Private phone-gateway port: ${plan.phonePort}, origin: ${plan.phoneOrigin}. Allowed users: ${plan.phoneUsers.join(', ')}.`
                  : 'No phone gateway configured.'}
              </p>
              <details className="native-details">
                <summary>Reviewed service environment</summary>
                <pre className="native-rule">{JSON.stringify(plan.environment, null, 2)}</pre>
                <p>
                  Shell profiles and provider variables are not copied. Native account homes and
                  selected private credential references remain available.
                </p>
              </details>
              <p className="muted">
                This review expires in two minutes. Native work and setup must be idle; reviewed
                service settings and installation must remain unchanged. An uncertain handoff
                requires native status review.
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                  required
                />
                I reviewed this native service and authorize the foreground handoff.
              </label>
              <FormError error={error} />
            </div>
            <footer className="form-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setPlan(null)}
              >
                Cancel
              </button>
              <button className="button" disabled={busy || !reviewed}>
                {busy ? 'Preparing handoff…' : 'Activate background service'}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {resolveOpen && state?.receipt && (
        <Dialog
          title="Review inactive handoff"
          onClose={() => {
            if (!busy) setResolveOpen(false);
          }}
        >
          <form
            className="dialog-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const note = String(new FormData(event.currentTarget).get('note') ?? '').trim();
              setBusy(true);
              setError('');
              try {
                await mutate('/availability/review', 'POST', {
                  id: state.receipt!.id,
                  digest: state.receipt!.digest,
                  note,
                  reviewed: true,
                });
                setResolveOpen(false);
                setSubmitted(false);
                setChecked(null);
              } catch (cause) {
                setError((cause as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="dialog-body form-stack">
              <p>
                Previous outcome: {state.receipt.state}. {state.receipt.detail}
              </p>
              <p>
                Forge will verify that the handoff helper has exited and no native service is loaded
                for this exact installation. The original outcome stays in the receipt. This records
                your review and permits a fresh setup review; it starts no service and replays no
                request.
              </p>
              <label>
                Outcome note
                <textarea name="note" required maxLength={1000} rows={3} />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                  required
                />
                I reviewed native service status and want to record its inactive state.
              </label>
              <FormError error={error} />
            </div>
            <footer className="form-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setResolveOpen(false)}
              >
                Cancel
              </button>
              <button className="button" disabled={busy || !reviewed}>
                {busy ? 'Checking native state…' : 'Record inactive review'}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </section>
  );
}
