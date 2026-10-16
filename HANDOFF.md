# Handoff

## Current state

Forge now has a runnable early local application, version 0.2.0. The MIT repository is https://github.com/darshanahirrao/forge on `main`. Current continuation checkpoint: `forge-v0.2.0`, the commit containing that BUILD_LOG entry and its durable tag. GitHub publication is source publication, not a hosted deployment or a claim that the full architecture is complete. The full goal remains active; read docs/COMPLETION_AUDIT.md for outstanding requirements.

The user's broader goal is Persistent Agency: one workspace with durable identity, work, memory references, accounts, native schedules, progress, approvals, and resource/cost visibility. Both harnesses and companion runtimes must be replaceable, including Hermes with OpenClaw. Multiple accounts per harness should serve the same work through supported safe continuation. Automatic account fallback and cross-harness transfer are not implemented in this first application.

Read docs/RUNTIME.md first for what actually exists. The interface has Overview, Work, Approvals, Accounts, Resources, and Connections views, light/dark themes, keyboard search, and an isolated fictional demo. Local work, context, checkpoints, account references, usage evidence, and receipts persist in native SQLite. Summary projections avoid loading full contexts on every poll.

A shared execution coordinator now supports experimental Codex app-server and Claude Agent SDK API drivers. One admission owner retains both its durable work lease and capacity until the owned native worker exits. It owns exact one-time controls, cancellation, native session binding, excerpt capture and usage evidence. Codex retains its permission handshake. Claude requires an API slot and explicit metered choice; subscription OAuth is not offered through the SDK under Anthropic's integration rules. Read docs/NATIVE_DRIVERS.md. Native Codex/Claude status probes are implemented. Hermes remains read-only health/capability discovery. Agent Deck and ccusage remain optional native CLI sources and were not installed during this work.

## Setup and checks

Use Node.js 24 or newer. `npm ci`, `npm run build`, `npm start`. Open `http://127.0.0.1:4710`. Development uses `npm run dev`, with Vite at 5173 and the API at 4710. Stop an existing service before starting another on its port. `node bin/forge.mjs --help` lists port/data-directory overrides.

macOS private state defaults to `~/Library/Application Support/Forge/workspace.sqlite`. Other platforms use user data directories. `FORGE_DATA_DIR` changes that location. One service owns a state directory through native SQLite exclusive locking. Native credentials stay outside Forge; account slots point at native configuration. No login startup agent or schedule is installed.

Validation commands: `npm run format:check`, `npm run check`, `npm test`, `npm run build`, `npm run test:e2e`. Browser tests use installed Chrome locally and Playwright Chromium in CI. They own a temporary state directory. Native fixtures run no model calls or shell tools. The committed GitHub workflow uses pinned action commits and Node 24.

At this checkpoint, 28 functional/API/driver tests and five browser flows pass, including axe checks. The installed Claude SDK passes a real native stream-json transport check against a synthetic executable worker, including native permission request identity and process exit. A real installed Codex initialization handshake passed without an account lookup or model turn. Actual model-backed execution, real upstream tool approvals/artifacts, native account isolation, and multi-account transfer have not been exercised. Dependency audit returned zero known vulnerabilities. Preliminary service RSS was about 80 MB before the new adapter; the earlier 75 MB / 1% target remains unproven.

## Source map

- `server/app.ts`: loopback HTTP API, origin/host/CSRF controls, local/demo routing, and explicit native connections.
- `server/store.ts`: transactional canonical records, summary projections, revisioned work, receipts, exclusive ownership, and recovery.
- `server/execution.ts`: shared admission, work leases, permission receipts, one-time decisions and lifecycle.
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
- Work-context export contains user-authored notes and checkpoints, not a native transcript, artifact manifest, live authority, or proven universal checkpoint. Automatic transfer is disabled.
- SDK/imported estimates, native tokens, confirmed charges, subscription allocation, and unknown coverage remain different concepts. No paid model calls are needed to run the local tests or workspace.
- Keep user runtime data out of Git. Update this file and BUILD_LOG.md with every focused checkpoint, validate, commit, push, and verify the remote commit. Never add an AI co-author trailer.

## Concrete next steps

1. Run a controlled real Codex task in a synthetic project with an explicitly selected native account. Verify effective permissions, native approval callback types, completion, cancellation, and actual usage semantics against the installed version. Keep paid runs and real identity data out of fixtures and Git.
2. Validate Claude native tool execution with a synthetic local provider before any real model-backed conformance. Extend reuse evaluation before other managed harnesses. Hermes needs run/session/memory/approval integration only where its advertised installed API permits it; the installed legacy approval endpoint lacks request/generation identity and must not be forwarded blindly. OpenClaw remains a replaceable runtime target. Remote drivers must preserve native run ownership through disconnect/restart before being admitted.
3. Measure whole-stack idle CPU and RSS with defined traces, including native workers and the UI. Evaluate real memory pressure and ownership evidence before making resource-enforcement claims.
4. Add native schedule inventory while preserving a single existing owner. Build an authenticated phone path before advertising remote approvals.
5. Prove two-account artifact continuation and then cross-harness continuation with explicit context coverage, native permission revalidation, external-effect reconciliation, and failure injection. Do not turn the current context export into a lossless-migration claim.
