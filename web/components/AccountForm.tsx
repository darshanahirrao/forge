import { type WorkspaceMode, type Harness } from '../../shared/types';
import { type Mutate } from '../api';
import { useState, type FormEvent } from 'react';
import { Dialog, FormError } from './primitives';
import { names } from '../lib/format';
import { ShieldCheck, LoaderCircle } from 'lucide-react';
import type { NativeConnector } from '../../shared/connectors';

export function AccountForm({
  mode,
  mutate,
  onClose,
  onSaved,
  connectors = [],
}: {
  mode: WorkspaceMode;
  mutate: Mutate;
  onClose: () => void;
  onSaved: () => void;
  connectors?: NativeConnector[];
}) {
  const [harness, setHarness] = useState<Harness>('codex');
  const [billingMode, setBillingMode] = useState('native');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [credentialSource, setCredentialSource] = useState('environment');
  const connector = connectors.find((item) => item.id === harness);
  const credentialSupport =
    (['claude', 'codex'].includes(harness) && billingMode === 'api') ||
    ['opencode', 'hermes', 'openclaw'].includes(harness) ||
    Boolean(connector);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      await mutate('/accounts', 'POST', {
        label: form.get('label'),
        harness,
        ...(connector ? { connectorId: connector.id } : {}),
        nativeHome: form.get('nativeHome'),
        ...(harness === 'openclaw' && String(form.get('openClawProjectRoot') || '').trim()
          ? { openClawProjectRoot: String(form.get('openClawProjectRoot')).trim() }
          : {}),
        billingMode,
        ...(['claude', 'codex'].includes(harness) && billingMode === 'api'
          ? {
              credentialEnv: String(
                form.get('credentialEnv') ||
                  (harness === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'),
              ).trim(),
            }
          : (['opencode', 'hermes', 'openclaw'].includes(harness) || connector) &&
              String(form.get('credentialEnv') || '').trim()
            ? { credentialEnv: String(form.get('credentialEnv')).trim() }
            : {}),
        ...(credentialSupport && credentialSource !== 'environment'
          ? {
              credentialReference:
                credentialSource === 'private-json'
                  ? {
                      kind: 'private-json',
                      path: String(form.get('credentialPath') || '').trim(),
                      key: String(form.get('credentialKey') || '').trim(),
                    }
                  : {
                      kind: 'macos-keychain',
                      service: String(form.get('keychainService') || '').trim(),
                      account: String(form.get('keychainAccount') || '').trim(),
                      ...(form.get('keychainPath')
                        ? { keychain: String(form.get('keychainPath')).trim() }
                        : {}),
                    },
            }
          : {}),
      });
      onSaved();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog title="Link account" onClose={onClose}>
      <form className="dialog-form" onSubmit={save}>
        <div className="dialog-body form-stack">
          <p className="form-intro">
            Use an existing native sign-in. Credentials stay in the harness.
          </p>
          <label>
            Account label
            <input
              name="label"
              placeholder="Codex personal, Claude studio..."
              maxLength={80}
              required
              autoFocus
              data-autofocus=""
            />
          </label>
          <label>
            Harness
            <select
              value={harness}
              onChange={(e) => {
                const next = e.target.value as Harness;
                setHarness(next);
                if (connectors.some((item) => item.id === next) && billingMode === 'subscription')
                  setBillingMode('native');
              }}
            >
              {Object.entries(names).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
              {connectors
                .filter((item) => item.enabled)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.manifest.name} · ACP connector
                  </option>
                ))}
            </select>
          </label>
          <label>
            Billing preference
            <select
              name="billingMode"
              value={billingMode}
              onChange={(e) => setBillingMode(e.target.value)}
            >
              <option value="native">Use native configuration</option>
              {!connector && <option value="subscription">Require subscription access</option>}
              <option value="api">API account</option>
            </select>
            <small>
              Metered or external-provider access requires an explicit choice before launch.
            </small>
          </label>
          {credentialSupport && (
            <label>
              {connector || ['opencode', 'hermes', 'openclaw'].includes(harness)
                ? 'Native credential environment variable'
                : 'API credential environment variable'}
              <input
                name="credentialEnv"
                placeholder={
                  connector || ['opencode', 'hermes', 'openclaw'].includes(harness)
                    ? 'Optional native credential variable'
                    : harness === 'claude'
                      ? 'ANTHROPIC_API_KEY'
                      : 'OPENAI_API_KEY'
                }
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                maxLength={128}
              />
              <small>
                {connector || ['opencode', 'hermes', 'openclaw'].includes(harness)
                  ? 'Optional when the native profile stores its own credentials. Set a selected provider variable outside Forge; other ambient provider keys are excluded. Enter only its name.'
                  : 'Enter a variable name, such as CLAUDE_STUDIO_KEY. Set its value outside Forge before starting the service. Never paste a key here.'}
              </small>
            </label>
          )}
          {credentialSupport && mode === 'local' && (
            <details className="native-details">
              <summary>Background credential reference</summary>
              <div className="form-stack">
                <p className="source-note">
                  Optional. Read one provider key from an existing private reference when this
                  account starts, including outside your terminal. Keep native sign-ins in the
                  harness.
                </p>
                <label>
                  Credential source
                  <select
                    value={credentialSource}
                    onChange={(event) => setCredentialSource(event.target.value)}
                  >
                    <option value="environment">Native profile or process environment</option>
                    <option value="private-json">Private JSON file</option>
                    <option value="macos-keychain">macOS Keychain item</option>
                  </select>
                </label>
                {credentialSource === 'private-json' && (
                  <>
                    <label>
                      Private JSON path
                      <input
                        name="credentialPath"
                        required
                        maxLength={2000}
                        placeholder="/absolute/path/to/private-provider.json"
                      />
                      <small>
                        Existing owned mode-0600 regular file. Forge stores only the reference.
                      </small>
                    </label>
                    <label>
                      JSON field name
                      <input
                        name="credentialKey"
                        required
                        maxLength={128}
                        pattern="[A-Za-z_][A-Za-z0-9_]*"
                        placeholder="ANTHROPIC_API_KEY"
                      />
                    </label>
                  </>
                )}
                {credentialSource === 'macos-keychain' && (
                  <>
                    <label>
                      Keychain service
                      <input name="keychainService" required maxLength={200} />
                    </label>
                    <label>
                      Keychain account
                      <input name="keychainAccount" required maxLength={200} />
                    </label>
                    <label>
                      Keychain file <span className="optional">Optional</span>
                      <input
                        name="keychainPath"
                        maxLength={2000}
                        placeholder="Use the native Keychain search list"
                      />
                    </label>
                    <p className="source-note">
                      Authorize the selected item through macOS before background use. An
                      unavailable or locked item holds the launch.
                    </p>
                  </>
                )}
                <p className="source-note">
                  Enter references and variable names only. Never paste a provider key here.
                  Reference reads do not verify native account identity or allowance.
                </p>
              </div>
            </details>
          )}
          <label>
            {connector
              ? 'Native profile root'
              : harness === 'hermes'
                ? 'Native Hermes home'
                : harness === 'openclaw'
                  ? 'Native OpenClaw execution profile'
                  : harness === 'opencode'
                    ? 'Native profile root'
                    : 'Native configuration directory'}{' '}
            {!connector && !['opencode', 'hermes', 'openclaw'].includes(harness) && (
              <span className="optional">Optional</span>
            )}
            <input
              name="nativeHome"
              placeholder={
                connector
                  ? '/absolute/path/to/your/native-profile'
                  : harness === 'hermes'
                    ? '/path/to/your/hermes-home'
                    : harness === 'openclaw'
                      ? '/path/to/your/openclaw-execution-profile'
                      : harness === 'opencode'
                        ? '/path/to/your/opencode-profile'
                        : 'Leave empty for the native default'
              }
              disabled={mode === 'demo'}
              required={
                (Boolean(connector) || ['opencode', 'hermes', 'openclaw'].includes(harness)) &&
                mode !== 'demo'
              }
            />
            <small>
              {connector
                ? 'An existing native profile. The connector maps its reviewed home variables into this directory. Configure sign-in and the model through the native agent first; provider identity, limits and billing remain unknown.'
                : harness === 'codex'
                  ? 'References CODEX_HOME. The chosen credential backend must support separate native identities.'
                  : harness === 'claude'
                    ? 'References CLAUDE_CONFIG_DIR. Keyless Console sign-ins have different isolation rules.'
                    : harness === 'opencode'
                      ? 'A native profile root containing config, data, state and cache directories. Configure OpenCode with these XDG homes and select a default model first. Forge never copies another profile’s credentials.'
                      : harness === 'hermes'
                        ? 'References HERMES_HOME. Configure its native provider first. Hermes keeps its own tools, skills, memory and credentials in this home. Forge uses the installed native ACP runtime.'
                        : 'Use a dedicated native execution profile with local Gateway, reload off, cron disabled and heartbeat every 0m. Native channels and schedules stay with their existing companion owner. Configure its model through OpenClaw first.'}
            </small>
          </label>
          {harness === 'openclaw' && mode === 'local' && (
            <details className="native-details">
              <summary>Reviewed native project</summary>
              <label>
                Native project directory <span className="optional">Optional</span>
                <input
                  name="openClawProjectRoot"
                  maxLength={2000}
                  placeholder="/absolute/project/path"
                />
                <small>
                  For a project outside the native memory workspace, authorize this exact directory.
                  The dedicated Gateway uses native administrator API scope to create guarded
                  sessions here. Other project directories are refused. Configure this choice on the
                  local Forge host.
                </small>
              </label>
            </details>
          )}
          <div className="notice">
            <ShieldCheck size={18} />
            <p>
              {mode === 'demo'
                ? 'This creates a fictional slot only. Native tools are never contacted in demo mode.'
                : "Saving a slot does not sign you in. Use the harness's native setup, then check the account from Forge."}
            </p>
          </div>
          <FormError error={error} />
        </div>
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
