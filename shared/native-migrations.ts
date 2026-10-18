import type { ApprovalActor } from './types.js';

export type NativeMigrationHarness = 'hermes' | 'openclaw';
export interface NativeMigrationItem {
  kind: string;
  status: string;
  source: string | null;
  target: string | null;
  note: string;
  overflowedEntries: number;
}
export interface NativeMigration {
  id: string;
  revision: number;
  state: 'preparing' | 'ready' | 'activated' | 'failed' | 'dismissed';
  sourceAccountId: string;
  sourceHarness: NativeMigrationHarness;
  targetHarness: NativeMigrationHarness;
  label: string;
  nativeHome: string;
  createdAt: string;
  updatedAt: string;
  actor: ApprovalActor;
  detail: string;
  nativeVersion?: string;
  digest?: string;
  sourceDigest?: string;
  files?: number;
  bytes?: number;
  summary?: { imported: number; archived: number; skipped: number; overflowed: number };
  accountId?: string;
  acceptedBy?: ApprovalActor;
  credentialsAvailable: boolean;
  reusedCredentialReference?: boolean;
  reviewedProjectRoot?: string;
}
export interface NativeMigrationReview extends NativeMigration {
  items: NativeMigrationItem[];
  reportPath: string;
}
