import type { NativeRecoveryRow, NativeRecoverySnapshot } from '../../shared/recovery';
import type { WorkSummary } from '../../shared/types';

export function NativeRecovery({
  recovery,
  work,
  busy,
  onReconcile,
  onWork,
}: {
  recovery?: NativeRecoverySnapshot;
  work: WorkSummary[];
  busy: string;
  onReconcile?: (row: NativeRecoveryRow) => void;
  onWork?: (id: string) => void;
}) {
  if (!recovery?.rows.length) return null;
  return (
    <section className="panel" aria-label="Interrupted worker recovery">
      <div className="section-heading">
        <div>
          <h2>Interrupted worker recovery</h2>
          <p>New managed work waits until prior native exits are verified.</p>
        </div>
      </div>
      <div className="native-worker-list">
        {recovery.rows.map((row) => (
          <article className="native-worker-row native-recovery-row" key={row.runId}>
            <div className="native-worker-work">
              <strong>
                {work.find((item) => item.id === row.workId)?.title ?? 'Saved native work'}
              </strong>
              <span>
                {row.state === 'ready'
                  ? 'Exit evidence ready for review'
                  : row.state === 'waiting'
                    ? 'Waiting for native closure'
                    : 'Native exit remains uncertain'}
              </span>
              <small>{row.detail}</small>
            </div>
            {row.state === 'ready' && row.digest ? (
              <button
                className="button secondary"
                disabled={Boolean(busy)}
                onClick={() => onReconcile?.(row)}
              >
                Reconcile native exit
              </button>
            ) : (
              <button className="text-button" onClick={() => onWork?.(row.workId)}>
                Review work
              </button>
            )}
          </article>
        ))}
      </div>
      <p className="source-note native-worker-note">
        Reconciliation releases the native worker reservation. It does not retry work, restore
        approvals, confirm external effects or clear unknown costs. A missing PID provides no exit
        evidence.
      </p>
    </section>
  );
}
