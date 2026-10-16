# Handoff

## Current state

Forge now has a runnable early local application, version 0.4.1. The MIT repository is https://github.com/darshanahirrao/forge on `main`. Current continuation checkpoint: `forge-v0.4.1`, the commit containing that BUILD_LOG entry and its durable tag. GitHub publication is source publication, not a hosted deployment or a claim that the full architecture is complete. The full goal remains active; read docs/COMPLETION_AUDIT.md for outstanding requirements.

The user's broader goal is Persistent Agency: one workspace with durable identity, work, memory references, accounts, native schedules, progress, approvals, and resource/cost visibility. Both harnesses and companion runtimes must be replaceable, including Hermes with OpenClaw. Multiple accounts per harness should serve the same work through supported safe continuation. Explicit verified Codex/Claude API handoff is implemented around one work ID and project directory; automatic quota fallback and arbitrary native-state migration remain open.

Read docs/RUNTIME.md first for what actually exists. The interface has Overview, Work, Activity, Approvals, Accounts, Resources, and Connections views, light/dark themes, keyboard search, and an isolated fictional demo. Local work, context, checkpoints, account/native-source references, activity observations, usage evidence, and receipts persist in native SQLite. Summary projections avoid loading full contexts on every poll.

A shared execution coordinator supports experimental Codex app-server and Claude Agent SDK API drivers. One admission owner retains both its durable work lease and capacity until the owned native worker exits. It owns exact one-time controls, cancellation, native session binding, excerpt capture and usage evidence. Codex retains its permission handshake. Claude requires an API slot and explicit metered choice; subscription OAuth is not offered through the SDK under Anthropic's integration rules. Read docs/NATIVE_DRIVERS.md. Native Codex/Claude status probes are implemented. Activity now observes Codex/Claude native chats, unchanged Codex/Hermes schedule definitions, capability-aware Hermes sessions and OpenClaw's fixed native session-list tool. These references confer no foreign approval/execution authority. Read docs/NATIVE_ACTIVITY.md. Agent Deck and ccusage remain optional native CLI sources and were not installed during this work.

The v0.4.1 patch closes a launch/read admission race by checking the native inventory guard after asynchronous directory validation, immediately before the controller reserves capacity synchronously. Do not move that check before an await.

## Setup and checks

Use Node.js 24 or newer. `npm ci`, `npm run build`, `npm start`. Open `http://127.0.0.1:4710`. Development uses `npm run dev`, with Vite at 5173 and the API at 4710. Stop an existing service before starting another on its port. `node bin/forge.mjs --help` lists port/data-directory overrides.

macOS private state defaults to `~/Library/Application Support/Forge/workspace.sqlite`. Other platforms use user data directories. `FORGE_DATA_DIR` changes that location. One service owns a state directory through native SQLite exclusive locking. Native credentials stay outside Forge; account slots point at native configuration. No login startup agent or schedule is installed.

Validation commands: `npm run format:check`, `npm run check`, `npm test`, `npm run build`, `npm run test:e2e`. Browser tests use installed Chrome locally and Playwright Chromium in CI. They own a temporary state directory. Native fixtures run no model calls or shell tools. The committed GitHub workflow uses pinned action commits and Node 24.

At this checkpoint, 46 functional/API/continuity/driver/inventory checks and seven browser flows pass. Test/native fixture sources are now included in the TypeScript gate. The installed Claude SDK passes a real native stream-json transport check against a synthetic executable worker, including native permission request identity and process exit. A real installed Codex initialization handshake passed without an account lookup or model turn. Separate opt-in real native checks now pass for Codex 0.159.3 and native Claude Code 2.1.301 (SDK 0.3.301), each against a local deterministic provider. Both exercise an exact API approval, native tool, verified temporary artifact, native usage and worker exit. Claude also rejects contradictory native project credential/routing settings through its host-managed route. No paid model calls or private credentials are used. A further native check chains Codex to Claude API profile one and then profile two: three native runs/approvals, three actual artifacts, selected context and one work ID, with three retained usage scopes. Both destinations read the preceding artifact through native tools. This uses synthetic local inference and isolated fixture credentials; real model quality and live provider/subscription isolation remain unverified. Dependency audit returned zero known vulnerabilities. Preliminary service RSS was about 80 MB before the new adapter; the earlier 75 MB / 1% target remains unproven.

## Source map

- `server/app.ts`: loopback HTTP API, origin/host/CSRF controls, local/demo routing, and explicit native connections.
- `server/store.ts`: transactional canonical records, summary projections, revisioned work, receipts, exclusive ownership, and recovery.
- `server/execution.ts`: shared admission, checkpoint ownership, work leases, exact decisions, source-exit receipts and revision-bound launch.
- `server/continuity.ts`: Git/explicit artifact fingerprints, private Work Capsules, context coverage and transactional binding handoff.
- `server/native-sources.ts`, `server/adapters/inventory.ts`: native source references, bounded metadata adapters, private observation/error retention and read admission.
- `server/adapters/driver.ts`, `codex-driver.ts`, `claude-driver.ts`: native contract and native transports/tool delegation.
- `server/adapters/`: stdio RPC transport, native authentication, executable discovery, Hermes and existing CLI source readers.
- `shared/types.ts`: current application contracts; broader future contracts remain in the architecture documents.
- `web/`: root state, focused view components, forms/dialogs, shared primitives, tokens, and formatting.
- `tests/`: synthetic native/HTTP fixtures, API and persistence checks, browser flows, and accessibility checks.

## Important decisions

- Reuse first. Do not build a browser, computer-use engine, editor, terminal, memory engine, model loop, or native scheduler. Evaluate existing whole products and components before adding glue. Read docs/NATIVE_BOUNDARY.md and docs/REUSE_AUDIT.md.
- Hermes is important and replaceable. The service and direct workspace controls do not require an always-running LLM or companion runtime.
- The TypeScript/Node prototype reuses native SQLite, Fastify, React, and Vite. An earlier Rust sketch is not a chosen production rewrite.
- Account slots are separate from work identity. Native identity, quota provenance, billing mode, and data access remain explicit. Several slots can share a limit. Unknown identities and allowance do not become invented capacity.
- Native grants stay tied to the exact request and generation. Unsupported approval types receive no grant. A recorded decision does not imply provider execution or a broad future permission.
- Only Forge-owned app-server connections are controlled. Observed processes and foreign desktop sessions retain native ownership. Shutdown is not universal fencing of detached tools or external effects.
- Plain work-context export remains user-authored notes/checkpoints. Work Capsules add selected artifact fingerprints, up to five native result excerpts and source/parent references. Handoff verifies source exit, revision and files, changes the account/harness, and resets native session authority. Native full histories stay linked. Read docs/CONTINUITY.md; this is not lossless hidden-state migration.
- SDK/imported estimates, native tokens, confirmed charges, subscription allocation, and unknown coverage remain different concepts. No paid model calls are needed to run the local tests or workspace.
- Keep user runtime data out of Git. Update this file and BUILD_LOG.md with every focused checkpoint, validate, commit, push, and verify the remote commit. Never add an AI co-author trailer.

## Concrete next steps

1. Continue the full audit with scoped native memory references and persistent profile/runtime bindings. Reuse Hermes/OpenClaw/Obsidian Markdown and native memory tools; do not build a new memory engine. Activity now aggregates existing source observations, but managed runtime replacement, native adoption, paging/deduplication and authority still need proof.
2. Run `npm run test:native` to repeat both local-provider native tool checks when changing native contracts. Extend cancellation/recovery and real model-backed conformance. Extend reuse evaluation before other managed harnesses. Hermes needs run/session/memory/approval integration only where its advertised installed API permits it; the installed legacy approval endpoint lacks request/generation identity and must not be forwarded blindly. OpenClaw remains a replaceable runtime target. Remote drivers must preserve native run ownership through disconnect/restart before being admitted.
3. Measure whole-stack idle CPU and RSS with defined traces, including native workers and the UI. Evaluate real memory pressure and ownership evidence before making resource-enforcement claims.
4. Extend the new native schedule inventory to supported controls and ticker-health evidence while preserving a single existing owner. Build an authenticated phone path before advertising remote approvals.
5. Extend the native three-run continuation proof to additional adapters, live accounts where authorized, and failure injection near external effects. Preserve context coverage and source ownership; do not relabel selected-context continuity as universal lossless migration.
6. Prefer full native history fork/resume/transfer where a harness and account context support it, reusing the official SDK or evaluated Agent Deck operations. The current bounded portable excerpts are a fallback with explicit coverage. If native cumulative usage travels with a fork/resume, preserve counter baselines/epochs so changing account attribution does not count the source history twice.

## State upgrade at v0.3

State version 2 is forward-gated. Existing version-1 file workspaces receive a private SQLite `workspace.sqlite.before-v2.UUID.sqlite` copy before upgrade. The active database retains all records. Legacy runs without a confirmed exit receipt cannot be used directly for handoff. See docs/CONTINUITY.md and docs/RUNTIME.md for recovery/rollback limits. Never downgrade against the active newer state or mix snapshot files with unrelated SQLite sidecars.
