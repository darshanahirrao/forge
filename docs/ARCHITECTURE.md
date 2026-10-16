# Forge architecture

Proposal dated 16 October 2026. Components and contracts below are design decisions to validate, not implemented functionality.

## A permanent workspace with replaceable execution

Forge owns a stable `agent_id` and versioned profile: authored identity and instructions, memory references, project memberships, goals, schedule references, shared tool and skill bindings, and policy. A harness binding identifies an execution engine, reasoner, host, native session, and generation. Changing that binding must not reset the durable profile or workspace.

Native account selection is another independent binding. Multiple accounts for one harness can serve the same work through verified continuation, while identity, data scope, quota evidence, and spend attribution remain explicit. Reuse existing account management and native sign-in; see [ACCOUNTS.md](ACCOUNTS.md).

The workspace shell aggregates work, native activity, approval requests, schedule references, memory references, resource ownership, and usage. Attach, embed, or open an existing runtime surface when supported. Browser/computer use, code editing, terminals, Git/file tools, and other execution capabilities remain native. Forge does not build replacement implementations. See [NATIVE_BOUNDARY.md](NATIVE_BOUNDARY.md).

Adapters expose versioned references to existing tools and skills, including MCP where appropriate. Keep project instructions under their existing ownership; adapters reference compatible native mechanisms without overwriting user files or creating another skills runtime. Credentials remain in the host credential store. Native tools retain explicit portability limits.

Use native worktree facilities and respect native writer ownership for concurrent file-producing tasks. A handoff references workspace changes and revalidates file versions. Terminals and browser sessions remain owned by their native runtime or existing provider. Forge records ownership and uses supported lifecycle controls; it does not create its own terminal or browser execution service. A switch preview names incompatible tools, required authentication, and unsettled actions before activation.

The promise is stable user-owned state and a consistent workspace. It does not assert identical reasoning, behavior, output quality, or native feature sets across different harnesses and models.

## Portable work within the workspace

A **Work Capsule** identifies a goal, its acceptance criteria, current verified artifacts, relevant memory references, decisions, checkpoints, and outstanding actions. A capsule can span many native sessions and execution attempts. Its lifetime is independent of a process, chat, model, or harness.

The important identifiers are `work_id`, `attempt_id`, `native_session_id`, `execution_generation`, `action_id`, and `provider_request_id` where available. Every event, resource lease, approval, and charge links back to the work. Parallel subtasks receive their own authority scope; two attempts must never independently own the same exclusive action scope.

A capsule carries artifact manifests, an optional encrypted workspace patch, pending uncertainties, and versioned capability requirements. It excludes credentials, active authority tokens, hidden reasoning, browser cookies, and automatically executable instructions from retrieved material. Sharing or moving it requires explicit selection of private payloads.

## System boundary

The initial Rust-daemon/SQLite sketch is provisional. Evaluate the existing foundations in [REUSE_AUDIT.md](REUSE_AUDIT.md) before choosing a stack or implementing a new core. Architecture roles describe required responsibilities, which may be supplied by an existing project. If a remaining coordination service is justified, keep it small and local. Durable permission receipts, work events, and dispatch intent need transactional persistence; projections can be rebuilt from records and snapshots. High-frequency machine samples need a bounded, downsampled store rather than an unlimited event stream.

Component adapters can run as on-demand sidecars. Runtimes such as Hermes and OpenClaw remain separately installed services, started or connected only when selected. The initial topology needs neither a distributed database nor a permanently running stack of supporting services. An optional remote worker is a later execution target, not a requirement for a laptop installation.

Runtime state and private configuration live outside the source repository. Credentials stay in the native harness or host credential store. Backups include private state and artifact manifests separately from public code.

## Agent runtimes are replaceable

Hermes is the first-class reference integration for conversation, planning, skills, memory recall, tools, and channels. OpenClaw and other compatible runtimes occupy the same replaceable role. Forge owns the portable identity and records; no selected runtime is their sole custodian. A runtime can query Forge through a scoped interface and propose work, routing, or cleanup actions. The core validates each requested action against the caller's policy and ownership.

Hermes or OpenClaw can also execute a work attempt through its native interface. Coding work may go directly to Codex, Claude Code, or OpenCode. Runtime and execution are roles; one component may serve both, and a separate coordinator is optional. Preserve rich native features through adapter extensions and visible native-session links.

Keep runtime startup context focused. Retrieve scoped project evidence on demand from Forge and optional user-owned sources. Do not continually copy the entire history into every prompt or rewrite a runtime's existing memory. Replacing Hermes with OpenClaw preserves Forge's profile, records, workspace references, and shared capability bindings. Runtime-specific features remain available only through their connected, authorized implementation. Show these compatibility differences before switching. A disconnected runtime leaves direct dashboard controls and already-owned execution state available.

Upstream capabilities vary by installed version. Probe Hermes's capability endpoint and OpenClaw's authenticated gateway contract as applicable. A documented latest endpoint is not proof that an installed gateway supports it. See [ADAPTERS.md](ADAPTERS.md) and [COMPONENTS.md](COMPONENTS.md).

## State and recovery

Work state is derived from events such as queued, admitted, running, waiting for approval, waiting for capacity, checkpointing, paused, reconciling, completed, and failed. A process that disappeared becomes unknown or reconciling until checked. Recent chat activity does not prove that work is running. An agent's success message alone does not satisfy an artifact acceptance check.

Lease claims use an increasing execution generation. A worker must check its generation when claiming commands and committing results. Mediated external actions must check it at their execution boundary. A lease expiry alone cannot stop an unmediated shell or an external API request already in flight.

After an ambiguous external action, reconcile using a provider receipt or a supported idempotency key. Without either, hold for review rather than replaying blindly. Transactional local state and at-least-once delivery do not create a general exactly-once guarantee for external systems.

## Harness switching

1. Confirm target capabilities, account access, workspace availability, and budget policy.
2. Stop new source dispatches and request an adapter-supported safe boundary.
3. Verify the source has stopped acting, or prove all relevant effects are fenced. An uncontrolled external session cannot be silently adopted.
4. Save and verify artifact hashes, workspace changes, relevant evidence, open decisions, and unsettled effects. Failures before promotion leave the source paused or reconciling.
5. Commit the successor generation and new native binding atomically in the local journal. Revoke old runtime grants and invalidate unresolved approvals bound to the old request identity.
6. Build a small context package for the new harness, validate the workspace and acceptance criteria, and continue. Reconcile delayed events without granting them fresh authority.

This is a checkpointed continuation. It does not transfer an active inference process, hidden model state, or arbitrary provider-native session. Model changes can change behavior and quality. Browser state and remote host relocation require separate compatible facilities. The research informing this design has similarly bounded evidence, as documented in [RESEARCH.md](RESEARCH.md).

## Memory with evidence

Use three logical views over existing sources: current task context; project decisions, facts, and reusable procedures; and retained evidence. Delegate content storage and retrieval to the selected runtime or memory provider. Forge retains the portable profile, source references, scoped decisions, and continuity records. SQLite can search Forge's own records; that is not a new general memory, embedding, or knowledge-graph engine.

Memory records include scope, source reference, observation time, validity interval where known, version, sensitivity, and whether the content is user-confirmed, reported, inferred, or superseded. Correcting a preference must invalidate the old retrieval result. Scope filtering happens before retrieval. Untrusted source text remains data, not a policy update.

Obsidian and Markdown folders are optional source adapters. The existing source stays authoritative under its own write rules; indexes are derived. Proposed memory writes can be reviewed, and human edits remain discoverable. Keep secrets out of memory. Support correction, export, deletion of content and indexes, and explicit backup retention. Durable memory does not mean retaining every byte forever.

## Resource governor

Separate admission from enforcement. Reserve configurable interactive headroom, measure memory pressure and swap growth, and admit work using per-project priority, aging, and resource reservations. Track CPU, resident memory, browser contexts, process trees, API concurrency, and known provider limits independently. DRF informs allocation across bottlenecks; use conservative local policies first and benchmark any more complex scheduler.

Every managed resource has an owner, acquisition record, native identity, liveness check, and release rule. Match process identity with birth time as well as PID. Resource cleanup acts on verified Forge-owned resources. Shared user browsers and unrelated processes are not cleanup candidates just because they are large. Show unattributed consumption explicitly and label RSS aggregates that may include shared pages.

On macOS, native sessions initially support monitoring, admission, priority adjustments where permitted, and cooperative interruption. General hard per-job memory ceilings are not assumed. Use existing runtime/container/VM isolation where available rather than building a new sandbox or worker execution framework. Arbitrary native harness tools cannot be fully governed by an MCP connection alone.

Existing schedules are imported as references with their native scheduler as owner. New productive schedules also use a selected existing scheduler where possible. Do not create a second copy. Only a supported, explicit ownership transfer enables a different owner to dispatch that schedule. Any minimal cross-runtime admission queue uses persistent claim keys and coordinates native triggers; it does not reproduce a native scheduler's task loop.

## Approvals and permissions

Normalize a pending native request into a record with its adapter, session, request identity, execution generation, exact proposed action, target, payload digest, expiry, and available choices. Preserve native policy restrictions. Changing the action or generation invalidates the decision. Duplicate responses settle once locally; stale or ambiguous requests fail closed.

The dashboard or paired phone returns an authenticated decision to the originating native request. Native approval and sandbox enforcement remain with the originating execution boundary. Connected channels, including Hermes or OpenClaw gateways, can notify or link to the decision surface. Do not let an LLM infer approval from an unrelated conversational yes. Scoped recurring grants need explicit user policy; permanent blanket approval is not the default.

Use three declared integration levels: **observe** for imported metadata, **cooperate** for supported lifecycle and approval callbacks, and **enforce** only where an actual sandbox and action boundary mediate the required effects. An adapter that lacks a control must show it as unavailable. Observed desktop approval queues are not automatically controllable by another process.

## Tokens, dollars, and budgets

Record per-request input and output tokens, cache categories, retries, latency, served provider/model, and usage provenance where available. Preserve native usage semantics and scopes; some cache counts are subsets, while others are separate categories. Never add a cumulative session total to its already counted child requests. Use provider request IDs, message IDs, native counter epochs, and revisioned snapshots for deduplication and reconciliation.

Maintain separate columns for reported usage, estimated API-equivalent cost, provider-confirmed charges, subscription allocation, and unknown cost. Store currency and dated rate-card references. A subscription's unreported marginal cost is unknown, not automatically zero. Do not show an SDK estimate as an invoice. Record tool, browser, media, remote compute, and Hermes coordination costs when evidence supports them; parent rollups must not duplicate child spend.

Expose daily and monthly views by project, task, harness, verified account, provider, and model. Useful measures include cost per accepted outcome, failed-attempt spend, approval wait time, context reload overhead, and cache utilization. Mark incomplete coverage. Routing recommendations must account for task acceptance quality and capability, not just token price. Quota windows retain their native scope and reset semantics; duplicate account slots and shared organization limits cannot be counted as additional capacity.

Reserve projected spend before controlled dispatch and settle it against observed usage. Budget estimates, provider-enforced ceilings, and notification thresholds are distinct. A native or already in-flight request may incur charges beyond an observed threshold; a hard financial guarantee requires provider-side bounds and sufficiently complete metering. Billing adjustments are appended as reconciliations rather than silently overwriting history.

## Remote access and observability

Desktop and paired phone access use authenticated endpoints with explicit scopes. The local service binds to loopback by default. A private network or authenticated encrypted relay can connect remote surfaces without publishing raw machine control. Remote workers use per-host identities and capability grants.

When the laptop sleeps, show offline status and the last observed checkpoint. A relay can retain an expiring decision but cannot execute laptop work. Continued execution requires an available, explicitly configured worker and accessible artifacts. Do not promise native process migration across hosts.

One factual timeline joins work, attempts, tools, approvals, resources, artifacts, and usage. Raw content capture is opt-in, scoped, and redacted. Timeline playback reconstructs recorded state; it does not rerun side effects. Export observability through a version-pinned OpenTelemetry mapping when useful. No hidden reasoning is required for useful progress evidence.

## Release gates

Before managed execution is described as ready, prove: two-harness artifact continuation; stale executor and approval rejection; recovery around uncertain external actions; no duplicated native schedules; corrected and cross-project memory behavior; nested usage deduplication; and cleanup that leaves unrelated processes intact.

Performance is also a feature. Set an initial core-daemon idle target below 75 MB RSS and below 1% of one CPU core at the 95th percentile over a defined idle trace. These are unmeasured design targets. Report dashboard, Hermes, adapter, and worker overhead separately as well as in total. Publish measured failures and supported version combinations alongside successful demonstrations.
