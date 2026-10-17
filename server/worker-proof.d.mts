import type { KeyObject } from 'node:crypto';
import type { WorkerScope, WorkerProofDescriptor, WorkerExitPayload } from '../shared/recovery.js';
export function scopeHash(scope: WorkerScope): string;
export function privateDirectory(directory: string): void;
export function readWorkerExit(descriptor: WorkerProofDescriptor): {
  payload: WorkerExitPayload;
  digest: string;
};
export function writeWorkerExit(
  descriptor: WorkerProofDescriptor,
  payload: WorkerExitPayload,
  key: KeyObject,
): { payload: WorkerExitPayload; digest: string };
export function checkWorkerProfile(root: string): void;
export function armWorkerProfile(
  root: string | undefined,
  descriptor: WorkerProofDescriptor,
): () => void;
