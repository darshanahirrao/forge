import { type WorkSummary } from '../../shared/types';
import { type View, nav } from '../navigation';
import { useState } from 'react';
import { Dialog } from './primitives';
import { Search, ArrowRight, FileText } from 'lucide-react';

export function SearchDialog({
  work,
  onClose,
  onView,
  onWork,
}: {
  work: WorkSummary[];
  onClose: () => void;
  onView: (view: View) => void;
  onWork: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const views = nav.filter((n) => n.label.toLowerCase().includes(query.toLowerCase()));
  const matches = work
    .filter((w) => `${w.title} ${w.project}`.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 6);
  return (
    <Dialog title="Find your next step." onClose={onClose}>
      <div className="dialog-body command-dialog">
        <label className="command-input">
          <Search size={19} />
          <span className="sr-only">Search views and work</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search work, accounts, connections..."
          />
        </label>
        <span className="eyebrow">WORKSPACE</span>
        <div className="command-results">
          {views.map((item) => (
            <button key={item.id} onClick={() => onView(item.id)}>
              <item.icon size={17} />
              <span>{item.label}</span>
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
        {matches.length > 0 && (
          <>
            <span className="eyebrow">WORK</span>
            <div className="command-results">
              {matches.map((w) => (
                <button key={w.id} onClick={() => onWork(w.id)}>
                  <FileText size={17} />
                  <span>
                    {w.title}
                    <small>{w.project}</small>
                  </span>
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
          </>
        )}
        {!views.length && !matches.length && (
          <p className="source-note">No matching work or views. Try a different term.</p>
        )}
      </div>
    </Dialog>
  );
}
