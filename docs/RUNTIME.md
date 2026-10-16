# Forge v0.1.0

Implementation checkpoint, 17 October 2026. This is the first local application. The full Persistent Agency architecture remains a delivery plan rather than a claim of completed interoperability.

## Start and develop

Node.js 24 or newer is required. Run `npm ci`, `npm run build`, and `npm start`, then open `http://127.0.0.1:4710`. The built application uses one Node service. It requires no model key, cloud database, or permanently running companion runtime to open the workspace.

For development, `npm run dev` starts a watched TypeScript service on port 4710 and Vite on port 5173. Stop an existing production service before using the same API port. Run only one Forge service per state directory. Native SQLite exclusive ownership prevents a second service from modifying or recovering an active workspace.

`node bin/forge.mjs --help` describes the local CLI. `--port` and `--data-dir` override the default port and private-state directory. The equivalent environment variables are `FORGE_PORT` and `FORGE_DATA_DIR`.

## Boundaries that are implemented

| Area | Current behavior | Evidence and limit |
| --- | --- | --- |
| Work | SQLite work records, goal/context, acceptance criteria, user checkpoints, chronological receipts, revision checks, context export | Restart and transactional rollback tests. Exports contain selected user-authored context; they are not a complete native transcript or artifact checkpoint. |
| Accounts | Named account slots; optional native configuration directory; Codex and Claude native authentication checks | Native sign-in and credential precedence remain authoritative. A status check observes native configuration; it does not prove a future model request or every isolation mode works. Other harness slots are metadata references. |
| Allowance | Codex native quota windows, source timestamps, observed identity keys, duplicate-slot indication, backend included-usage state | Shared scopes are retained. Unknown allowance stays unknown. Percentages do not establish access or restore denied usage. |
| Managed execution | Experimental native Codex app-server start/resume through a per-task stdio connection | One managed attempt at a time. The same bound native account/session can continue. This does not control foreign desktop sessions, detached native tools, or every process on the machine. |
| Approvals | Correlated command requests and reviewable file changes, digest/generation checks, allow once/decline, expiry, native withdrawal, invalidation after connection loss | Unsupported requests receive no grant. Persistent rule amendments, expanded file roots, and unreviewable request types are not silently accepted. |
| Usage | Cumulative native Codex thread snapshots and optional ccusage Claude daily estimates | Repeated snapshots replace their scope rather than adding again. Native Codex dollar cost is unknown here. ccusage reports are estimates and remain unattributed to individual accounts or tasks when upstream data is aggregate. |
| Resources | Live OS CPU/memory, process names/RSS/CPU, Forge service RSS; quiet-mode admission | Process arguments and environment variables are omitted. RSS includes shared pages; OS used memory includes reclaimable cache. This is observation, not a memory-pressure or hard-limit implementation. |
| Hermes | Explicit local API connection; read-only `/health` and `/v1/capabilities` | Installed source informed the discovery contract, which is tested with a synthetic HTTP server. Native execution, memory, approval responses, and scheduling remain future integration work. |
| Existing foundations | Optional `agent-deck list --json` and `ccusage daily --json` | Installed CLIs are reused without vendoring session management or transcript parsers. Neither CLI was installed or connected to private data during this checkpoint. |
| Customization | Account/runtime references, themes, explicit native choices, safe setup-blueprint export | Blueprint activation/import and a third-party extension loader are not implemented. The MIT source remains editable. |

## Native execution flow

Create a work record with a goal, native Codex account slot, and absolute project directory. The launch dialog explains project access and asks whether metered API/external-provider use or additional credits are allowed. That choice does not purchase credits or replace provider policy.

Forge checks the effective account through the same connection that will run the task. It requests the native `untrusted` approval policy, user review, and a workspace-write sandbox. If the server does not confirm the policy and sandbox, no turn is requested. Goals, context, acceptance criteria, and user checkpoints become the native input. Continued turns use the existing session reference.

Native requests are associated with their exact RPC request ID, thread, turn, work generation, and a digest. Allow once sends only the one-time native decision. Decisions are recorded before delivery; a transport failure makes the outcome uncertain and does not cause replay. Native withdrawal and completion invalidate outstanding requests. Approval timeouts decline still-pending requests after ten minutes.

A process shutdown or lost connection marks unfinished work interrupted. Starting again requires an explicit review of native activity, detached tools, and external effects. Closing a connection is not proof that every external action stopped. Automatic handoff and fencing across arbitrary harnesses remain unproven and are disabled.

## Private state and local access

Defaults are `~/Library/Application Support/Forge` on macOS, the user data directory on Linux, and LocalAppData on Windows. The directory is created privately where supported and the SQLite file uses mode 0600. Work context, aliases, native identity metadata, quota observations, usage, and receipts belong to this private database. Native credentials are not imported. The database is not encrypted by Forge.

The service binds only to `127.0.0.1`. Host/origin checks, a per-start CSRF token, JSON mutations, and a restrictive content-security policy protect browser access. This is a trusted local-machine application, not a remotely authenticated multi-user server. LAN hosting and phone access require a separate authenticated transport and are not enabled.

The demo uses a different in-memory database. Its accounts, work, costs, and approvals are fictional. All native execution, identity probes, usage reads, and runtime connections are blocked in demo mode. OS telemetry remains live and is labeled accordingly.

Stop Forge before making a filesystem backup of the state directory. Preserve the database and any remaining SQLite sidecar files together. The repository and setup-blueprint export exclude private runtime state. A blueprint contains generic account roles and required harness choices, without identities, paths, credentials, or work content.

## Resource behavior

Only the selected managed attempt starts a harness process. Registering an account does not start a worker. CLI discovery checks executable presence without starting every tool. The visible UI polls every five seconds, skips background-tab polling, and reuses a coalesced OS sample. There is no perpetual sampling timer when the UI is closed.

Work summaries are persisted separately from full context and committed atomically with it. The overview reads summaries and bounded event metadata. A task's context and recent detailed receipts load on demand; native reasoning is not captured. Raw native assistant messages have an explicit excerpt limit and retain their native-session reference.

The earlier 75 MB / 1% core target is a design target, not a passed performance result. A preliminary local sample observed about 80 MB service RSS before final packaging. Full-stack idle CPU, native-worker overhead, memory pressure, and improvement over existing tools have not been benchmarked. Report those separately before claiming a resource advantage.

## Verification

The repository includes type checks, functional/API tests, Playwright user flows, and axe accessibility checks. Synthetic native protocol fixtures never run shell commands, call a model, or write project files. They cover request correlation, one-time decisions, stale generations, expiry, withdrawal, policy mismatch, cancellation/recovery, billing admission, usage deduplication, demo isolation, revision conflicts, atomic persistence, and lightweight projections. A synthetic Hermes server checks discovery against read-only endpoints.

The installed Codex CLI also passed a real initialization handshake. No account lookup, paid model turn, real command approval, account migration, or private native usage import was requested for that smoke check. Real upstream execution and two-account continuity still need controlled conformance work before this adapter is considered production-ready.

## Next delivery gates

1. Validate the experimental Codex adapter against a controlled real task and record exact supported native versions.
2. Extend the existing-foundation evaluation before adding Claude, Hermes, OpenClaw, or OpenCode managed execution. Preserve native tools, memory, and schedule owners.
3. Add supported authenticated approval delivery, native scheduling inventory, and resource-ownership evidence.
4. Prove two-account continuation and then cross-harness continuation around an artifact-producing task, with external-effect reconciliation and complete context-coverage evidence.
