import { type Work, type Account } from '../../shared/types';
import { type Mutate } from '../api';
import { useState, type FormEvent } from 'react';
import { Dialog, HarnessMark, FormError } from './primitives';
import { Folder, ShieldCheck, LoaderCircle, Play } from 'lucide-react';
import { executionName } from '../../shared/harnesses';

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
  const needsReview = ['failed', 'interrupted'].includes(work.status);
  const claude = work.harness === 'claude';
  const compatible = !claude || account?.billingMode === 'api';
  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await mutate(`/work/${work.id}/launch`, 'POST', { allowMetered: metered, reconciled });
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
            <p>{account?.identity ?? 'Native identity will be checked before the turn starts.'}</p>
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
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={metered}
            onChange={(e) => setMetered(e.target.checked)}
            required={claude}
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
            {claude
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
            disabled={busy || !compatible || (claude && !metered) || (needsReview && !reconciled)}
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}Start native
            attempt
          </button>
        </div>
      </form>
    </Dialog>
  );
}
