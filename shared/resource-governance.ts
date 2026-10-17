import type { ApprovalActor } from './types.js';

export interface NativeResourcePolicy {
  revision: number;
  lowPriority: boolean;
  rootMemoryMiB: number | null;
  hostBinding: string | null;
  changedAt: string | null;
  actor?: ApprovalActor;
}
export interface NativeResourceBackend {
  kind: 'macos-taskpolicy';
  priority: 'utility-qos';
  release: string;
  binarySha256: string;
}
/** A limit on the original native process, not a sum of descendant RSS. */
export interface NativeResourceReceipt {
  contract: 'forge.native-resources/1';
  policyRevision: number;
  lowPriority: boolean;
  rootMemoryMiB: number | null;
  backend: NativeResourceBackend;
  digest: string;
}
export interface NativeResourceSnapshot {
  supported: boolean;
  detail: string;
  policy: NativeResourcePolicy;
  reviewNeeded: boolean;
}
export interface NativeResourceConfiguration {
  expectedRevision: number;
  lowPriority: boolean;
  rootMemoryMiB: number | null;
  effectsReviewed: true;
}
