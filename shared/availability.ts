export type ActivationState =
  | 'submitted'
  | 'committed'
  | 'waiting'
  | 'installing'
  | 'starting'
  | 'running'
  | 'aborted'
  | 'failed'
  | 'uncertain';

export interface ActivationReceipt {
  id: string;
  digest: string;
  installationId: string;
  state: ActivationState;
  requestedAt: string;
  updatedAt: string;
  detail: string;
  review?: { at: string; note: string; native: 'not-loaded' };
}
export interface AvailabilitySnapshot {
  supported: boolean;
  runtime: 'foreground' | 'launchd';
  startsAtLogin: boolean;
  transitioning: boolean;
  detail: string;
  receipt: ActivationReceipt | null;
}
export interface AvailabilityReview {
  id: string;
  digest: string;
  expiresAt: string;
  action: 'install-and-start' | 'start-installed';
  installationId: string;
  dataDirectory: string;
  definition: string;
  executable: string;
  runner: string;
  port: number;
  phonePort: number | null;
  phoneOrigin: string | null;
  phoneUsers: string[];
  environment: Record<string, string>;
  startsAtLogin: boolean;
}
