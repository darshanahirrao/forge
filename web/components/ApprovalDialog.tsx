import { type Approval, type WorkSummary, type WorkspaceMode } from '../../shared/types';
import { type Mutate } from '../api';
import { useState, useEffect } from 'react';
import { Dialog, FormError } from './primitives';
import { Terminal, ShieldCheck, LoaderCircle, Check } from 'lucide-react';

export function ApprovalDialog({
  approval,
  work,
  mode,
  mutate,
  onClose,
}: {
  approval: Approval;
  work?: WorkSummary;
  mode: WorkspaceMode;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (approval.status !== 'pending') return;
    const update = () => setClock(Date.now());
    const timer = setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [approval.id, approval.status]);
  const remaining = Math.max(0, Math.ceil((Date.parse(approval.expiresAt) - clock) / 1000));
  const pending = approval.status === 'pending' && remaining > 0;
  async function decide(decision: 'accept' | 'decline') {
    setBusy(decision);
    setError('');
    try {
      await mutate(`/approvals/${approval.id}/decision`, 'POST', {
        digest: approval.digest,
        decision,
      });
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <Dialog
      title={approval.title}
      subtitle={mode === 'demo' ? 'FICTIONAL DEMO REQUEST' : 'NATIVE PERMISSION REQUEST'}
      onClose={onClose}
    >
      <div className="dialog-body form-stack">
        <p className="form-intro">{work?.title}</p>
        <p>{approval.detail}</p>
        <div className="command-review">
          <div>
            <Terminal size={15} />
            <span>
              {approval.method.includes('fileChange') ? 'Native file change' : 'Requested command'}
            </span>
          </div>
          <pre>{approval.command}</pre>
        </div>
        <dl className="approval-facts">
          <div>
            <dt>Working directory</dt>
            <dd>
              <code>{approval.cwd}</code>
            </dd>
          </div>
          <div>
            <dt>Attempt</dt>
            <dd>Generation {approval.generation}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>
              {new Date(approval.expiresAt).toLocaleTimeString()}
              {pending ? ` · ${remaining} s left` : ''}
            </dd>
          </div>
          <div>
            <dt>Request fingerprint</dt>
            <dd>
              <code title={approval.digest}>{approval.digest.slice(0, 24)}</code>
            </dd>
          </div>
          {approval.decidedBy && (
            <div>
              <dt>Reviewed by</dt>
              <dd>
                {approval.decidedBy.kind === 'tailscale'
                  ? approval.decidedBy.identity
                  : 'Local workspace'}
              </dd>
            </div>
          )}
        </dl>
        <div className="notice">
          <ShieldCheck size={18} />
          <p>
            {mode === 'demo'
              ? 'This request is fictional. Your decision changes only the isolated demo workspace.'
              : 'Allow once applies to this exact live native request. It does not grant future commands or change persistent rules.'}
          </p>
        </div>
        <FormError error={error} />
        {pending ? (
          <div className="form-footer">
            <button
              className="button secondary"
              disabled={Boolean(busy)}
              onClick={() => void decide('decline')}
            >
              {busy === 'decline' && <LoaderCircle size={16} className="spin" />}Decline
            </button>
            <button
              className="button primary"
              disabled={Boolean(busy)}
              onClick={() => void decide('accept')}
            >
              {busy === 'accept' ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Check size={16} />
              )}
              Allow once
            </button>
          </div>
        ) : (
          <p className="resolved-note">
            This request is {approval.status === 'pending' ? 'expired' : approval.status}. No
            further decision can be sent.
          </p>
        )}
      </div>
    </Dialog>
  );
}
