export type NotificationKind = 'approval' | 'completed' | 'failed' | 'interrupted';
export interface NotificationConfig {
  id: string;
  revision: number;
  enabled: boolean;
  serverOrigin: string;
  kinds: NotificationKind[];
  enabledAt: string;
}
export interface NotificationReceipt {
  id: string;
  configId: string;
  kind: NotificationKind | 'test';
  referenceId: string;
  workId: string | null;
  state: 'queued' | 'sending' | 'accepted' | 'uncertain' | 'failed' | 'withdrawn';
  createdAt: string;
  updatedAt: string;
  detail: string;
  acknowledgedAt?: string;
}
export interface NotificationSnapshot {
  config: NotificationConfig | null;
  receipts: NotificationReceipt[];
  needsReview: number;
  reviewOrigin: string;
}
