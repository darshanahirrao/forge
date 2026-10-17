import type { ApprovalActor, NativeWorkerIdentity } from './types.js';
import type { WorkerExitPayload } from './recovery.js';
import type { NativeResourceReceipt } from './resource-governance.js';

export interface CompanionRuntime {
  id: string;
  label: string;
  accountId: string;
  profileId: string;
  grantId: string;
  harness: string;
  root: string;
  revision: number;
  currentLaunchId?: string;
  createdAt: string;
  retiredAt?: string;
}
export interface CompanionRuntimeScope {
  kind: 'companion-runtime';
  launchId: string;
  runtimeId: string;
  accountId: string;
  profileId: string;
  generation: number;
  harness: string;
  resourcePolicyDigest?: string;
}
export interface CompanionRuntimeLaunch {
  nativeResources?: NativeResourceReceipt;
  id: string;
  runtimeId: string;
  accountId: string;
  profileId: string;
  grantId: string;
  harness: string;
  generation: number;
  revision: number;
  state: 'starting' | 'running' | 'stopping' | 'closed' | 'failed' | 'unknown';
  exitConfirmed: boolean;
  binding: string;
  createdAt: string;
  actor: ApprovalActor;
  updatedAt?: string;
  detail: string;
  supervisionId?: string;
  nativeWorker?: NativeWorkerIdentity;
  nativeVersion?: string;
  nativePid?: number;
  stopRequestedAt?: string;
  stoppedBy?: ApprovalActor;
  endedAt?: string;
  exit?: {
    digest: string;
    method: 'signed-native-close' | 'not-committed';
    native?: WorkerExitPayload;
    actor?: ApprovalActor;
  };
}
export interface CompanionRuntimeReview {
  nativeResources?: NativeResourceReceipt;
  id: string;
  digest: string;
  expiresAt: string;
  runtime: CompanionRuntime;
  account: { id: string; label: string; harness: string; billingMode: string };
  nativeHome: string;
  nativeFiles: { path: string; sha256: string | null }[];
  binding: string;
}
export interface CompanionRuntimeSnapshot {
  supported: boolean;
  providers: string[];
  runtimes: CompanionRuntime[];
  launches: CompanionRuntimeLaunch[];
  recovery: {
    launchId: string;
    runtimeId: string;
    revision: number;
    state: 'ready' | 'waiting' | 'unavailable';
    detail: string;
    digest?: string;
  }[];
}
