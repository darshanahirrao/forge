import type { ApprovalActor } from './types.js';
export type ScheduleAction = 'pause' | 'resume';
export type NativeScheduleContract = 'hermes-builtin-native-flock/1' | 'openclaw-native-revision/1';
export interface ScheduleReview {
  id: string;
  sourceId: string;
  jobId: string;
  action: ScheduleAction;
  expiresAt: string;
  title: string;
  prompt: string;
  script: string | null;
  rule: string;
  definition: string;
  state: string;
  enabled: boolean;
  noAgent: boolean;
  nextRunAt: string | null;
  jobsDigest: string;
  configDigest: string | null;
  contract: NativeScheduleContract;
}
export interface NativeControlReceipt {
  id: string;
  sourceId: string;
  jobId: string;
  action: ScheduleAction;
  title: string;
  state: 'submitted' | 'applied' | 'rejected' | 'uncertain';
  actor: ApprovalActor;
  createdAt: string;
  updatedAt: string;
  detail: string;
  observed?: {
    state: string;
    enabled: boolean | null;
    nextRunAt: string | null;
    jobsDigest: string;
  };
  review?: {
    actor: ApprovalActor;
    note: string;
    observedAt: string;
    observed: NonNullable<NativeControlReceipt['observed']>;
  };
}
export interface NativeControlSnapshot {
  receipts: NativeControlReceipt[];
  needsReview: number;
}
