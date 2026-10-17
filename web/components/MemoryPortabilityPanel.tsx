import { useState } from 'react';
import type { AgentProfile, MemoryScope, Snapshot } from '../../shared/types';
import type { MemoryPack, MemoryPackPlan } from '../../shared/memory-packs';
import type { Mutate } from '../api';
import { Dialog, FormError } from './primitives';

export function MemoryPortabilityPanel({
  data,
  profile,
  mutate,
  onInstalled,
  profileDirty,
}: {
  data: Snapshot;
  profile: AgentProfile;
  mutate: Mutate;
  onInstalled: () => void;
  profileDirty: boolean;
}) {
  const [open, setOpen] = useState<'load' | 'bind' | 'review' | null>(null);
  const [definition, setDefinition] = useState('');
  const [pack, setPack] = useState<MemoryPack | null>(null);
  const [plan, setPlan] = useState<MemoryPackPlan | null>(null);
  const [bindings, setBindings] = useState<Record<string, MemoryScope>>({});
  const [replaceInstructions, setReplaceInstructions] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const disabled =
    data.mode !== 'local' ||
    data.access?.kind === 'tailscale' ||
    data.work.some((w) => w.activeRunId) ||
    profileDirty ||
    busy;
  const latest = data.memoryPacks?.find((row) => row.profileId === profile.id);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const scopeText = (scope: MemoryScope) =>
    scope.kind === 'global'
      ? 'Across this profile’s work'
      : scope.kind === 'project'
        ? `Project: ${scope.root}`
        : `One work record: ${scope.workId}`;
  return (
    <section className="panel" aria-label="Portable memory">
      <div className="section-heading">
        <div>
          <h2>Portable memory</h2>
          <p>
            Keep reviewed Markdown copies outside a companion’s home, using the same profile and
            memory scope.
          </p>
        </div>
        <div className="activity-actions">
          <button
            className="button secondary small"
            disabled={disabled || !profile.memorySourceIds.length}
            onClick={() =>
              void perform(async () => {
                setPlan(
                  await mutate<MemoryPackPlan>('/memory/packs/copy', 'POST', {
                    profileId: profile.id,
                    expectedRevision: profile.revision,
                  }),
                );
                setReviewed(false);
                setOpen('review');
              })
            }
          >
            Prepare portable copy
          </button>
          <button
            className="button secondary small"
            disabled={disabled}
            onClick={() => {
              setOpen('load');
              setDefinition('');
              setError('');
              setPack(null);
              setReplaceInstructions(false);
            }}
          >
            Import private pack
          </button>
        </div>
      </div>
      <p className="panel-footnote">
        Copies contain only selected text and preserve scope. Later native memory edits require a
        fresh review. Native search, tools and policies stay with their owner.
      </p>
      {profileDirty && (
        <p className="source-note">Save profile edits before preparing portable memory.</p>
      )}
      {latest && (
        <p className="source-note">
          Last copy: {latest.state}. {latest.detail}{' '}
          <code className="native-rule">{latest.directory}</code>
        </p>
      )}
      {!open && <FormError error={error} />}
      {open && (
        <Dialog
          title={
            open === 'load'
              ? 'Import private memory pack'
              : open === 'bind'
                ? 'Bind imported memory'
                : 'Review portable memory'
          }
          onClose={() => {
            if (!busy) {
              setOpen(null);
              setError('');
            }
          }}
        >
          <form
            className="dialog-form"
            onSubmit={async (event) => {
              event.preventDefault();
              await perform(async () => {
                if (open === 'load') {
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(definition);
                  } catch {
                    throw new Error('Choose a valid private memory pack JSON file.');
                  }
                  const checked = await mutate<MemoryPack>('/memory/packs/parse', 'POST', {
                    definition: parsed,
                  });
                  setPack(checked);
                  setBindings(
                    Object.fromEntries(
                      checked.entries.map((entry) => [
                        entry.key,
                        entry.scope.kind === 'project'
                          ? { kind: 'project', root: '' }
                          : entry.scope.kind === 'work'
                            ? { kind: 'work', workId: '' }
                            : { kind: 'global' },
                      ]),
                    ),
                  );
                  setOpen('bind');
                } else if (open === 'bind' && pack) {
                  setPlan(
                    await mutate<MemoryPackPlan>('/memory/packs/import', 'POST', {
                      profileId: profile.id,
                      expectedRevision: profile.revision,
                      definition: pack,
                      bindings,
                      instructions: replaceInstructions ? 'replace' : 'keep',
                    }),
                  );
                  setReviewed(false);
                  setOpen('review');
                } else if (plan) {
                  await mutate('/memory/packs/apply', 'POST', {
                    planId: plan.id,
                    digest: plan.digest,
                    reviewed: true,
                  });
                  setOpen(null);
                  onInstalled();
                }
              });
            }}
          >
            <div className="dialog-body form-stack">
              {open === 'load' && (
                <>
                  <p>
                    Import selected memory into {profile.name}. You will bind local scopes and
                    review every entry before its references replace the profile’s current memory.
                    Profile identity, companion and execution accounts stay in place.
                  </p>
                  <label>
                    Private memory pack file
                    <input
                      type="file"
                      accept="application/json,.json"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file)
                          void perform(async () => {
                            if (file.size > 384 * 1024)
                              throw new Error('Choose a memory pack JSON file within 384 KiB.');
                            setDefinition(await file.text());
                          });
                      }}
                    />
                  </label>
                  <label>
                    Memory pack JSON
                    <textarea
                      rows={10}
                      value={definition}
                      onChange={(event) => setDefinition(event.target.value)}
                      maxLength={384 * 1024}
                      required
                      spellCheck={false}
                    />
                  </label>
                </>
              )}
              {open === 'bind' && pack && (
                <>
                  <p>
                    Source profile: {pack.profile.name}. Importing preserves each scope kind.
                    Project paths and work records must be bound explicitly on this workspace.
                  </p>
                  {pack.entries.map((entry) => (
                    <div className="form-stack" key={entry.key}>
                      <p>
                        <strong>{entry.label}</strong> · {entry.scope.kind}
                      </p>
                      {entry.scope.kind === 'global' ? (
                        <p>Across this profile’s work.</p>
                      ) : entry.scope.kind === 'project' ? (
                        <label>
                          Local project directory for {entry.label}
                          <input
                            required
                            value={
                              (bindings[entry.key] as Extract<MemoryScope, { kind: 'project' }>)
                                .root
                            }
                            onChange={(event) =>
                              setBindings({
                                ...bindings,
                                [entry.key]: { kind: 'project', root: event.target.value },
                              })
                            }
                          />
                        </label>
                      ) : (
                        <label>
                          Local work for {entry.label}
                          <select
                            required
                            value={
                              (bindings[entry.key] as Extract<MemoryScope, { kind: 'work' }>).workId
                            }
                            onChange={(event) =>
                              setBindings({
                                ...bindings,
                                [entry.key]: { kind: 'work', workId: event.target.value },
                              })
                            }
                          >
                            <option value="">Choose an existing work record</option>
                            {data.work
                              .filter((w) => w.profileId === profile.id)
                              .map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.title}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                    </div>
                  ))}
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={replaceInstructions}
                      onChange={(event) => setReplaceInstructions(event.target.checked)}
                    />
                    Replace this profile’s instructions with the pack’s reviewed instructions.
                  </label>
                </>
              )}
              {open === 'review' && plan && (
                <>
                  <p>
                    Keep profile <strong>{plan.profileName}</strong> and replace its memory
                    references with {plan.pack.entries.length} private Markdown{' '}
                    {plan.pack.entries.length === 1 ? 'copy' : 'copies'}. Original files and
                    unpinned references stay in place. Nothing is activated until you confirm.
                  </p>
                  <p>
                    This two-minute review includes the complete selected text. Copies retain a
                    snapshot; native search and future learned memory are not migrated.
                  </p>
                  <label>
                    Private destination<code className="native-rule">{plan.directory}</code>
                  </label>
                  <label>
                    {plan.instructions === 'replace'
                      ? 'Replacement profile instructions'
                      : 'Profile instructions retained'}
                    <pre className="native-rule">
                      {plan.instructions === 'replace'
                        ? plan.pack.profile.instructions || '(empty)'
                        : plan.currentInstructions || '(empty)'}
                    </pre>
                  </label>
                  {plan.pack.entries.map((entry) => (
                    <div className="form-stack" key={entry.key}>
                      <p>
                        <strong>{entry.label}</strong>
                      </p>
                      <p className="source-note native-rule">
                        {scopeText(plan.bindings.find((b) => b.key === entry.key)!.scope)}
                      </p>
                      <pre className="native-rule">{entry.content || '(empty)'}</pre>
                    </div>
                  ))}
                  <details className="native-details">
                    <summary>Source provenance and content digests</summary>
                    <pre className="native-rule">
                      {JSON.stringify(
                        plan.pack.entries.map(({ content: _content, ...entry }) => entry),
                        null,
                        2,
                      )}
                    </pre>
                    <p>
                      Hashes verify content integrity. Imported provenance does not verify the
                      author or grant execution authority.
                    </p>
                  </details>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(event) => setReviewed(event.target.checked)}
                      required
                    />
                    I reviewed the selected memory, scope and private copy.
                  </label>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!reviewed || busy}
                    onClick={() =>
                      void perform(async () => {
                        const exported = await mutate<MemoryPack>('/memory/packs/export', 'POST', {
                          planId: plan.id,
                          digest: plan.digest,
                          reviewed: true,
                        });
                        const url = URL.createObjectURL(
                            new Blob([JSON.stringify(exported, null, 2)], {
                              type: 'application/json',
                            }),
                          ),
                          link = document.createElement('a');
                        link.href = url;
                        link.download = 'forge-private-memory-pack.json';
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      })
                    }
                  >
                    Download private pack
                  </button>
                  <p className="source-note">
                    Downloaded packs include selected text, profile instructions and local path
                    provenance. Store them privately. Forgetting a reference does not delete copies
                    or previously exported files.
                  </p>
                </>
              )}
              <FormError error={error} />
            </div>
            <footer className="form-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setOpen(null)}
              >
                Cancel
              </button>
              <button className="button" disabled={busy || (open === 'review' && !reviewed)}>
                {busy
                  ? 'Checking memory…'
                  : open === 'load'
                    ? 'Read private pack'
                    : open === 'bind'
                      ? 'Prepare memory review'
                      : 'Use portable files'}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </section>
  );
}
