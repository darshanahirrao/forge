export interface AccountRoute {
  version: 1;
  workId: string;
  revision: number;
  cwd: string;
  profileId: string | null;
  accountIds: string[];
  allowMetered: boolean;
  allowUnreportedQuota: boolean;
  maxEvidenceAgeSeconds: number;
  updatedAt: string;
}
export interface RouteCandidate {
  accountId: string;
  label: string;
  harness: string;
  eligible: boolean;
  reasons: string[];
  quotaCoverage: 'fresh' | 'unreported' | 'stale';
  sharedIdentity: boolean;
}
export interface RouteReview {
  policy: AccountRoute | null;
  workRevision: number;
  recommendedAccountId: string | null;
  candidates: RouteCandidate[];
  planId: string | null;
  digest: string | null;
  expiresAt: string | null;
}
