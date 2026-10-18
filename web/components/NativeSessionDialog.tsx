import type { NativeSession, NativeSource } from '../../shared/types';
import { Dialog } from './primitives';

const date = (value?: string | null) => (value ? new Date(value).toLocaleString() : 'Not reported');

export function NativeSessionDialog({
  session,
  sources,
  onClose,
  onContinue,
}: {
  session: NativeSession;
  sources: NativeSource[];
  onClose: () => void;
  onContinue?: () => void;
}) {
  const source = sources.find((item) => item.id === session.sourceId);
  const facts = [
    ['Owner', source?.label ?? session.harness],
    ...(session.providerInstanceId
      ? [['Native provider instance', session.providerInstanceId]]
      : []),
    ['Native state', session.status],
    ['Updated', date(session.updatedAt)],
    ['Observed', date(session.observedAt)],
    ['Project', session.cwd || session.project],
    ['Native session', session.id],
  ];
  return (
    <Dialog
      title={session.title || 'Native session'}
      subtitle="NATIVE OBSERVATION"
      onClose={onClose}
    >
      <div className="dialog-body form-stack">
        <dl className="native-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd
                className={
                  ['Project', 'Native session', 'Native provider instance'].includes(label)
                    ? 'mono'
                    : undefined
                }
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="source-note">
          {onContinue && source?.kind === 'codex'
            ? 'Source workers and approvals stay in their native client. A reviewed Forge continuation uses a separate native fork.'
            : 'This is a metadata reference. Continue and inspect approvals in the native client.'}{' '}
          A saved session does not establish current process ownership.
        </p>
        {onContinue && source?.kind === 'codex' && (
          <button className="button primary" onClick={onContinue}>
            Continue in Forge
          </button>
        )}
        {source?.kind === 't3-code' && source.endpoint && (
          <a className="text-button" href={source.endpoint} target="_blank" rel="noreferrer">
            Open T3 Code
          </a>
        )}
      </div>
    </Dialog>
  );
}
