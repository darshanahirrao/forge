import {
  Activity,
  Layers3,
  PanelsTopLeft,
  Plug,
  ShieldCheck,
  UsersRound,
  Radio,
  BookOpen,
} from 'lucide-react';
export type View =
  | 'overview'
  | 'work'
  | 'activity'
  | 'memory'
  | 'approvals'
  | 'accounts'
  | 'resources'
  | 'connections';
export const nav = [
  { id: 'overview', label: 'Workspace', icon: PanelsTopLeft },
  { id: 'work', label: 'Work', icon: Layers3 },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'activity', label: 'Activity', icon: Radio },
  { id: 'resources', label: 'Resources', icon: Activity },
  { id: 'memory', label: 'Memory', icon: BookOpen },
  { id: 'accounts', label: 'Accounts', icon: UsersRound },
  { id: 'connections', label: 'Connections', icon: Plug },
] as const;
