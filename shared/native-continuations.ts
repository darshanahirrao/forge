import type { Account } from './types.js';

export interface NativeChatHistory {
  threadId: string;
  cwd: string;
  modelProvider: string;
  lastTurnId: string;
  turns: number;
  items: number;
  digest: string;
  nativeVersion: string;
}
export interface NativeChatOrigin extends NativeChatHistory {
  reviewId: string;
  reviewDigest?: string;
  sourceId: string;
  accountId: string;
  accountBinding: string;
  reviewedAt: string;
  state: 'pending' | 'bound' | 'context-only';
  boundSessionId?: string;
}
export interface NativeContinuationReview {
  id: string;
  digest: string;
  expiresAt: string;
  source: NativeChatHistory;
  account: Pick<Account, 'id' | 'label' | 'identity' | 'plan' | 'billingMode'>;
  profileId: string;
  profileName: string;
  title: string;
  goal: string;
  workId?: string;
}
