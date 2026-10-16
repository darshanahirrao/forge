export type WorkspaceMode = 'local' | 'demo';
export type WorkStatus = 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
export type Harness = 'codex' | 'claude' | 'opencode' | 'hermes' | 'openclaw';
export interface Account {
  id: string;
  label: string;
  harness: Harness;
  nativeHome: string;
  /** Environment variable name only. Forge never stores its secret value. */
  credentialEnv?: string;
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
  capsuleId?: string | null;
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
  handoff?: {
    version: 1;
    capsuleId: string;
    from: WorkCapsule['source'];
    to: { harness: Harness; accountId: string };
    fileCount: number;
  };
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
  exitConfirmed?: boolean;
}
export interface ArtifactFingerprint {
  path: string;
  state: 'present' | 'missing';
  sha256: string | null;
  bytes: number;
  mode: number;
}
export interface WorkCapsule {
  format: 'forge.work-capsule';
  version: 1;
  id: string;
  workId: string;
  baseRevision: number;
  parentCapsuleId: string | null;
  generation: number;
  source: {
    harness: Harness;
    accountId: string | null;
    nativeSessionId: string | null;
    runId: string | null;
  };
  title: string;
  goal: string;
  acceptance: string;
  context: string;
  checkpoints: { id: string; note: string; createdAt: string }[];
  results: { eventId: string; excerpt: string; clipped: boolean; createdAt: string }[];
  inventory: 'git' | 'explicit';
  artifacts: ArtifactFingerprint[];
  excluded: { path: string; reason: string }[];
  artifactDigest: string;
  contextDigest: string;
  createdAt: string;
  coverage: string;
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
  source: 'codex/app-server' | 'claude/agent-sdk' | 'ccusage' | 'example';
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
  source:
    'agent-deck' | 'codex/app-server' | 'claude/agent-sdk' | 'hermes/api' | 'openclaw/gateway';
  sourceId?: string;
  updatedAt?: string | null;
  cwd?: string;
  observedAt?: string;
  control?: 'observed';
}
export type NativeSourceKind =
  'codex' | 'claude' | 'codex-schedules' | 'hermes-schedules' | 'hermes' | 'openclaw';
export interface NativeSource {
  id: string;
  kind: NativeSourceKind;
  label: string;
  home: string;
  endpoint: string;
  tokenEnv?: string;
  state: 'configured' | 'connected' | 'error';
  checkedAt: string | null;
  error: string | null;
  capabilities: string[];
  observation?: { sessions: number; schedules: number; moreAvailable: boolean };
}
export interface NativeSchedule {
  id: string;
  sourceId: string;
  title: string;
  owner: 'codex' | 'hermes';
  kind: string;
  state: string;
  rule: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  observedAt: string;
}
export interface NativeInventory {
  sessions: NativeSession[];
  schedules: NativeSchedule[];
  moreAvailable: boolean;
  checkedAt: string;
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
  nativeSources: NativeSource[];
  nativeSchedules: NativeSchedule[];
  hermes: RuntimeProbe;
  now: string;
}
