import type { ApprovalActor, CompanionGrant } from './types.js';

export interface CompanionBoundary {
  profile: { id: string; revision: number; name: string };
  root: string;
  workCount: number;
  workDigest: string;
  work: { id: string; title: string; revision: number }[];
  memory: { id: string; label: string; binding: string; sha256: string; selectionSha256: string }[];
  accountBindings: Record<string, string>;
}
export interface CompanionHandoffPlan {
  id: string;
  digest: string;
  expiresAt: string;
  from: CompanionGrant;
  label: string;
  boundary: CompanionBoundary;
}
export interface CompanionHandoff {
  id: string;
  digest: string;
  revision: number;
  state: 'staged' | 'ready' | 'activated' | 'aborted';
  fromGrantId: string;
  toGrantId: string;
  label: string;
  boundary: CompanionBoundary;
  createdAt: string;
  updatedAt: string;
  actor: ApprovalActor;
  reviewedBy?: ApprovalActor;
  readyAt?: string;
  activatedAt?: string;
}
