import type { ApprovalActor } from './types.js';
import type { ScheduleReview } from './native-controls.js';

/** A deliberately small intersection, not a replacement scheduler or model/tool policy. */
export interface PortableSchedule {
  title: string;
  prompt: string;
  schedule:
    | { kind: 'at'; at: string }
    | { kind: 'every'; minutes: number }
    | { kind: 'cron'; expr: string; tz: string };
}
export type ScheduleEvidence = Omit<ScheduleReview, 'action' | 'expiresAt'>;
export interface ScheduleTransferPlan {
  id: string;
  digest: string;
  expiresAt: string;
  sourceId: string;
  targetSourceId: string;
  source: ScheduleEvidence;
  portable: PortableSchedule;
  targetDefinition: string;
  changes: string[];
}
export interface ScheduleTransfer {
  id: string;
  revision: number;
  digest: string;
  sourceId: string;
  targetSourceId: string;
  sourceJobId: string;
  targetJobId?: string;
  title: string;
  state:
    'preparing' | 'staged' | 'activating' | 'active' | 'cancelling' | 'cancelled' | 'uncertain';
  createdAt: string;
  updatedAt: string;
  actor: ApprovalActor;
  reviewedBy?: ApprovalActor;
  detail: string;
}
export interface ScheduleTransferReview extends ScheduleTransfer {
  portable: PortableSchedule;
  changes: string[];
  source: ScheduleEvidence;
  target: ScheduleEvidence | null;
  originalDefinition: string;
  targetDefinition: string;
  canActivate: boolean;
  canCancel: boolean;
}
