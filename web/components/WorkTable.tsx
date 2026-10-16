import { type WorkSummary, type Account, type Usage } from '../../shared/types';
import { Folder, ChevronRight } from 'lucide-react';
import { HarnessMark, Status, IconButton } from './primitives';
import { names, currency } from '../lib/format';

export function WorkTable({
  work,
  accounts,
  usage,
  onWork,
}: {
  work: WorkSummary[];
  accounts: Account[];
  usage: Usage[];
  onWork: (id: string) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="work-table">
        <thead>
          <tr>
            <th scope="col">Work</th>
            <th scope="col">Harness &amp; account</th>
            <th scope="col">State</th>
            <th scope="col" className="align-right">
              Estimate
            </th>
            <th scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {work.map((w) => {
            const entries = usage.filter((u) => u.workId === w.id && u.estimatedUsd !== null);
            return (
              <tr key={w.id}>
                <td>
                  <button className="work-title" onClick={() => onWork(w.id)}>
                    {w.title}
                  </button>
                  <span className="work-project">
                    <Folder size={12} />
                    {w.project}
                  </span>
                </td>
                <td>
                  <div className="work-binding">
                    <HarnessMark harness={w.harness} />
                    <span>
                      {names[w.harness]}
                      <small>
                        {accounts.find((a) => a.id === w.accountId)?.label ??
                          'Account not selected'}
                      </small>
                    </span>
                  </div>
                </td>
                <td>
                  <Status value={w.status} />
                </td>
                <td className="align-right mono">
                  {entries.length ? (
                    currency(entries.reduce((sum, u) => sum + u.estimatedUsd!, 0))
                  ) : (
                    <span className="muted">Unknown</span>
                  )}
                </td>
                <td>
                  <IconButton label={`Open ${w.title}`} onClick={() => onWork(w.id)}>
                    <ChevronRight size={16} />
                  </IconButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
