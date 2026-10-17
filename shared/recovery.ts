import type { ApprovalActor } from './types.js';

export interface WorkerScope {
  runId: string;
  workId: string;
  accountId: string;
  generation: number;
  harness: string;
}
export interface WorkerProofDescriptor {
  id: string;
  scope: WorkerScope;
  scopeHash: string;
  directory: string;
  publicKey: string;
  guardianPid: number | null;
}
export interface WorkerExitPayload {
  contract: 'forge.worker-exit/1';
  id: string;
  scopeHash: string;
  guardianPid: number;
  nativePid: number | null;
  started: boolean;
  code: number | null;
  signal: string | null;
  nativeClosed: true;
  stdioClosed: true;
  reason: 'normal' | 'requested' | 'owner-disconnected' | 'spawn-error' | 'bootstrap-aborted';
  createdAt: string;
  closedAt: string;
}
export interface NativeRecoveryReceipt {
  digest: string;
  supervisionId: string;
  method: 'signed-native-close' | 'not-committed';
  at: string;
  actor: ApprovalActor;
  native?: WorkerExitPayload;
}
export interface NativeRecoveryRow {
  runId: string;
  workId: string;
  harness: string;
  revision: number;
  state: 'ready' | 'waiting' | 'unavailable' | 'unsupported';
  detail: string;
  digest?: string;
  method?: NativeRecoveryReceipt['method'];
  native?: WorkerExitPayload;
}
export interface NativeRecoverySnapshot {
  needsReview: number;
  rows: NativeRecoveryRow[];
}
