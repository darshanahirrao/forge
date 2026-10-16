import { type Snapshot, type Approval } from '../../shared/types';
import { ShieldCheck, Terminal, ArrowRight, CheckCheck } from 'lucide-react';
import { Empty } from '../components/primitives';
import { age } from '../lib/format';

export function ApprovalsPage({
  data,
  onApproval,
}: {
  data: Snapshot;
  onApproval: (approval: Approval) => void;
}) {
  const pending = data.approvals.filter((a) => a.status === 'pending');
  const history = data.approvals.filter((a) => a.status !== 'pending');
  return (
    <div className="page-stack">
      <div className="notice">
        <ShieldCheck size={19} />
        <p>
          Decisions are tied to one native request and attempt. Allowing once never creates a
          permanent rule.
        </p>
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>Waiting for you</h2>
          <span className="count-label">{pending.length} requests</span>
        </div>
        {pending.length ? (
          <div className="approval-list">
            {pending.map((a) => (
              <div className="approval-row" key={a.id}>
                <span className="approval-symbol">
                  <Terminal size={21} />
                </span>
                <div>
                  <h3>{a.title}</h3>
                  <p>{data.work.find((w) => w.id === a.workId)?.title}</p>
                  <code>
                    {a.command.length > 120 ? `${a.command.slice(0, 120)}...` : a.command}
                  </code>
                </div>
                <button className="button primary" onClick={() => onApproval(a)}>
                  Review request <ArrowRight size={15} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={ShieldCheck} title="Your attention is clear.">
            Supported native approval requests appear here while a Forge-managed task is waiting.
            Existing desktop sessions keep their native approval controls.
          </Empty>
        )}
      </section>
      {history.length > 0 && (
        <section className="panel">
          <div className="section-heading">
            <h2>Decision history</h2>
          </div>
          <div className="decision-history">
            {history.map((a) => (
              <button key={a.id} onClick={() => onApproval(a)}>
                <CheckCheck size={17} />
                <span>
                  {a.title}
                  <small>{data.work.find((w) => w.id === a.workId)?.title}</small>
                </span>
                <span className="capitalize">{a.status}</span>
                <time>{age(a.resolvedAt)}</time>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
