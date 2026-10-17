import { useState, type FormEvent } from 'react';
import type {
  NativeResourceConfiguration,
  NativeResourceSnapshot,
  NativeResourceReceipt,
} from '../../shared/resource-governance';
import { Dialog, FormError } from './primitives';

export function NativeResourceSummary({ receipt }: { receipt: NativeResourceReceipt }) {
  return (
    <p className="source-note">
      {receipt.lowPriority ? 'Lower native scheduling priority' : 'Native scheduling defaults'}
      {receipt.rootMemoryMiB === null
        ? ' · Native memory defaults'
        : ` · ${receipt.rootMemoryMiB} MiB limit on the original native process`}
      . Descendants and detached work retain their native policies.
    </p>
  );
}

export function NativeResourceControls({
  data,
  configure,
}: {
  data?: NativeResourceSnapshot;
  configure?: (value: NativeResourceConfiguration) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false),
    [lowPriority, setLowPriority] = useState(false),
    [memory, setMemory] = useState(''),
    [revision, setRevision] = useState(0);
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (!data || !configure) return null;
  const active = data.policy.lowPriority || data.policy.rootMemoryMiB !== null;
  const open = () => {
    setLowPriority(data.policy.lowPriority);
    setMemory(data.policy.rootMemoryMiB === null ? '' : String(data.policy.rootMemoryMiB));
    setRevision(data.policy.revision);
    setConfirmed(false);
    setError('');
    setEditing(true);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await configure({
        expectedRevision: revision,
        lowPriority,
        rootMemoryMiB: memory.trim() === '' ? null : Number(memory),
        effectsReviewed: true,
      });
      setEditing(false);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel" aria-label="Native process resource policy">
      <div className="section-heading">
        <div>
          <h2>Native process policy</h2>
          <p>
            {active
              ? `${data.policy.lowPriority ? 'Lower priority' : 'Native scheduling'} · ${data.policy.rootMemoryMiB === null ? 'Native memory defaults' : `${data.policy.rootMemoryMiB} MiB per original native process`}`
              : 'Native scheduling and memory defaults'}
          </p>
        </div>
        <button className="button secondary" onClick={open} disabled={!data.supported && !active}>
          Review policy
        </button>
      </div>
      {data.reviewNeeded && (
        <p className="source-note" role="status">
          Review required before new native launches.
        </p>
      )}
      <details className="resource-coverage">
        <summary>Scope and native support</summary>
        <p className="source-note">{data.detail}</p>
        <p className="source-note">
          The policy applies to future Forge-owned native processes. Existing processes keep their
          launch policy. Memory limits can terminate a process; descendants, remote backends and
          detached effects need their own native controls.
        </p>
      </details>
      {editing && (
        <Dialog
          title="Native process policy"
          onClose={() => {
            if (!busy) setEditing(false);
          }}
        >
          <form className="dialog-form" onSubmit={save}>
            <div className="dialog-body form-stack">
              <p>
                Apply native OS policy to new owned agent processes. Existing work and gateways keep
                their recorded launch policy.
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={lowPriority}
                  onChange={(event) => setLowPriority(event.target.checked)}
                  disabled={!data.supported || busy}
                />
                Favor foreground apps
              </label>
              <label>
                Original native process memory limit (MiB)
                <input
                  type="number"
                  min={64}
                  max={65536}
                  step={1}
                  value={memory}
                  placeholder="Native default"
                  onChange={(event) => setMemory(event.target.value)}
                  disabled={!data.supported || busy}
                />
              </label>
              <p className="source-note">
                Utility priority favors foreground apps without a CPU percentage cap. Leave the
                memory field empty for native defaults. This limit covers the original native
                process, not the sum of its descendants. A limit that is too small can prevent
                startup or end a turn; original exit evidence and spending still require review.
              </p>
              {!data.supported && (
                <p className="source-note">
                  Native policy is unavailable here. Restore defaults to release the launch hold.
                </p>
              )}
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setLowPriority(false);
                  setMemory('');
                  setConfirmed(false);
                }}
              >
                Use native defaults
              </button>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={busy}
                />
                I reviewed the scope and effect on future native launches.
              </label>
              <FormError error={error} />
            </div>
            <div className="form-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={
                  busy || !confirmed || (!data.supported && (lowPriority || memory.trim() !== ''))
                }
              >
                {busy ? 'Checking native policy…' : 'Apply policy'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
