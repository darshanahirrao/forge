import type { NativeSession, NativeSource, WorkSummary } from '../../shared/types';
import { type View, nav } from '../navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './primitives';
import { Search, ArrowRight, FileText, MessageSquare } from 'lucide-react';

export interface WorkspaceCommand {
  id: string;
  label: string;
  detail: string;
  icon: typeof Search;
  run: () => void;
}

export function SearchDialog({
  work,
  nativeSessions,
  nativeSources,
  commands,
  onClose,
  onView,
  onWork,
  onNative,
}: {
  work: WorkSummary[];
  nativeSessions: NativeSession[];
  nativeSources: NativeSource[];
  commands: WorkspaceCommand[];
  onClose: () => void;
  onView: (view: View) => void;
  onWork: (id: string) => void;
  onNative: (session: NativeSession) => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listId = useId();
  const hintId = useId();
  const list = useRef<HTMLDivElement>(null);
  const actionsOnly = query.trimStart().startsWith('>');
  const term = (actionsOnly ? query.trimStart().slice(1) : query).trim().toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(term);
  const sources = new Map(nativeSources.map((source) => [source.id, source.label]));
  const results: WorkspaceCommand[] = [
    ...commands
      .filter((command) => matches(`${command.label} ${command.detail}`))
      .map((command) => ({ ...command, detail: `Action · ${command.detail}` })),
    ...(!actionsOnly
      ? [
          ...nav
            .filter((item) => matches(item.label))
            .map((item) => ({
              id: `view:${item.id}`,
              label: item.label,
              detail: 'View',
              icon: item.icon,
              run: () => onView(item.id),
            })),
          ...work
            .filter((item) => matches(`${item.title} ${item.project} ${item.cwd} ${item.harness}`))
            .slice(0, 8)
            .map((item) => ({
              id: `work:${item.id}`,
              label: item.title,
              detail: `Managed · ${item.project} · ${item.harness}`,
              icon: FileText,
              run: () => onWork(item.id),
            })),
          ...[...nativeSessions]
            .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
            .filter((item) =>
              matches(
                `${item.title} ${item.project} ${item.cwd ?? ''} ${item.harness} ${sources.get(item.sourceId ?? '') ?? ''}`,
              ),
            )
            .slice(0, 8)
            .map((item) => ({
              id: `native:${item.sourceId ?? item.source}:${item.id}`,
              label: item.title || 'Untitled native session',
              detail: `Native observation · ${item.project} · ${item.harness}`,
              icon: MessageSquare,
              run: () => onNative(item),
            })),
        ]
      : []),
  ];
  const active = Math.min(index, Math.max(0, results.length - 1));
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);
  function choose(result?: WorkspaceCommand) {
    if (!result) return;
    onClose();
    result.run();
  }
  return (
    <Dialog title="Commands" onClose={onClose}>
      <div className="dialog-body command-dialog">
        <label className="command-input">
          <Search size={18} />
          <span className="sr-only">Search commands and work</span>
          <input
            autoFocus
            data-autofocus=""
            value={query}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-describedby={hintId}
            aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (results.length)
                  setIndex(
                    (active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) %
                      results.length,
                  );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(results[active]);
              }
            }}
            placeholder="Search work, views or > actions"
          />
        </label>
        <div
          className="command-results"
          role="listbox"
          aria-label="Commands and work"
          id={listId}
          ref={list}
        >
          {results.map((result, itemIndex) => (
            <button
              key={result.id}
              id={`${listId}-${itemIndex}`}
              role="option"
              aria-selected={active === itemIndex}
              tabIndex={-1}
              onClick={() => choose(result)}
              onPointerMove={() => setIndex(itemIndex)}
            >
              <result.icon size={17} />
              <span>
                {result.label}
                <small>{result.detail}</small>
              </span>
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
        {!results.length && (
          <p className="source-note" role="status">
            No matches. Try another title, project, harness or action.
          </p>
        )}
        <p className="command-hint" id={hintId}>
          Up / Down to select · Enter to open · Escape to close
        </p>
      </div>
    </Dialog>
  );
}
