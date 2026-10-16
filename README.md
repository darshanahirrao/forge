# Forge

**Your work survives your tools.**

Forge is an open-source local workspace for people who work across AI runtimes and harnesses. It keeps work records, context, native account references, approval receipts, machine resources, and usage evidence together. Native tools supply execution. Hermes is an important integration and remains replaceable.

We call the product concept **Persistent Agency**: your agent profile, memory, workspace, work history, shared connections, schedules, and policies remain in Forge while you change a compatible execution harness at a verified checkpoint.

**Status: early local application, v0.2.0.** Work tracking, account slots, live machine telemetry, a separate demo workspace, and experimental native Codex and Claude API execution/approval adapters are implemented. The broader architecture remains a roadmap. Automatic account switching, cross-harness transfer, phone approvals, scheduling adapters, and hard resource enforcement are not implemented. See [the implementation and evidence](docs/RUNTIME.md).

## Run Forge

Use Node.js 24 or newer:

```sh
npm ci
npm run build
npm start
```

Open [the local workspace](http://127.0.0.1:4710). The real workspace starts empty. Use the workspace selector to explore clearly labeled fictional examples in a separate in-memory demo. Demo actions never start native execution. Machine telemetry is live in both views.

Create a work record, add a native account slot, and check a supported account from the Accounts view. For experimental managed Codex work, select the account and an existing project directory, then review the launch dialog. Native sign-in stays in the harness; Forge does not collect credentials or purchase credits. Each launch checks effective native account configuration and permissions. Claude managed turns use the official Agent SDK with API authentication and an explicit metered-usage choice; native claude.ai subscription sessions remain in their native client. [Claude setup and integration limits](docs/NATIVE_DRIVERS.md) explain this distinction.

Private state is stored outside this repository. On macOS, the default is `~/Library/Application Support/Forge/workspace.sqlite`. Use `FORGE_DATA_DIR` or `node bin/forge.mjs --data-dir DIRECTORY` to select another location. `FORGE_PORT` or `--port` changes the loopback port. Stop a foreground service with Ctrl+C. No startup agent, background schedule, or hosted service is installed.

## What works today

- Persistent work, goals, context, checkpoints, revision conflict checks, and user-selected context exports.
- Multiple account slots per supported harness choice, native Codex/Claude authentication status checks, and native Codex quota evidence when exposed.
- A shared execution coordinator for experimental Codex app-server and Claude Agent SDK API turns, with one managed worker, supported exact approvals, cancellation, native session continuation, usage snapshots, and recovery receipts.
- Real CPU, OS memory, process RSS, and service-memory visibility. Quiet mode gates new managed work.
- Hermes API health and capability discovery through an existing local server.
- Optional Agent Deck session inventory and ccusage daily Claude reports through their installed native CLIs.
- Responsive light/dark views, keyboard search, and sanitized setup-blueprint export.

Native adapters have protocol/callback fixtures, an installed Claude SDK transport check with a synthetic native worker, and an installed Codex initialization smoke check. A real model-backed task and real account-transfer scenarios have not been exercised. Native limits, permissions, and compatibility still apply.

The figure below describes the broader architecture roadmap.

![Forge architecture](docs/diagrams/architecture.svg)

## The intended experience

- See what is running, what owns the resources, and what is waiting for a decision.
- Keep a durable record of project decisions, verified progress, artifacts, and relevant memory.
- Connect native browser/computer use, terminals, file tools, skills, and other capabilities through existing runtime interfaces.
- Choose a harness and model separately, with an explicit capability check before continuing work.
- Connect multiple native accounts per harness and continue the same work through eligible accounts, with visible limits and account attribution.
- Replace Hermes with OpenClaw, or another compatible runtime, while retaining Forge's agent profile and work history.
- Answer supported approval requests from desktop or an authenticated phone surface.
- Understand tokens, retries, cache usage, tool charges, and dollars per task and project.
- Preserve laptop headroom through admission control and cleanup of resources Forge owns.

The defining demonstration is a real task checkpointed in one harness, continued in another, with artifact checks, accounting continuity, and a single authorized executor. It must also recover correctly when a worker fails around an external action.

## Read the design

- [Current implementation, setup, and limits](docs/RUNTIME.md)
- [Native capability boundary](docs/NATIVE_BOUNDARY.md)
- [Initial existing-solution audit](docs/REUSE_AUDIT.md)
- [Customizable workspace blueprints](docs/BLUEPRINTS.md)
- [Architecture and failure semantics](docs/ARCHITECTURE.md)
- [The intended workspace experience](docs/EXPERIENCE.md)
- [Harness interfaces and integration limits](docs/ADAPTERS.md)
- [Dynamic components and replacement rules](docs/COMPONENTS.md)
- [Multiple accounts and workspace continuity](docs/ACCOUNTS.md)
- [Research, prior art, and evidence boundaries](docs/RESEARCH.md)
- [Product capabilities and delivery sequence](docs/PRODUCT.md)
- [Editable architecture diagram](docs/diagrams/architecture.mmd)
- [Harness handoff sequence](docs/diagrams/handoff.mmd)
- [Build log](BUILD_LOG.md) and [continuation handoff](HANDOFF.md)

## Design principles

The core operates without an LLM. A selected runtime such as Hermes or OpenClaw can plan and assist, while the core validates permissions, admission, state changes, and resource ownership. Runtimes, harnesses, model routes, memory providers, tools, skills, channels, and workers connect through versioned capability contracts. Native features remain available through extensions. Unsupported controls are visible as unavailable.

Forge builds adapters, continuity, and cross-runtime visibility. Browser automation, computer use, terminal and file execution, skills, memory engines, and native scheduling stay with their existing implementations. The [native boundary](docs/NATIVE_BOUNDARY.md) defines the scope.

Observation, cooperative management, and sandbox enforcement are different integration levels. Discovering an existing process or reading saved chat metadata does not grant control over its approvals or resource limits.

This design builds on published work on agent persistence, memory, and scheduling. Its research foundations are credited in [RESEARCH.md](docs/RESEARCH.md). Product differentiation and real-world reliability remain hypotheses to test.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Useful contributions include native adapter conformance, recorded synthetic fixtures, accessibility improvements, and evidence for existing components Forge can reuse. Distinguish documented upstream support from behavior you have tested. Never contribute private conversations, memory, credentials, billing records, or account data.

The project is available under the [MIT License](LICENSE). Runtime integrations retain their own licenses, authentication requirements, and upstream policies.
