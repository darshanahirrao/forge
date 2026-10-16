import { type Approval, type WorkSummary, type WorkspaceMode } from '../../shared/types';
import { type Mutate } from '../api';
import { useState } from 'react';
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
  const pending = approval.status === 'pending' && Date.parse(approval.expiresAt) > Date.now();
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
            <dd>{new Date(approval.expiresAt).toLocaleTimeString()}</dd>
          </div>
          <div>
            <dt>Request fingerprint</dt>
            <dd>
              <code title={approval.digest}>{approval.digest.slice(0, 24)}</code>
            </dd>
          </div>
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
