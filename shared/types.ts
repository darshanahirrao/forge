export type WorkspaceMode = 'local' | 'demo';
export type WorkStatus = 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
export type BuiltinHarness = 'codex' | 'claude' | 'opencode' | 'hermes' | 'openclaw';
export type Harness = string;
export interface BackendAccountReference {
  id: string;
  instanceId: string;
  model: string;
  projectId?: string;
}
export interface WorkspaceBackend {
  contractVersion: 1;
  id: string;
  kind: 't3';
  label: string;
  endpoint: string;
  environmentId: string;
  state: 'connected' | 'error' | 'disconnected';
  checkedAt: string;
  error: string | null;
  providerCount: number;
}

export interface Account {
  connector?: { id: string; digest: string };
  connectorReady?: boolean;
  backend?: BackendAccountReference;
  models?: string[];
  providerReady?: boolean;
  id: string;
  label: string;
  harness: Harness;
  nativeHome: string;
  /** Environment variable name only. Forge never stores its secret value. */
  credentialEnv?: string;
  credentialReference?: import('./credentials.js').CredentialReference;
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
  createdBy?: CompanionActor;
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
  /** Native routing key, when it differs from the stable session identity. */
  nativeSessionKey?: string | null;
  activeRunId: string | null;
  stopRequestedAt?: string | null;
  capsuleId?: string | null;
  profileId?: string;
  contextReceipt?: ContextReceipt;
  createdAt: string;
  updatedAt: string;
}
export type WorkSummary = Omit<Work, 'goal' | 'acceptance' | 'context' | 'contextReceipt'>;
export interface WorkEvent {
  id: string;
  workId: string;
  kind: string;
  title: string;
  detail: string;
  createdAt: string;
  generation: number;
  actor?: CompanionActor;
  handoff?: {
    version: 1;
    capsuleId: string;
    from: WorkCapsule['source'];
    to: { harness: Harness; accountId: string };
    fileCount: number;
  };
}
export interface CompanionActor {
  kind: 'companion';
  grantId: string;
  label: string;
  requestId: string;
}
export type CompanionScope = 'work:read' | 'context:read' | 'work:write' | 'work:dispatch';
export interface CompanionGrant {
  contractVersion: 1;
  id: string;
  label: string;
  profileId: string;
  root: string;
  scopes: CompanionScope[];
  accountIds: string[];
  dispatch: { allowMetered: boolean; maxRuns: number } | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  runsStarted: number;
}
export interface Run {
  requestedBy?: CompanionActor;
  id: string;
  workId: string;
  accountId: string;
  harness?: Harness;
  generation: number;
  nativeSessionId: string | null;
  nativeSessionKey?: string | null;
  nativeTurnId: string | null;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  endedAt: string | null;
  exitConfirmed?: boolean;
  settlement?: {
    kind: 'delegated-run';
    backendId: string;
    threadId: string;
    messageId: string;
    runId: string | null;
    state: string;
    confirmed: boolean;
    observedAt: string;
    continuity?: {
      mode: 'fresh' | 'native-resume' | 'portable-handoff' | 'unverified';
      nativeThreadId: string;
      sourceNativeThreadId?: string;
      strategy?: string;
    };
  };
  contextReceipt?: ContextReceipt;
  nativeWorker?: NativeWorkerIdentity;
}
export interface NativeWorkerIdentity {
  version: 1;
  pid: number;
  ownerPid: number;
  uid: number | null;
  startedAt: string | null;
  capturedAt: string;
}
export interface NativeWorkerResources {
  runId: string;
  workId: string;
  accountId: string;
  harness: Harness;
  root: NativeWorkerIdentity;
  state: 'live' | 'not-observed' | 'identity-changed' | 'ambiguous' | 'unavailable' | 'exited';
  pids: number[];
  rss: number | null;
  cpuPercent: number | null;
  sampledAt: string;
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
    nativeSessionKey?: string | null;
    runId: string | null;
    settlement?: Run['settlement'];
  };
  title: string;
  goal: string;
  acceptance: string;
  context: string;
  checkpoints: { id: string; note: string; createdAt: string; actor?: CompanionActor }[];
  results: { eventId: string; excerpt: string; clipped: boolean; createdAt: string }[];
  inventory: 'git' | 'explicit';
  artifacts: ArtifactFingerprint[];
  excluded: { path: string; reason: string }[];
  artifactDigest: string;
  contextDigest: string;
  createdAt: string;
  coverage: string;
  contextReceipt?: ContextReceipt;
}
export type MemoryScope =
  { kind: 'global' } | { kind: 'project'; root: string } | { kind: 'work'; workId: string };
export interface AgentProfile {
  id: string;
  revision: number;
  name: string;
  instructions: string;
  companionSourceId: string | null;
  memorySourceIds: string[];
  createdAt: string;
  updatedAt: string;
}
export interface MemorySource {
  id: string;
  revision: number;
  label: string;
  owner: 'hermes' | 'openclaw' | 'obsidian' | 'markdown';
  path: string;
  section: string[];
  scope: MemoryScope;
  sha256: string;
  selectionSha256: string;
  observedAt: string;
}
export interface MemoryInspection {
  path: string;
  sha256: string;
  bytes: number;
  characters: number;
  sections: { path: string[]; characters: number }[];
  selectionSha256: string;
  content: string | null;
  tooLarge: boolean;
}
export interface ContextReceipt {
  profileId: string;
  profileRevision: number;
  profileName: string;
  companionSourceId: string | null;
  sources: Pick<
    MemorySource,
    | 'id'
    | 'revision'
    | 'label'
    | 'owner'
    | 'path'
    | 'section'
    | 'scope'
    | 'sha256'
    | 'selectionSha256'
  >[];
  contentDigest: string;
  reviewDigest: string;
  preparedAt: string;
}
export interface ContextReview {
  receipt: ContextReceipt;
  instructions: string;
  memories: { sourceId: string; label: string; content: string }[];
  skipped: { sourceId: string; label: string; reason: string }[];
  requiresReview: boolean;
}
export type ApprovalActor = { kind: 'local' } | { kind: 'tailscale'; identity: string };
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
  decidedBy?: ApprovalActor;
}
export interface Usage {
  /** Native counter lifetime, independent of the retained display description. */
  counterScope?: 'run' | 'session';
  key: string;
  workId: string | null;
  accountId: string | null;
  harness: Harness;
  source:
    | 'codex/app-server'
    | 'claude/agent-sdk'
    | 'opencode/v2'
    | 'hermes/acp'
    | 'openclaw/gateway'
    | 't3/native'
    | 'ccusage'
    | 'example';
  scope: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  estimatedUsd: number | null;
  observedAt: string;
}
export interface Settings {
  quietMode: boolean;
  maxConcurrent: number;
  memoryPressurePolicy?: 'protect' | 'observe';
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
  providerInstanceId?: string;
  status: string;
  project: string;
  source:
    | 'agent-deck'
    | 'codex/app-server'
    | 'claude/agent-sdk'
    | 'hermes/api'
    | 'openclaw/gateway'
    | 't3-code/mcp';
  sourceId?: string;
  updatedAt?: string | null;
  cwd?: string;
  observedAt?: string;
  control?: 'observed';
}
export type NativeSourceKind =
  'codex' | 'claude' | 'codex-schedules' | 'hermes-schedules' | 'hermes' | 'openclaw' | 't3-code';
export interface NativeSource {
  scheduler?: import('./scheduler.js').SchedulerObservation;
  schedulerCheck?: { observedAt: string; available: boolean };
  id: string;
  kind: NativeSourceKind;
  label: string;
  home: string;
  endpoint: string;
  tokenEnv?: string;
  authentication?: 'oauth';
  state: 'configured' | 'connected' | 'error';
  checkedAt: string | null;
  error: string | null;
  capabilities: string[];
  observation?: { sessions: number; schedules: number; moreAvailable: boolean; projects?: number };
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
  projects?: number;
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
export interface MemoryPressure {
  state: 'normal' | 'warning' | 'critical' | 'unknown';
  source: 'macos-sysctl' | 'unavailable';
  nativeValue: number | null;
  checkedAt: string;
}
export interface MachineSnapshot {
  memoryPressure?: MemoryPressure;
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
  busiestProcesses?: MachineSnapshot['processes'];
}
export interface BackgroundRuntime {
  mode: 'foreground' | 'launchd';
  installationId?: string;
  label?: string;
  scope?: 'user-login';
  definitionDirectory?: string;
}
export interface Snapshot {
  resources?: import('./resources.js').ResourceObservation;
  memoryPacks?: import('./memory-packs.js').MemoryPackReceipt[];
  availability?: import('./availability.js').AvailabilitySnapshot;
  connectors?: import('./connectors.js').NativeConnector[];
  notifications?: import('./notifications.js').NotificationSnapshot;
  nativeControls?: import('./native-controls.js').NativeControlSnapshot;
  spending?: import('./spending.js').SpendingSnapshot;
  outcomes?: import('./spending.js').WorkOutcome[];
  companionGrants?: CompanionGrant[];
  backends?: WorkspaceBackend[];
  service?: BackgroundRuntime;
  nativeWorkers?: NativeWorkerResources[];
  access?: ApprovalActor;
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
  profiles: AgentProfile[];
  defaultProfileId: string;
  memorySources: MemorySource[];
  hermes: RuntimeProbe;
  now: string;
}
