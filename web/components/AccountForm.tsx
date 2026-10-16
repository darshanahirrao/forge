import { type WorkspaceMode, type Harness } from '../../shared/types';
import { type Mutate } from '../api';
import { useState, type FormEvent } from 'react';
import { Dialog, FormError } from './primitives';
import { names } from '../lib/format';
import { ShieldCheck, LoaderCircle } from 'lucide-react';

export function AccountForm({
  mode,
  mutate,
  onClose,
  onSaved,
}: {
  mode: WorkspaceMode;
  mutate: Mutate;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [harness, setHarness] = useState<Harness>('codex');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      await mutate('/accounts', 'POST', {
        label: form.get('label'),
        harness,
        nativeHome: form.get('nativeHome'),
        billingMode: form.get('billingMode'),
      });
      onSaved();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog title="Bring a native account." subtitle="ACCOUNT SLOT" onClose={onClose}>
      <form className="dialog-body form-stack" onSubmit={save}>
        <p className="form-intro">
          Give an existing native sign-in a place in Forge. Account slots store references;
          credentials remain in the harness.
        </p>
        <label>
          Account label
          <input
            name="label"
            placeholder="Codex personal, Claude studio..."
            maxLength={80}
            required
            autoFocus
          />
        </label>
        <label>
          Harness
          <select value={harness} onChange={(e) => setHarness(e.target.value as Harness)}>
            {Object.entries(names).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Billing preference
          <select name="billingMode">
            <option value="native">Use native configuration</option>
            <option value="subscription">Require subscription access</option>
            <option value="api">API account</option>
          </select>
          <small>
            Metered or external-provider access requires an explicit choice before launch.
          </small>
        </label>
        <label>
          Native configuration directory <span className="optional">Optional</span>
          <input
            name="nativeHome"
            placeholder="Leave empty for the native default"
            disabled={mode === 'demo'}
          />
          <small>
            {harness === 'codex'
              ? 'References CODEX_HOME. The chosen credential backend must support separate native identities.'
              : harness === 'claude'
                ? 'References CLAUDE_CONFIG_DIR. Keyless Console sign-ins have different isolation rules.'
                : 'Managed authentication for this adapter is planned. This slot can be used in work records.'}
          </small>
        </label>
        <div className="notice">
          <ShieldCheck size={18} />
          <p>
            {mode === 'demo'
              ? 'This creates a fictional slot only. Native tools are never contacted in demo mode.'
              : "Saving a slot does not sign you in. Use the harness's native setup, then check the account from Forge."}
          </p>
        </div>
        <FormError error={error} />
        <div className="form-footer">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving}>
            {saving && <LoaderCircle className="spin" size={16} />}Save account slot
          </button>
        </div>
      </form>
    </Dialog>
  );
}
