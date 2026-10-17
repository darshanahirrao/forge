import { useState, type FormEvent } from 'react';
import type { Snapshot } from '../../shared/types';
import type { NotificationKind } from '../../shared/notifications';
import type { Mutate } from '../api';
import { age } from '../lib/format';
import { Dialog, FormError } from './primitives';

const categories: Record<NotificationKind, string> = {
  approval: 'Native approvals',
  failed: 'Failed attempts',
  interrupted: 'Interrupted connections',
  completed: 'Completed attempts',
};
const states = {
  queued: 'Queued',
  sending: 'Sending',
  accepted: 'Accepted by ntfy',
  uncertain: 'Delivery uncertain',
  failed: 'Setup needs review',
  withdrawn: 'Withdrawn',
};

export function NotificationsPanel({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const snapshot = data.notifications;
  const config = snapshot?.config;
  const [editing, setEditing] = useState(false);
  const [serverOrigin, setServerOrigin] = useState('https://ntfy.sh');
  const [topic, setTopic] = useState('');
  const [token, setToken] = useState('');
  const [kinds, setKinds] = useState<NotificationKind[]>(['approval', 'failed', 'interrupted']);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const disabled = busy || data.mode === 'demo';
  const remote = data.access?.kind === 'tailscale';

  function close() {
    setEditing(false);
    setTopic('');
    setToken('');
    setError('');
  }
  async function act(path: string, method: string, value?: unknown) {
    setBusy(true);
    setError('');
    try {
      await mutate(path, method, value);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function connect(event: FormEvent) {
    event.preventDefault();
    const input = { expectedRevision: revision, serverOrigin, topic, token, kinds };
    setTopic('');
    setToken('');
    setError('');
    setBusy(true);
    try {
      await mutate('/notifications/connect', 'POST', input);
      close();
    } catch (cause) {
      setError(`${(cause as Error).message} Re-enter the private destination to try again.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel backend-panel" aria-label="Notifications">
      <div className="section-heading">
        <div>
          <h2>Notifications</h2>
          <p>
            {config?.enabled
              ? `Connected to ${config.serverOrigin}`
              : 'Off. Connect your existing ntfy destination for attention alerts.'}
          </p>
        </div>
        <button
          className="button secondary small"
          disabled={disabled || remote}
          onClick={() => {
            setServerOrigin(config?.serverOrigin ?? 'https://ntfy.sh');
            setKinds(config?.kinds ?? ['approval', 'failed', 'interrupted']);
            setRevision(config?.revision ?? 0);
            setError('');
            setEditing(true);
          }}
        >
          {config?.enabled ? 'Replace destination' : 'Configure notifications'}
        </button>
      </div>
      <div className="backend-instance">
        <p className="source-note">
          Generic alerts link to your workspace. Review exact native requests in Forge. Subscribe to
          the same topic in your ntfy app.
        </p>
        {remote && (
          <p className="source-note">Configure a private destination from your local Forge host.</p>
        )}
        {config?.enabled && (
          <>
            <p className="source-note">
              {config.kinds.map((kind) => categories[kind]).join(' · ')}
            </p>
            <p className="source-note companion-root">
              Review address: {snapshot?.reviewOrigin}. Phone links require your private gateway and
              an awake host.
            </p>
            <div className="connection-actions">
              <button
                className="button secondary small"
                disabled={disabled}
                onClick={() => void act('/notifications/test', 'POST')}
              >
                Send test alert
              </button>
              <button
                className="button secondary small"
                disabled={disabled}
                onClick={() =>
                  void act('/notifications', 'DELETE', { expectedRevision: config.revision })
                }
              >
                Disable notifications
              </button>
            </div>
          </>
        )}
        {snapshot && snapshot.needsReview > 0 && (
          <p className="notification-warning" role="status">
            {snapshot.needsReview}{' '}
            {snapshot.needsReview === 1 ? 'delivery needs' : 'deliveries need'} review. Uncertain
            deliveries are never retried automatically.
          </p>
        )}
        {!editing && <FormError error={error} />}
        {!!snapshot?.receipts.length && (
          <details className="native-details">
            <summary>
              Delivery receipts ({snapshot.receipts.length}
              {snapshot.receipts.length === 100 ? '+' : ''})
            </summary>
            <p className="source-note">
              ntfy acceptance does not confirm device delivery. Unreviewed problems appear first.
              Acknowledging one preserves its delivery evidence.
            </p>
            <ul className="notification-receipts">
              {snapshot.receipts.map((row) => (
                <li key={row.id}>
                  <div>
                    <strong>{row.kind === 'test' ? 'Test alert' : categories[row.kind]}</strong>
                    <span>
                      {states[row.state]} · {age(row.createdAt)}
                      {row.acknowledgedAt ? ' · Acknowledged' : ''}
                    </span>
                  </div>
                  <p className="source-note">{row.detail}</p>
                  {['uncertain', 'failed'].includes(row.state) && !row.acknowledgedAt && (
                    <button
                      className="button secondary small"
                      disabled={disabled}
                      onClick={() =>
                        void act(`/notifications/${encodeURIComponent(row.id)}/acknowledge`, 'POST')
                      }
                    >
                      Acknowledge delivery issue
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {editing && (
        <Dialog title="Configure notifications" onClose={close}>
          <form className="dialog-form" onSubmit={connect}>
            <div className="dialog-body form-stack">
              <p className="form-intro">
                Use your existing ntfy server and topic. Connecting enables the selected alerts
                immediately, including currently pending approvals.
              </p>
              <label>
                ntfy server origin
                <input
                  type="url"
                  autoFocus
                  data-autofocus=""
                  required
                  maxLength={2000}
                  value={serverOrigin}
                  onChange={(event) => setServerOrigin(event.target.value)}
                />
                <small>HTTPS server only. Self-hosted HTTP is supported on loopback.</small>
              </label>
              <label>
                Private topic
                <input
                  type="password"
                  required
                  minLength={8}
                  maxLength={120}
                  pattern="[A-Za-z0-9_-]+"
                  autoComplete="off"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                />
                <small>
                  A topic is a shared secret unless your server restricts access. Use an unguessable
                  topic or an authenticated private topic.
                </small>
              </label>
              <label>
                Access token <span className="optional">Optional</span>
                <input
                  type="password"
                  maxLength={16384}
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
              <fieldset className="notification-kinds">
                <legend>Alert me about</legend>
                {(Object.keys(categories) as NotificationKind[]).map((kind) => (
                  <label className="checkbox-label" key={kind}>
                    <input
                      type="checkbox"
                      checked={kinds.includes(kind)}
                      onChange={(event) =>
                        setKinds((previous) =>
                          event.target.checked
                            ? [...previous, kind]
                            : previous.filter((item) => item !== kind),
                        )
                      }
                    />
                    {categories[kind]}
                  </label>
                ))}
              </fieldset>
              <p className="source-note">
                The topic and token are saved as a private local reference, outside workspace
                exports. Alerts contain a generic status and the Forge address.
              </p>
              <a
                className="external-link"
                href="https://docs.ntfy.sh/subscribe/phone/"
                target="_blank"
                rel="noreferrer"
              >
                Set up your ntfy app
              </a>
              <FormError error={error} />
            </div>
            <div className="form-footer">
              <button type="button" className="button secondary" onClick={close}>
                Cancel
              </button>
              <button className="button primary" disabled={disabled || !kinds.length || !topic}>
                {busy ? 'Connecting…' : 'Connect notifications'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
