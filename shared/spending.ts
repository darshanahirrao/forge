import type { ApprovalActor } from './types.js';

export interface SpendingPolicy {
  version: 1;
  revision: number;
  monthlyUsd: number | null;
  workUsd: number | null;
  attemptUsd: number | null;
  updatedAt: string;
}
export interface SpendAttempt {
  runId: string;
  workId: string;
  accountId: string;
  revision: number;
  period: string;
  startedAt: string;
  endedAt: string | null;
  state: 'reserved' | 'reported' | 'unknown' | 'reviewed';
  reservedUsd: number | null;
  estimatedUsd: number | null;
  accountedUsd: number;
  totalTokens: number;
  issues: string[];
  review?: { usd: number; note: string; at: string; actor: ApprovalActor };
}
export interface WorkOutcome {
  workId: string;
  workRevision: number;
  generation: number;
  decision: 'accepted' | 'needs-work';
  note: string;
  at: string;
  actor: ApprovalActor;
}
export interface SpendingSnapshot {
  policy: SpendingPolicy;
  period: string;
  accountedUsd: number;
  reservedUsd: number;
  unknownAttempts: number;
  reportedTokens: number;
  acceptedOutcomes: number;
  attempts: SpendAttempt[];
}
export interface SpendReview {
  allowed: boolean;
  reason: string | null;
  reserveUsd: number | null;
  policyRevision: number;
  period: string;
  monthAccountedUsd: number;
  workAccountedUsd: number;
}
