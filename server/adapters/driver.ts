import type { Account, Harness, Run, Usage, Work } from '../../shared/types.js';

/** Native tools, permissions and conversation state stay inside the selected harness. */
export interface DriverContext {
  work: Work;
  account: Account;
  run: Run;
  prompt: string;
  allowMetered: boolean;
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
  session(id: string): void;
  turn(id: string): void;
  account(account: Account): void;
  activity(kind: string, title: string, detail?: string): void;
  usage(usage: Usage): void;
  approval(request: NativeApproval): void;
  withdrawn(requestId: string | number): void;
  ended(status: 'completed' | 'failed' | 'interrupted', title: string, detail: string): void;
}
export interface NativeDriver {
  readonly harness: Harness;
  readonly closed: boolean;
  start(context: DriverContext, sink: DriverSink): Promise<void>;
  interrupt(): Promise<void>;
  /** Resolves after the owned native worker has exited. A closed transport alone is insufficient. */
  close(): Promise<void>;
}
export type DriverFactory = (context: DriverContext) => NativeDriver;
