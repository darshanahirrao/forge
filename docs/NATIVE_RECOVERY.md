# Native worker recovery

Version 0.27 adds durable exit evidence for managed native workers on macOS and Linux. Resources shows interrupted attempts, verified evidence and an explicit **Reconcile native exit** action. Workspace attention and launch review link to that hold. Recovery never resubmits a prompt or an approval.

## Original child ownership

An active supported attempt has one small Node child owner between Forge and its native worker. This process forwards native stdio, retains the actual child handle, relays native termination and waits for the child's `close` event, including inherited stdio closure. It has no listener, inference, tool implementation, planner or scheduler. Native SDKs and harnesses retain their existing behavior. There are no child owners when the workspace is idle. An active child owner adds resource overhead; its process and observed native descendants belong to that attempt in the resource map.

The scope includes the immutable run, work, account, generation and harness. Before starting a child owner, Forge writes a private prepared receipt and binds its ID to the canonical run. It saves the owner PID before sending private bootstrap configuration. The child owner acquires the explicit native profile fence and acknowledges readiness. Forge then durably commits the launch before sending the only message that can spawn a native process. A prepared or armed receipt recovered after the original Forge owner exits therefore proves that no native launch was committed.

Each original child owner receives a fresh Ed25519 signing key over private IPC. Only the public key and scope enter SQLite. Executable arguments, provider environment, credentials and private signing material are excluded from receipts, snapshots and exports. The child owner starts without inherited provider or Node preload variables. Native configuration travels over IPC to that original process, rather than through disk or command arguments.

After native close, it exclusively creates a mode-0600 signed receipt and syncs the file and containing directory. Verification checks private owned directories/files, no-follow reads, size and shape bounds, exact scope, original child-owner PID and signature. It does not infer closure from a missing process or a sampled PID identity. Normal teardown also requires this evidence before the coordinator releases its reservation.

## Crash and reconciliation

When the original Forge IPC disconnects, the child owner stops native input, drains native output and requests native termination. Existing adapter cleanup budgets remain in force; OpenClaw retains its longer native shutdown allowance. Escalation targets the actual owned native child handle. The replacement Forge neither signals nor adopts an old PID.

If the child owner survives to native close, Resources can verify its signed receipt. A human can reconcile that exact digest and current work revision through the local workspace or authenticated private phone gateway. Repeated use of the same receipt returns its recorded outcome. Demo and companion bearer credentials cannot reconcile native exits.

Reconciliation releases the worker reservation, records the human actor and keeps the attempt interrupted. It invalidates old approvals, does not fabricate task success and leaves unknown spending unknown. A retry still requires the existing external-effects review, spending admission and a new attempt generation. A different managed work item cannot bypass an unconfirmed native-exit hold.

If the child owner is killed, the receipt is missing/invalid, inherited stdio stays open, or legacy evidence cannot establish exit, the hold remains visible. There is no force-clear or arbitrary-PID kill endpoint. This implementation does not adopt an orphaned native session. T3 delegated runs retain their separate exact backend-run settlement contract.

## Cooperative native profile fence

For an explicitly selected native home, the child owner commits an armed row to private `.forge-worker-proof.sqlite` before retaining its lifetime SQLite lock. A killed owner releases the OS lock but leaves the durable armed row. New compatible Forge workers require signed closure for that row before reusing the profile. The older `.forge-native-owner.sqlite` lease remains in use by native adapters; the new fence supplements it across a Forge crash.

This is cooperative fencing among compatible Forge workers using the same explicit profile. It cannot control foreign native clients, older Forge binaries or implicit global profiles. Do not delete ownership files or change saved statuses to bypass a hold. Proof files must remain available while their profile fence needs them.

## Storage, rollback and limits

File-backed workspaces enable supervision by default. Owned in-memory fixtures opt in with an explicit private worker directory. Windows supervision is unsupported. New native launches remain possible through the preexisting driver contract there, but durable native-close recovery is unavailable. A custom driver must use `DriverContext.spawnNative` to obtain this evidence.

State 7 preserves supervision and recovery semantics. Opening an earlier state creates a private native SQLite `before-v7` backup. Older state-6 readers reject state 7 rather than ignoring the new ownership contract. Restore an earlier application's complete earlier state checkpoint; a rollback is not permission to reuse a native profile whose exit remains uncertain. Native profiles and private proof directories are not portable setup-blueprint contents.

Native root and stdio closure do not prove detached tools, remote jobs, billing, external effects or task acceptance are settled. The local OS user and original Forge process remain trusted; signatures are not protection against a hostile same-user process changing the workspace's public keys or files. Busy resource limits, foreign-session adoption, Windows supervision and broader external-effect recovery remain in the [completion audit](COMPLETION_AUDIT.md).

## Verification

`npm test` includes owned child-host SIGKILL, killed-child-owner/profile-fence retention, exact human/phone reconciliation, stale revision/digest rejection, idempotency, approval invalidation, no replay, unknown spending, forced native stop, failed native exec, inherited stdio closure and private/scope/signature/symlink checks. Browser coverage checks recovery attention/navigation, stale evidence, retained uncertainty, both themes, mobile inner overflow and accessibility.

Build first, then run `npm run test:native:recovery`. It starts the compiled Forge app with an isolated actual Codex profile and deterministic loopback inference. One approved native tool writes an artifact; Forge is killed at a second pending native command. Restart verifies original-owner closure, invalidates the stale decision and reconciles without another provider request or the unapproved artifact. It uses no personal credential or paid model call and retains a failed fixture for inspection.

`npm run test:native:handoff` separately verifies signed native-close receipts across all six runs through actual Codex, two Claude API profiles, OpenCode, Hermes and OpenClaw, together with the existing artifacts, exact approvals, selected context and resource partitions. These checks do not establish live provider/device acceptance or full framework completion.
