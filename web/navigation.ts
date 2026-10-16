import {
  Activity,
  Layers3,
  LayoutDashboard,
  Plug,
  ShieldCheck,
  UsersRound,
  Radio,
} from 'lucide-react';
export type View =
  'overview' | 'work' | 'activity' | 'approvals' | 'accounts' | 'resources' | 'connections';
export const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'work', label: 'Work', icon: Layers3 },
  { id: 'activity', label: 'Activity', icon: Radio },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'accounts', label: 'Accounts', icon: UsersRound },
  { id: 'resources', label: 'Resources', icon: Activity },
  { id: 'connections', label: 'Connections', icon: Plug },
] as const;
