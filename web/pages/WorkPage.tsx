import { type Snapshot } from '../../shared/types';
import { useState } from 'react';
import { Search, Plus } from 'lucide-react';
import { WorkTable } from '../components/WorkTable';
import { Empty } from '../components/primitives';

export function WorkPage({
  data,
  onWork,
  onNewWork,
}: {
  data: Snapshot;
  onWork: (id: string) => void;
  onNewWork: () => void;
}) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const filtered = data.work.filter(
    (w) =>
      (filter === 'all' || filter === 'attention'
        ? filter !== 'attention' || ['waiting', 'failed', 'interrupted'].includes(w.status)
        : w.status === filter) &&
      `${w.title} ${w.project}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="panel">
      <div className="filter-row">
        <div className="segmented" role="group" aria-label="Filter work">
          {[
            ['all', 'All work'],
            ['ready', 'Ready'],
            ['attention', 'Needs attention'],
            ['completed', 'Turn complete'],
          ].map(([key, label]) => (
            <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        <label className="inline-search">
          <Search size={16} />
          <span className="sr-only">Search work</span>
          <input
            placeholder="Search work"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {filtered.length ? (
        <WorkTable work={filtered} accounts={data.accounts} usage={data.usage} onWork={onWork} />
      ) : (
        <Empty
          title={data.work.length ? 'No work matches this view.' : 'Start with the goal.'}
          action={
            !data.work.length && (
              <button className="button primary" onClick={onNewWork}>
                <Plus size={16} />
                Create work
              </button>
            )
          }
        >
          {data.work.length
            ? 'Try another filter or search term.'
            : 'Save what you want to achieve and the context needed to continue.'}
        </Empty>
      )}
    </section>
  );
}
