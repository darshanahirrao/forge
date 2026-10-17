# Native execution backends

Forge v0.15 adds an optional T3 Code execution backend. T3 owns its native provider processes, sign-in, models, conversations and tools. Forge owns the work, selected profile/memory, one managed admission slot, exact human decisions and durable run references. Direct Forge adapters remain available. Each account selects one execution owner.

This is an experimental protocol-2 integration, tested against official T3 v0.1.0, source [81493ef](https://github.com/pingdotgg/t3code/tree/81493efb71e8e8244f95d3e9f71d8369654ab151). It uses the native [RPC contracts](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/packages/contracts/src/orchestrationV2.ts), ticketed application connection and journaled commands. It does not parse T3 databases, launch a second provider worker, or implement another terminal, browser or scheduler.

## Connect and use

1. Install T3 through its native instructions. Add the intended project in T3. For CLI setup, run `t3 project add /absolute/project/path` before starting `t3 serve --host 127.0.0.1 --port 3773 --no-browser`. Use the same native base directory for both commands.
2. In T3, configure the desired provider instances and native sign-in. Forge imports installed enabled instances; it does not copy their credentials. Native driver identifiers are open, including registered ACP drivers. This catalogue support is not conformance evidence for every driver.
3. Create a native pairing code: `t3 auth pairing create --scope orchestration:read --scope orchestration:operate`.
4. In Forge, open Connections, Execution backends, Connect T3. Enter its loopback address, a name and that code. The input clears after submission. Pick an advertised model for each imported instance. Re-pairing the same environment preserves its backend/account IDs and previous work.
5. Create work with one of those accounts and the exact native project directory. Review the selected profile/memory and native billing consent before launch. Native approval-required mode remains active. Supported exact requests arrive in the existing approval inbox.

The native project is selected by directory. Ambiguous projects require a specific `projectId` in the account's `/api/accounts/:id/backend` binding. Native worktrees or a changed native permission mode are rejected before another message. Remote execution environments are not supported by this connection.

The separate [T3 activity source](T3_CODE.md) still accepts exactly `orchestration:read` through MCP OAuth. Its token cannot become an execution connection. The new human application grant has exactly read/operate scopes and is not a companion/agent grant. Forge exposes no generic native RPC proxy or approval capability to an agent.

## Ownership and recovery

Each attempt persists its native backend, thread, stable message command identity and eventual native run ID before dispatch. Writes are not automatically reconnected or replayed. Native streaming events trigger serialized canonical projection reads. Forge accepts completion only for the exact native run after the thread has no other active/queued runs or reported background tasks.

A delegated receipt confirms run settlement, not physical process exit. T3 may retain its server and idle provider pool. Forge never signals their PIDs. Its existing OS-pressure admission still applies; T3's foreign work and resource policies retain their native owner.

After a lost connection, the work and global managed admission remain reserved. Open the work's recovery controls to check the exact native outcome or stop and reconcile that run. A fresh connection verifies native environment/thread/message/run/provider identity. A native cancellation acknowledgement alone is insufficient. Reconciliation neither sends another message nor grants a waiting approval. Re-pair an expired human grant in Connections if needed. An unconfirmed foreign continuation or missing identity keeps the lease held.

## Context and accounts

Same-backend handoff retains the T3 application thread. T3 chooses native resume or a native context transfer. Forge records the resulting native conversation reference and coverage in the run receipt and activity. Cross-backend handoff uses the existing reviewed Work Capsule. Correcting or removing selected memory still starts a fresh native conversation so older cached facts are not silently reintroduced.

**Native history preservation remains an open acceptance case.** With T3 v0.1.0 and actual Codex 0.159.3, switching two compatible instances sharing a Codex home produces an `already has an active writer` native resume rejection. T3 then continues with its `full_thread_summary` fallback. T3's pinned Codex 0.156.1 also produced a fallback in the isolated check. The work ID, directory, selected memory, source lineage, prior assistant excerpt, exact approvals and artifact chain persist. This does not establish full native or hidden-state preservation. Forge reports `portable-handoff`; it does not label that result native resume. No native writer lock is bypassed.

Native reported workspace/fingerprint/profile identity keeps shared quota scopes together. Unknown identity does not create independent allowance. T3's per-turn main-agent usage uses stable native keys, separate from context-window pressure. Dollar amounts remain unknown when no priced evidence is imported. This does not implement automatic quota routing or prove live subscription eligibility.

## Credentials and state

Human control tokens live in private atomic `.forge-t3-control-<backend-id>.json` files beside SQLite, excluded from snapshots, blueprint exports and Git. Unix reads check owner, mode, regular-file type, symlink rejection and size. Provider credentials remain with T3. Disconnect removes Forge's local grant reference and preserves historical accounts/work; upstream revocation remains a native T3 action. Keep these private files with a private state backup if you need to preserve connections.

State version 4 prevents an older Forge process from interpreting a backend account as a direct adapter. Existing v1-v3 workspaces receive a private `workspace.sqlite.before-v4.UUID.sqlite` rollback copy before upgrade. Stop Forge before restoring a copy. A source push is not a deployment.

## Validation

Unit coverage includes bounded ticket/RPC framing, stream cancellation, uncertain writes without replay, dynamic provider import, shared quota scopes, secret exclusion, private credentials, stable re-pairing, changed native environment rejection and held recovery leases.

Run `FORGE_T3_BINARY=/absolute/native/t3 npm run test:native:t3-execution` for isolated production-API pairing and two-instance native Codex execution against a synthetic loopback inference provider. It requires existing native executables; it never installs them or reads your provider credentials. Two exact approvals precede two artifact writes, distinct synthetic credentials reach the selected provider, the same Forge work persists, context coverage is checked, and native root/observed descendant teardown is verified. No paid model calls are made.

`FORGE_T3_CODEX_BINARY` optionally selects another isolated Codex binary. `FORGE_T3_REQUIRE_NATIVE_RESUME=1` enables the stricter history-preservation gate. That strict gate currently fails with the versions above and must not be counted as passing. Whole-stack performance, native crash recovery, companion orchestration and automatic account routing remain in the full completion audit.
