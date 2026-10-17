import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Snapshot } from '../../shared/types';
import type {
  BlueprintBindings,
  BlueprintDefinition,
  BlueprintPlan,
  BlueprintReceipt,
} from '../../shared/blueprints';
import { request, type Mutate } from '../api';
import { Dialog, FormError } from './primitives';

const initialBindings = (): BlueprintBindings => ({
  accounts: {},
  profiles: {},
  memories: {},
  companions: {},
  projects: {},
  applySettings: false,
});
const own = (values: Record<string, string>, key: string) =>
  Object.hasOwn(values, key) ? values[key] : '';
export function BlueprintsPanel({
  data,
  mutate,
  onDownload,
}: {
  data: Snapshot;
  mutate: Mutate;
  onDownload: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mode = useRef(data.mode);
  mode.current = data.mode;
  const [definition, setDefinition] = useState<BlueprintDefinition | null>(null);
  const [bindings, setBindings] = useState<BlueprintBindings>(initialBindings);
  const [plan, setPlan] = useState<BlueprintPlan | null>(null);
  const [imports, setImports] = useState<BlueprintReceipt[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function loadImports() {
    const requested = data.mode;
    const values = await request<BlueprintReceipt[]>('/blueprints/imports', requested);
    if (mode.current === requested) setImports(values);
  }
  useEffect(() => {
    setDefinition(null);
    setPlan(null);
    setError('');
    void loadImports().catch(() => {});
  }, [data.mode]);
  async function upload(file: File) {
    const requested = data.mode;
    setBusy(true);
    setError('');
    try {
      if (file.size > 256 * 1024) throw new Error('Choose a blueprint smaller than 256 KiB.');
      const value = JSON.parse(await file.text());
      const parsed = await mutate<BlueprintDefinition>('/blueprints/parse', 'POST', {
        definition: value,
      });
      if (mode.current === requested) {
        setBindings(initialBindings());
        setPlan(null);
        setDefinition(parsed);
      }
    } catch (cause) {
      if (mode.current === requested) setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function bind(
    key: 'accounts' | 'profiles' | 'memories' | 'companions' | 'projects',
    role: string,
    value: string,
  ) {
    setBindings((previous) => {
      const values = { ...previous[key] };
      if (value || key === 'profiles')
        Object.defineProperty(values, role, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      else delete values[role];
      return { ...previous, [key]: values };
    });
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setPlan(await mutate<BlueprintPlan>('/blueprints/inspect', 'POST', { definition, bindings }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!plan) return;
    setBusy(true);
    setError('');
    try {
      await mutate('/blueprints/apply', 'POST', { planId: plan.id, digest: plan.digest });
      setDefinition(null);
      setPlan(null);
      await loadImports();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function rollback(id: string) {
    setBusy(true);
    setError('');
    try {
      await mutate(`/blueprints/${id}/rollback`, 'POST');
      await loadImports();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const projectRoles = [...new Set(definition?.workTemplates?.map((work) => work.projectRole))];
  return (
    <section className="panel backend-panel" aria-label="Workspace blueprints">
      <div className="section-heading">
        <div>
          <h2>Workspace blueprints</h2>
          <p>Reuse setup roles and work templates with your own accounts and memory.</p>
        </div>
        <div className="blueprint-actions">
          <button
            className="button secondary small"
            disabled={busy || data.mode === 'demo'}
            onClick={() => input.current?.click()}
          >
            Import blueprint
          </button>
          <button className="button secondary small" disabled={busy} onClick={onDownload}>
            Export setup blueprint
          </button>
        </div>
      </div>
      <input
        hidden
        ref={input}
        type="file"
        accept="application/json,.json"
        aria-label="Choose blueprint JSON"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />
      {!definition && <FormError error={error} />}
      {imports.length > 0 && (
        <div className="backend-instance">
          <details className="native-details">
            <summary>Recent imports ({imports.length})</summary>
            {imports.map((receipt) => (
              <div className="blueprint-import" key={receipt.id}>
                <div>
                  <strong>{receipt.name}</strong>
                  <p className="source-note">
                    {new Date(receipt.createdAt).toLocaleString()} ·{' '}
                    {receipt.rolledBackAt
                      ? 'Rolled back'
                      : `${Object.keys(receipt.profiles).length} profiles, ${Object.keys(receipt.work).length} work records`}
                  </p>
                </div>
                <button
                  className="button secondary small"
                  disabled={busy || Boolean(receipt.rolledBackAt) || data.mode === 'demo'}
                  onClick={() => void rollback(receipt.id)}
                  aria-label={`Roll back unused import ${receipt.name}`}
                >
                  Roll back unused import
                </button>
              </div>
            ))}
          </details>
        </div>
      )}
      {definition && !plan && (
        <Dialog
          title="Bind blueprint roles"
          subtitle={definition.name ?? 'Workspace blueprint'}
          onClose={() => {
            setDefinition(null);
            setError('');
          }}
        >
          <form className="dialog-body form-stack blueprint-content" onSubmit={review}>
            <p>
              Choose existing local bindings. Import creates new profiles and ready work; execution
              and companion access stay under their native controls.
            </p>
            {definition.accounts.map((account) => (
              <label key={account.role}>
                Account: {account.role}
                <select
                  value={own(bindings.accounts, account.role)}
                  required={definition.workTemplates?.some(
                    (work) => work.accountRole === account.role,
                  )}
                  onChange={(event) => bind('accounts', account.role, event.target.value)}
                >
                  <option value="">Connect later</option>
                  {data.accounts
                    .filter(
                      (local) =>
                        local.harness === account.harness &&
                        local.billingMode === account.billingMode,
                    )
                    .map((local) => (
                      <option key={local.id} value={local.id}>
                        {local.label}
                      </option>
                    ))}
                </select>
                <small>
                  {account.harness} · {account.billingMode}
                </small>
              </label>
            ))}
            {definition.profiles.map((profile) => (
              <fieldset className="blueprint-profile" key={profile.role}>
                <legend>Profile: {profile.role}</legend>
                <label>
                  Profile name
                  <input
                    value={
                      Object.hasOwn(bindings.profiles, profile.role)
                        ? bindings.profiles[profile.role]
                        : (profile.name ?? `Imported ${profile.role}`)
                    }
                    maxLength={100}
                    required
                    onChange={(event) => bind('profiles', profile.role, event.target.value)}
                  />
                </label>
                {profile.instructions && (
                  <details className="native-details">
                    <summary>Profile instructions</summary>
                    <pre className="service-commands">
                      <code>{profile.instructions}</code>
                    </pre>
                  </details>
                )}
                {profile.memoryOwners.map((requirement, index) => {
                  const role = `${profile.role}:memory:${index + 1}`;
                  return (
                    <label key={role}>
                      Memory: {role}
                      <select
                        required
                        value={own(bindings.memories, role)}
                        onChange={(event) => bind('memories', role, event.target.value)}
                      >
                        <option value="">Choose an existing memory reference</option>
                        {data.memorySources
                          .filter(
                            (source) =>
                              source.owner === requirement.owner &&
                              source.scope.kind === requirement.scope,
                          )
                          .map((source) => (
                            <option key={source.id} value={source.id}>
                              {source.label}
                            </option>
                          ))}
                      </select>
                      <small>
                        {requirement.owner} · {requirement.scope} scope. Add missing references in
                        Memory first.
                      </small>
                    </label>
                  );
                })}
                {profile.preferredCompanion && (
                  <label>
                    Native activity reference
                    <select
                      value={own(bindings.companions, profile.role)}
                      onChange={(event) => bind('companions', profile.role, event.target.value)}
                    >
                      <option value="">Connect later</option>
                      {data.nativeSources
                        .filter((source) => source.kind === profile.preferredCompanion)
                        .map((source) => (
                          <option value={source.id} key={source.id}>
                            {source.label}
                          </option>
                        ))}
                    </select>
                    <small>Companion MCP access is configured separately.</small>
                  </label>
                )}
              </fieldset>
            ))}
            {projectRoles.map((role) => (
              <label key={role}>
                Project: {role}
                <input
                  value={own(bindings.projects, role)}
                  placeholder="/absolute/project/path"
                  required
                  onChange={(event) => bind('projects', role, event.target.value)}
                />
              </label>
            ))}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={bindings.applySettings}
                onChange={(event) =>
                  setBindings({ ...bindings, applySettings: event.target.checked })
                }
              />
              <span>
                Apply blueprint workspace preferences:{' '}
                {definition.settings.memoryPressurePolicy ?? 'protect'} memory policy, one managed
                slot.
              </span>
            </label>
            <FormError error={error} />
            <div className="form-footer">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDefinition(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Checking bindings…' : 'Review import'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {definition && plan && (
        <Dialog
          title="Review blueprint import"
          subtitle={plan.name}
          onClose={() => {
            setPlan(null);
            setDefinition(null);
            setError('');
          }}
        >
          <div className="dialog-body form-stack blueprint-content">
            <p>
              Create {plan.profiles.length} new profiles and {plan.work.length} ready work records.
              Existing work and native files remain with their current owners.
            </p>
            {plan.profiles.map((profile) => (
              <section className="detail-section" key={profile.role}>
                <h3>{profile.name}</h3>
                <p>
                  {profile.memories.length} selected memory references ·{' '}
                  {profile.companion?.label ?? 'No native activity reference'}
                </p>
                {profile.instructions && <p className="blueprint-text">{profile.instructions}</p>}
                {profile.memories.map((memory) => (
                  <p className="source-note" key={memory.id}>
                    {memory.label} · {memory.owner} · {memory.scope.kind}
                    {memory.scope.kind === 'project' && (
                      <span className="companion-root"> · {memory.scope.root}</span>
                    )}
                  </p>
                ))}
              </section>
            ))}
            {plan.work.map((work) => (
              <details className="native-details" key={work.role}>
                <summary>
                  {work.title} · {work.harness}
                </summary>
                <p className="companion-root">{work.directory}</p>
                <p className="source-note">
                  Account:{' '}
                  {data.accounts.find((account) => account.id === work.account)?.label ??
                    'Unavailable native account'}
                </p>
                {[
                  ['Goal', work.goal],
                  ['Acceptance', work.acceptance],
                  ['Context', work.context],
                ]
                  .filter(([, text]) => text)
                  .map(([label, text]) => (
                    <div className="detail-section" key={label}>
                      <h3>{label}</h3>
                      <p className="blueprint-text">{text}</p>
                    </div>
                  ))}
              </details>
            ))}
            {plan.settings && (
              <p>
                Memory pressure policy: {plan.settings.before.memoryPressurePolicy ?? 'protect'} →{' '}
                {plan.settings.after.memoryPressurePolicy}. Managed slots: 1.
              </p>
            )}
            {plan.warnings.map((warning) => (
              <p className="source-note" key={warning}>
                {warning}
              </p>
            ))}
            <p className="source-note">
              Preview expires at {new Date(plan.expiresAt).toLocaleTimeString()}. Changed bindings
              require another review. Unused imports can be rolled back from this page.
            </p>
            <FormError error={error} />
            <div className="form-footer">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setPlan(null);
                  setError('');
                }}
              >
                Back to bindings
              </button>
              <button
                className="button primary"
                disabled={busy || plan.expiresAt <= data.now}
                onClick={() => void apply()}
              >
                {busy ? 'Importing…' : 'Import setup'}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
