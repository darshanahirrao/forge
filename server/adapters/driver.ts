import type { Account, Harness, Run, Usage, Work } from '../../shared/types.js';

/** Native tools, permissions and conversation state stay inside the selected harness. */
export interface DriverContext {
  work: Work;
  account: Account;
  run: Run;
  prompt: string;
  allowMetered: boolean;
  /** Optional attempt reservation delegated to a supported native spending control. */
  maxBudgetUsd?: number;
}
export interface NativeApproval {
  requestId: string | number;
  method: string;
  sessionId: string;
  turnId: string;
  params: unknown;
  title: string;
  detail: string;
  command: string;
  cwd: string;
  signal?: AbortSignal;
  expiresAt?: string;
  respond(decision: 'accept' | 'decline'): void | Promise<void>;
}
export interface DriverSink {
  delegated?(receipt: NonNullable<Run['settlement']>): void;
  /** Register the actual supervised native process before model input. PIDs are provenance, not control authority. */
  worker?(pid: number): Promise<void>;
  session(id: string, routingKey?: string): void;
  turn(id: string): void;
  account(account: Account): void;
  activity(kind: string, title: string, detail?: string): void;
  usage(usage: Usage): void;
  approval(request: NativeApproval): void;
  withdrawn(requestId: string | number): void;
  ended(status: 'completed' | 'failed' | 'interrupted', title: string, detail: string): void;
}
export interface NativeDriver {
  readonly ownership?: 'delegated-run';
  readonly settlement?: Run['settlement'];
  readonly harness: Harness;
  readonly closed: boolean;
  start(context: DriverContext, sink: DriverSink): Promise<void>;
  interrupt(): Promise<void>;
  /** Resolves only after owned-process exit or an independently confirmed delegated run settlement. */
  close(): Promise<void>;
}
export type DriverFactory = (context: DriverContext) => NativeDriver;
