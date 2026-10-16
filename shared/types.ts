export type WorkspaceMode = 'local' | 'demo';
export type WorkStatus = 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
export type Harness = 'codex' | 'claude' | 'opencode' | 'hermes' | 'openclaw';
export interface Account {
  id: string;
  label: string;
  harness: Harness;
  nativeHome: string;
  billingMode: 'native' | 'subscription' | 'api';
  state: 'configured' | 'verified' | 'unavailable';
  identity: string | null;
  identityKey: string | null;
  plan: string | null;
  checkedAt: string | null;
  error: string | null;
  quotas: QuotaWindow[];
  ordinaryUsageAllowed?: boolean | null;
  createdAt: string;
}
export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  scope: string;
  source: 'native' | 'example';
  observedAt: string;
}
export interface Work {
  id: string;
  title: string;
  project: string;
  cwd: string;
  goal: string;
  acceptance: string;
  context: string;
  harness: Harness;
  accountId: string | null;
  status: WorkStatus;
  priority: 'normal' | 'high';
  generation: number;
  revision: number;
  nativeSessionId: string | null;
  activeRunId: string | null;
  createdAt: string;
  updatedAt: string;
}
export type WorkSummary = Omit<Work, 'goal' | 'acceptance' | 'context'>;
export interface WorkEvent {
  id: string;
  workId: string;
  kind: string;
  title: string;
  detail: string;
  createdAt: string;
  generation: number;
}
export interface Run {
  id: string;
  workId: string;
  accountId: string;
  generation: number;
  nativeSessionId: string | null;
  nativeTurnId: string | null;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  endedAt: string | null;
}
export interface Approval {
  id: string;
  workId: string;
  runId: string;
  generation: number;
  nativeRequestId: string | number;
  method: string;
  digest: string;
  title: string;
  detail: string;
  command: string;
  cwd: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'invalidated' | 'uncertain';
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
}
export interface Usage {
  key: string;
  workId: string | null;
  accountId: string | null;
  harness: Harness;
  source: 'codex/app-server' | 'ccusage' | 'example';
  scope: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedUsd: number | null;
  observedAt: string;
}
export interface Settings {
  quietMode: boolean;
  maxConcurrent: number;
}
export interface Connection {
  id: string;
  name: string;
  kind: 'harness' | 'runtime' | 'source';
  installed: boolean;
  capabilities: string[];
  description: string;
  documentation: string;
}
export interface NativeSession {
  id: string;
  title: string;
  harness: string;
  status: string;
  project: string;
  source: 'agent-deck';
}
export interface RuntimeProbe {
  status: 'connected' | 'disconnected' | 'error';
  endpoint: string;
  version: string | null;
  capabilities: string[];
  checkedAt: string | null;
  error: string | null;
}
export interface MachineSnapshot {
  platform: string;
  cpuPercent: number | null;
  cores: number;
  totalMemory: number;
  freeMemory: number;
  loadAverage: number[];
  forgeRss: number;
  uptimeSeconds: number;
  sampledAt: string;
  processCoverage: 'available' | 'unavailable';
  processes: { pid: number; parentPid: number; name: string; rss: number; cpuPercent: number }[];
}
export interface Snapshot {
  mode: WorkspaceMode;
  version: string;
  csrf: string;
  work: WorkSummary[];
  accounts: Account[];
  approvals: Approval[];
  events: WorkEvent[];
  usage: Usage[];
  settings: Settings;
  connections: Connection[];
  machine: MachineSnapshot;
  nativeSessions: NativeSession[];
  hermes: RuntimeProbe;
  now: string;
}
