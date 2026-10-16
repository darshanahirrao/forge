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
  const copy: Record<View, [string, string, string]> = {
    overview: [
      'THE BIG PICTURE',
      'Your workspace, in focus.',
      'One place to see what matters and pick up where you left off.',
    ],
    work: [
      'CONTINUOUS WORK',
      'Every task has a thread.',
      'Goals, context, decisions, and native activity stay with the work.',
    ],
    memory: [
      'PORTABLE CONTEXT',
      'Same identity. Persistent memory.',
      'Keep native memory references and profile choices with your workspace.',
    ],
    approvals: [
      'YOUR ATTENTION',
      'Decisions that move work forward.',
      'Review the exact native request and respond to this attempt once.',
    ],
    activity: [
      'ACROSS YOUR TOOLS',
      'Everything has a home.',
      'Native chats and schedules, with their owner and last observation in view.',
    ],
    accounts: [
      'YOUR CAPACITY',
      'Many accounts. One workspace.',
      'Keep native identities and limits visible without scattering your work.',
    ],
    resources: [
      'MACHINE CAPACITY',
      'Keep room for what matters.',
      'Live operating-system telemetry, with ownership and coverage made clear.',
    ],
    connections: [
      'BUILD IT YOUR WAY',
      'Your tools, working together.',
      'Native capabilities connected through small, explicit adapters.',
    ],
  };
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{copy[view][0]}</span>
        <h1>{copy[view][1]}</h1>
        <p>{copy[view][2]}</p>
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
