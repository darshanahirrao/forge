import { useState, useRef, useEffect, type FormEvent } from 'react';
import { BookOpen, Eye, FolderSearch, LoaderCircle, Plus, Unplug, UserRound } from 'lucide-react';
import type { AgentProfile, MemoryInspection, MemorySource, Snapshot } from '../../shared/types';
import type { Mutate } from '../api';
import { Dialog, Empty, FormError, IconButton } from '../components/primitives';
import { age } from '../lib/format';
import { MemoryPortabilityPanel } from '../components/MemoryPortabilityPanel';

const scopeLabel = (source: MemorySource) =>
  source.scope.kind === 'global'
    ? 'Across this profile’s work'
    : source.scope.kind === 'project'
      ? source.scope.root
      : 'One work record';
type Candidate = { path: string; owner: MemorySource['owner'] };

export function MemoryPage({
  data,
  mutate,
  onActivity,
}: {
  data: Snapshot;
  mutate: Mutate;
  onActivity: () => void;
}) {
  const [selected, setSelected] = useState(data.defaultProfileId);
  const [adding, setAdding] = useState<Candidate | null>(null);
  const [newProfile, setNewProfile] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [preview, setPreview] = useState<{
    source: MemorySource;
    inspection: MemoryInspection;
  } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [profileEpoch, setProfileEpoch] = useState(0);
  const [profileDirty, setProfileDirty] = useState(false);
  const profile = data.profiles.find((profile) => profile.id === selected) ?? data.profiles[0];
  async function perform(key: string, task: () => Promise<void>) {
    setBusy(key);
    setError('');
    try {
      await task();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="page-stack">
      <div className="memory-toolbar">
        <label>
          Profile
          <select value={profile?.id ?? ''} onChange={(event) => setSelected(event.target.value)}>
            {data.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <button className="button secondary" onClick={() => setNewProfile(true)}>
          <Plus size={16} />
          New profile
        </button>
      </div>
      {profile && (
        <ProfileEditor
          key={`${profile.id}:${profileEpoch}`}
          profile={profile}
          data={data}
          mutate={mutate}
          onActivity={onActivity}
          onDirtyChange={setProfileDirty}
        />
      )}
      {profile && (
        <MemoryPortabilityPanel
          data={data}
          profile={profile}
          profileDirty={profileDirty}
          mutate={mutate}
          onInstalled={() => setProfileEpoch((epoch) => epoch + 1)}
        />
      )}
      <section className="panel">
        <div className="section-heading activity-heading">
          <div>
            <h2>Native memory references</h2>
            <p>Files stay with their native owner. Forge selects context and records provenance.</p>
          </div>
          <div className="activity-actions">
            <button
              className="button secondary small"
              disabled={data.mode === 'demo' || !!busy}
              onClick={() =>
                void perform('discover', async () =>
                  setCandidates(await mutate<Candidate[]>('/memory/discover', 'POST')),
                )
              }
            >
              {busy === 'discover' ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <FolderSearch size={15} />
              )}
              Find native files
            </button>
            <button
              className="button secondary small"
              disabled={data.mode === 'demo'}
              onClick={() => setAdding({ path: '', owner: 'markdown' })}
            >
              <Plus size={15} />
              Add memory reference
            </button>
          </div>
        </div>
        {candidates && (
          <div className="memory-candidates">
            <p>
              {candidates.length
                ? 'Known native files. Choose one to inspect before saving a reference.'
                : 'No default native memory files found. Add an explicit Markdown path.'}
            </p>
            {candidates.map((candidate) => (
              <button
                className="text-button"
                key={candidate.path}
                onClick={() => setAdding(candidate)}
              >
                {candidate.owner} · {candidate.path}
              </button>
            ))}
          </div>
        )}
        {data.memorySources.length ? (
          <div className="native-entry-list">
            {data.memorySources.map((source) => (
              <article className="native-entry memory-source-row" key={source.id}>
                <BookOpen size={20} className="native-entry-icon" />
                <div className="native-entry-copy">
                  <h3>{source.label}</h3>
                  <p>
                    {source.owner} · {source.section.join(' / ') || 'Whole file'}
                  </p>
                  <code className="native-location">{source.path}</code>
                  <p>{scopeLabel(source)}</p>
                  <small>
                    Reference verified {age(source.observedAt).toLowerCase()}. Current bytes are
                    checked at launch.
                  </small>
                </div>
                <div className="activity-actions">
                  <button
                    className="button secondary small"
                    disabled={!!busy}
                    onClick={() =>
                      void perform(source.id, async () =>
                        setPreview({
                          source,
                          inspection: await mutate<MemoryInspection>('/memory/inspect', 'POST', {
                            path: source.path,
                            section: source.section,
                          }),
                        }),
                      )
                    }
                  >
                    <Eye size={14} />
                    Preview {source.label}
                  </button>
                  <IconButton
                    label={`Forget memory ${source.label}`}
                    disabled={
                      !!busy ||
                      data.profiles.some((profile) => profile.memorySourceIds.includes(source.id))
                    }
                    onClick={() =>
                      void perform(`forget-${source.id}`, async () => {
                        await mutate(`/memory/sources/${source.id}`, 'DELETE');
                      })
                    }
                  >
                    <Unplug size={16} />
                  </IconButton>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty icon={BookOpen} title="Keep the memory you already trust.">
            Choose a native Markdown file or section from Hermes, OpenClaw, Obsidian or another
            source. Pin it to a profile with a project or work scope.
          </Empty>
        )}
        <div className="panel-footnote">
          <p>
            Unpin a reference from every profile before forgetting it. Native files and earlier
            native conversation history keep their own controls.
          </p>
          <FormError error={error} />
        </div>
      </section>
      {adding && (
        <MemoryForm
          candidate={adding}
          data={data}
          mutate={mutate}
          onClose={() => setAdding(null)}
        />
      )}
      {newProfile && (
        <NewProfile
          mutate={mutate}
          onClose={() => setNewProfile(false)}
          onCreated={(profile) => {
            setNewProfile(false);
            setSelected(profile.id);
          }}
        />
      )}
      {preview && (
        <Dialog
          title={preview.source.label}
          subtitle="CURRENT NATIVE MEMORY"
          onClose={() => setPreview(null)}
        >
          <div className="dialog-body form-stack">
            <MemoryText inspection={preview.inspection} />
            <p className="source-note">
              This preview reads current native bytes. Update or correct the file through its native
              memory tools or editor.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function ProfileEditor({
  profile,
  data,
  mutate,
  onActivity,
  onDirtyChange,
}: {
  profile: AgentProfile;
  data: Snapshot;
  mutate: Mutate;
  onActivity: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(profile.name);
  const [instructions, setInstructions] = useState(profile.instructions);
  const [companion, setCompanion] = useState(profile.companionSourceId ?? '');
  const [pinned, setPinned] = useState(profile.memorySourceIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(profile.revision);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    onDirtyChange(
      name !== profile.name ||
        instructions !== profile.instructions ||
        companion !== (profile.companionSourceId ?? '') ||
        JSON.stringify(pinned) !== JSON.stringify(profile.memorySourceIds),
    );
  }, [name, instructions, companion, pinned, profile, onDirtyChange]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const updated = await mutate<AgentProfile>(`/profiles/${profile.id}`, 'PATCH', {
        name,
        instructions,
        companionSourceId: companion || null,
        memorySourceIds: pinned,
        expectedRevision: revision,
      });
      setRevision(updated.revision);
      setSaved(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const runtimes = data.nativeSources.filter((source) =>
    ['hermes', 'openclaw'].includes(source.kind),
  );
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>{profile.name}</h2>
          <p>Stable profile identity, independent of native account and harness choices.</p>
        </div>
        <UserRound size={20} />
      </div>
      <form className="profile-form form-stack" onSubmit={save}>
        {profile.revision !== revision && !busy && (
          <div className="notice">
            <p>This profile changed in another view. Reload it before saving.</p>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setName(profile.name);
                setInstructions(profile.instructions);
                setCompanion(profile.companionSourceId ?? '');
                setPinned(profile.memorySourceIds);
                setRevision(profile.revision);
                setSaved(false);
              }}
            >
              Reload profile
            </button>
          </div>
        )}
        <div className="form-grid">
          <label>
            Profile name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
            />
          </label>
          <label>
            Companion reference
            <select value={companion} onChange={(event) => setCompanion(event.target.value)}>
              <option value="">Direct harness; no companion selected</option>
              {runtimes.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label} · {source.kind}
                </option>
              ))}
            </select>
            <small>
              A native activity reference. Grant a companion access to this profile from
              Connections.
            </small>
          </label>
        </div>
        {!runtimes.length && data.mode === 'local' && (
          <button type="button" className="text-button" onClick={onActivity}>
            Add Hermes or OpenClaw through Activity
          </button>
        )}
        <label>
          Profile instructions <span className="optional">Optional</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={3}
            maxLength={8000}
            placeholder="How this profile should work across compatible harnesses"
          />
          <small>Native project instructions and tool permissions still apply.</small>
        </label>
        <fieldset className="memory-pins">
          <legend>Selected memory references</legend>
          {data.memorySources.length ? (
            data.memorySources.map((source) => (
              <label className="checkbox-label" key={source.id}>
                <input
                  type="checkbox"
                  checked={pinned.includes(source.id)}
                  onChange={(event) =>
                    setPinned(
                      event.target.checked
                        ? [...pinned, source.id]
                        : pinned.filter((id) => id !== source.id),
                    )
                  }
                />
                <span>
                  {source.label}
                  <small>
                    {source.owner} · {source.section.join(' / ') || 'Whole file'} ·{' '}
                    {scopeLabel(source)}
                  </small>
                </span>
              </label>
            ))
          ) : (
            <p className="source-note">
              Add a memory reference below, then select it here. Only references matching each
              task’s scope are sent.
            </p>
          )}
        </fieldset>
        <details className="native-details">
          <summary>Profile identity and context behavior</summary>
          <p className="mono native-location">{profile.id}</p>
          <p>
            Revision {profile.revision}. Native source files remain authoritative. Changed selected
            memory starts a fresh native conversation while retaining the work record and earlier
            history.
          </p>
        </details>
        <FormError error={error} />
        {saved && (
          <p className="source-note" role="status">
            Profile saved.
          </p>
        )}
        <div className="form-footer">
          <button className="button primary" disabled={busy || profile.revision !== revision}>
            {busy && <LoaderCircle size={16} className="spin" />}Save profile
          </button>
        </div>
      </form>
    </section>
  );
}

function MemoryText({ inspection }: { inspection: MemoryInspection }) {
  return (
    <>
      <p className="source-note">
        {inspection.characters.toLocaleString()} characters · {inspection.bytes.toLocaleString()}{' '}
        source bytes
      </p>
      {inspection.content !== null ? (
        <pre className="memory-excerpt" tabIndex={0} aria-label="Selected memory text">
          {inspection.content}
        </pre>
      ) : (
        <p className="form-error">
          This selection exceeds 32,000 characters. Choose a smaller section.
        </p>
      )}
      <details className="native-details">
        <summary>Source fingerprints</summary>
        <p className="mono native-location">File SHA-256: {inspection.sha256}</p>
        <p className="mono native-location">Selection SHA-256: {inspection.selectionSha256}</p>
      </details>
    </>
  );
}
function MemoryForm({
  candidate,
  data,
  mutate,
  onClose,
}: {
  candidate: Candidate;
  data: Snapshot;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [path, setPath] = useState(candidate.path);
  const [label, setLabel] = useState(candidate.path ? `${candidate.owner} memory` : '');
  const [owner, setOwner] = useState(candidate.owner);
  const [scope, setScope] = useState('project');
  const [root, setRoot] = useState('');
  const [workId, setWorkId] = useState(data.work[0]?.id ?? '');
  const [section, setSection] = useState<string[]>([]);
  const [inspection, setInspection] = useState<MemoryInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  async function inspect(nextSection: string[]) {
    const request = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const result = await mutate<MemoryInspection>('/memory/inspect', 'POST', {
        path,
        section: nextSection,
      });
      if (request === sequence.current) {
        setInspection(result);
        setSection(nextSection);
      }
    } catch (cause) {
      if (request === sequence.current) {
        setError((cause as Error).message);
        setInspection(null);
      }
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!inspection) return;
    setBusy(true);
    setError('');
    try {
      await mutate('/memory/sources', 'POST', {
        label,
        owner,
        path: inspection.path,
        section,
        scope:
          scope === 'global'
            ? { kind: 'global' }
            : scope === 'project'
              ? { kind: 'project', root }
              : { kind: 'work', workId },
        expectedSha256: inspection.sha256,
        expectedSelectionSha256: inspection.selectionSha256,
      });
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Choose native memory." subtitle="SCOPED REFERENCE" onClose={onClose}>
      <form className="dialog-body form-stack" onSubmit={save}>
        <label>
          Memory label
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={100}
            required
          />
        </label>
        <label>
          Native owner
          <select
            value={owner}
            onChange={(event) => setOwner(event.target.value as MemorySource['owner'])}
          >
            {['hermes', 'openclaw', 'obsidian', 'markdown'].map((owner) => (
              <option key={owner} value={owner}>
                {owner}
              </option>
            ))}
          </select>
        </label>
        <label>
          Markdown file
          <input
            value={path}
            onChange={(event) => {
              sequence.current++;
              setPath(event.target.value);
              setInspection(null);
              setBusy(false);
            }}
            placeholder="/absolute/path/to/MEMORY.md"
            maxLength={2000}
            required
          />
        </label>
        <button
          className="button secondary"
          type="button"
          disabled={busy || !path}
          onClick={() => void inspect([])}
        >
          {busy ? <LoaderCircle size={16} className="spin" /> : <Eye size={16} />}Inspect native
          file
        </button>
        {inspection && (
          <>
            <label>
              Memory section
              <select
                value={JSON.stringify(section)}
                onChange={(event) => void inspect(JSON.parse(event.target.value))}
                disabled={busy}
              >
                <option value="[]">Whole file</option>
                {inspection.sections.map((section, index) => (
                  <option key={index} value={JSON.stringify(section.path)}>
                    {section.path.join(' / ')} · {section.characters.toLocaleString()} characters
                  </option>
                ))}
              </select>
            </label>
            <MemoryText inspection={inspection} />
          </>
        )}
        <label>
          Available to
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="project">One project and its subdirectories</option>
            <option value="work">One work record</option>
            <option value="global">All work using a profile that pins this reference</option>
          </select>
        </label>
        {scope === 'project' && (
          <label>
            Memory project directory
            <input
              value={root}
              onChange={(event) => setRoot(event.target.value)}
              placeholder="/absolute/path/to/project"
              required
            />
          </label>
        )}
        {scope === 'work' && (
          <label>
            Memory work record
            <select value={workId} onChange={(event) => setWorkId(event.target.value)} required>
              <option value="">Choose work</option>
              {data.work.map((work) => (
                <option key={work.id} value={work.id}>
                  {work.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="source-note">
          Saving records the path, selection and scope. Native memory text is not copied into
          Forge’s source registry. The selected context is reviewed again before launch.
        </p>
        <FormError error={error} />
        <div className="form-footer handoff-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !inspection || inspection.tooLarge}>
            {busy && <LoaderCircle size={16} className="spin" />}Save memory reference
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function NewProfile({
  mutate,
  onClose,
  onCreated,
}: {
  mutate: Mutate;
  onClose: () => void;
  onCreated: (profile: AgentProfile) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onCreated(await mutate<AgentProfile>('/profiles', 'POST', { name }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="A profile that stays with you." subtitle="PERSISTENT IDENTITY" onClose={onClose}>
      <form className="dialog-body form-stack" onSubmit={submit}>
        <label>
          New profile name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            required
            autoFocus
            data-autofocus=""
          />
        </label>
        <p className="source-note">
          Choose memory and companion references after creating it. Native accounts stay separate.
        </p>
        <FormError error={error} />
        <div className="form-footer">
          <button className="button primary" disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}Create profile
          </button>
        </div>
      </form>
    </Dialog>
  );
}
