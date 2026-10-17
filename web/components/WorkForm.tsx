import {
  type Account,
  type Work,
  type WorkspaceMode,
  type Harness,
  type AgentProfile,
} from '../../shared/types';
import { type Mutate } from '../api';
import { useState, type FormEvent } from 'react';
import { Dialog, FormError } from './primitives';
import { names, harnessName } from '../lib/format';
import { LoaderCircle } from 'lucide-react';

export function WorkForm({
  accounts,
  profiles,
  defaultProfileId,
  initial,
  mode,
  mutate,
  onClose,
  onCreated,
}: {
  accounts: Account[];
  profiles: AgentProfile[];
  defaultProfileId: string;
  initial: Work | null;
  mode: WorkspaceMode;
  mutate: Mutate;
  onClose: () => void;
  onCreated: (work: Work) => void;
}) {
  const [harness, setHarness] = useState<Harness>(initial?.harness ?? 'codex');
  const [accountId, setAccountId] = useState(initial?.accountId ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      const work = await mutate<Work>(
        initial ? `/work/${initial.id}` : '/work',
        initial ? 'PATCH' : 'POST',
        {
          title: form.get('title'),
          project: form.get('project'),
          cwd: form.get('cwd'),
          goal: form.get('goal'),
          acceptance: form.get('acceptance'),
          context: form.get('context'),
          harness,
          accountId: accountId || null,
          priority: form.get('priority'),
          profileId: form.get('profileId'),
          ...(initial ? { expectedRevision: initial.revision } : {}),
        },
      );
      onCreated(work);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog title={initial ? 'Edit work' : 'New work'} onClose={onClose}>
      <form onSubmit={save} className="dialog-body form-stack">
        <label>
          Work title
          <input
            name="title"
            defaultValue={initial?.title}
            placeholder="A clear outcome, in a few words"
            maxLength={140}
            required
            autoFocus
            data-autofocus=""
          />
        </label>
        <label>
          Goal
          <textarea
            name="goal"
            rows={3}
            defaultValue={initial?.goal}
            placeholder="What should be true when this work is finished?"
            maxLength={20000}
            required
          />
        </label>
        <div className="form-grid">
          <label>
            Harness
            <select
              value={harness}
              disabled={Boolean(initial?.nativeSessionId || initial?.capsuleId)}
              onChange={(e) => {
                setHarness(e.target.value as Harness);
                setAccountId('');
              }}
            >
              {[
                ...new Set([...Object.keys(names), ...accounts.map((account) => account.harness)]),
              ].map((key) => (
                <option key={key} value={key}>
                  {harnessName(key)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Account
            <select
              value={accountId}
              disabled={Boolean(initial?.nativeSessionId || initial?.capsuleId)}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Choose later</option>
              {accounts
                .filter((a) => a.harness === harness)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label>
          Project directory <span className="optional">Optional until launch</span>
          <input
            name="cwd"
            defaultValue={initial?.cwd}
            placeholder="Absolute path to an existing project"
            readOnly={Boolean(initial?.nativeSessionId || initial?.capsuleId)}
          />
          <small>
            {mode === 'demo'
              ? 'Demo work never accesses this path.'
              : 'Select the native account and an existing directory before launching. Saving work starts no worker.'}
          </small>
        </label>
        <details className="form-options" open={initial ? true : undefined}>
          <summary>Additional context and options</summary>
          <div className="form-stack">
            <div className="form-grid">
              <label>
                Project
                <input
                  name="project"
                  defaultValue={initial?.project ?? 'Personal'}
                  maxLength={80}
                  required
                />
              </label>
              <label>
                Priority
                <select name="priority" defaultValue={initial?.priority ?? 'normal'}>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </label>
            </div>
            <label>
              Persistent profile
              <select name="profileId" defaultValue={initial?.profileId ?? defaultProfileId}>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <small>
                Its selected memory is reviewed before launch. Changing remembered context starts a
                fresh native session.
              </small>
            </label>
            <label>
              Acceptance criteria <span className="optional">Optional</span>
              <textarea
                name="acceptance"
                rows={2}
                defaultValue={initial?.acceptance}
                placeholder="How will you know it worked?"
                maxLength={10000}
              />
            </label>
            <label>
              Context to carry forward <span className="optional">Optional</span>
              <textarea
                name="context"
                rows={4}
                defaultValue={initial?.context}
                placeholder="Decisions, useful sources, constraints, and where to pick up."
                maxLength={50000}
              />
            </label>
          </div>
        </details>
        <FormError error={error} />
        <div className="form-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving}>
            {saving && <LoaderCircle className="spin" size={16} />}
            {initial ? 'Save context' : 'Create work'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
