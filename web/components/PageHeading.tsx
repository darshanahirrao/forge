import { type View } from '../navigation';
import { type WorkspaceMode } from '../../shared/types';
import { Plus, RefreshCw } from 'lucide-react';

export function PageHeading({
  view,
  mode,
  onNewWork,
  onNewAccount,
  onRefresh,
  busy,
}: {
  view: View;
  mode: WorkspaceMode;
  onNewWork: () => void;
  onNewAccount: () => void;
  onRefresh: () => void;
  busy: string;
}) {
  const copy: Record<View, [string, string]> = {
    overview: ['Workspace', 'Your work across harnesses.'],
    work: ['Work', 'Goals, context and native attempts.'],
    memory: ['Memory', 'Persistent profiles and selected native memory.'],
    approvals: ['Approvals', 'Review each exact request before deciding.'],
    activity: ['Activity', 'Native chats, schedules and source connections.'],
    accounts: ['Accounts', 'Existing native identities and reported limits.'],
    resources: ['Resources', 'Machine headroom and owned worker usage.'],
    connections: ['Connections', 'Native tools, companion runtime and background service.'],
  };
  return (
    <div className="page-heading">
      <div>
        <h1>{copy[view][0]}</h1>
        <p>{copy[view][1]}</p>
      </div>
      {view === 'overview' || view === 'work' ? (
        <button className="button primary" onClick={onNewWork}>
          <Plus size={17} />
          New work
        </button>
      ) : view === 'accounts' ? (
        <button className="button primary" onClick={onNewAccount}>
          <Plus size={17} />
          Add account
        </button>
      ) : view === 'connections' ? (
        <button className="button secondary" disabled={busy === 'refresh'} onClick={onRefresh}>
          <RefreshCw size={16} className={busy === 'refresh' ? 'spin' : ''} />
          Rescan installations
        </button>
      ) : (
        <span className="heading-note">
          {mode === 'demo' && view !== 'resources' ? 'Fictional examples' : 'Local workspace'}
        </span>
      )}
    </div>
  );
}
