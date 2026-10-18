# Forge

**Keep the work. Change the harness.**

A local workspace for developers who use more than one agent harness. Keep your work, goals, selected memory, approvals and usage history together while Codex, Claude, OpenCode, Hermes or OpenClaw supplies native execution.

**Public alpha: v0.41.0. Node.js 24+. macOS and Linux.** Native execution is experimental on the evaluated versions. The [support matrix and known limits](docs/PUBLIC_ALPHA.md) distinguish what works from what remains.

## Try Forge

Run the tagged source:

```sh
git clone https://github.com/darshanahirrao/forge.git
cd forge
git checkout forge-v0.41.0
npm ci
npm run build
node bin/forge.mjs doctor
npm start
```

Open [Forge](http://127.0.0.1:4710). Choose **See a handoff example** to inspect a fictional Codex-to-Hermes task and its public receipt. The isolated demo needs no model account and never starts a native tool. Machine telemetry remains live.

To use your own project, create a work record, link a native account and review a launch. Native installation, sign-in and tools stay with the harness. Nothing installs a background service or changes native schedules automatically.

Prefer a compiled package? Download the archive and checksum from [Releases](https://github.com/darshanahirrao/forge/releases), then follow the [three-command install and first session](docs/PUBLIC_ALPHA.md). No npm registry release or global build tools are required.

A compact workbench puts the work queue beside pending decisions, with a narrow activity rail, light/dark themes, adjustable row density and keyboard navigation. Open **View options** for display preferences and shortcuts.

## Why Forge

- **One work record across tools.** Continue a goal with retained checkpoints, selected memory and explicit context coverage. Native hidden state remains provider-specific.
- **One place for decisions.** Review supported native approvals and see what needs attention, including optional private phone access.
- **Know what is running.** Attribute supported native workers, inspect laptop pressure and pause new managed work.
- **Know what was spent.** Keep account-scoped token evidence, USD estimates and spending holds together. Estimates remain separate from invoices.
- **Make it yours.** Replace compatible harnesses or companions through the typed SDK, ACP/MCP contracts and reviewed blueprints.
- **Share the progress.** Review and export an allowlisted work receipt without work titles, prompts, memory, files, account names or identifiers. No upload or public sharing happens automatically.

Forge is a control plane over existing native capabilities. Browser use, computer use, tools, model loops, native memory engines and scheduling stay with their existing implementations. Hermes is a first-class integration and remains replaceable.

Read the [alpha guide](docs/PUBLIC_ALPHA.md), [security boundaries](SECURITY.md), [native integration setup](docs/NATIVE_DRIVERS.md) and [full completion audit](docs/COMPLETION_AUDIT.md). The complete vision is still in progress.

See [one native task across five harnesses](docs/NATIVE_HANDOFF_EXAMPLE.md), including the exact conformance scope and a public receipt.

## What works today

- Persistent work, goals, context, checkpoints, revision conflict checks, user-selected context exports, and verified [Work Capsules and native handoff](docs/CONTINUITY.md).
- Stable profiles and native memory references, project/work scopes, reviewed input fingerprints, corrected-context isolation and selected-memory continuity across supported harnesses/accounts.
- Multiple account slots and reviewed ordered routing scoped to the project/profile, with fresh native identity/quota evidence, shared-limit handling and explicit billing choices.
- Managed monthly/work spending admission, atomic attempt reservations, native counter deltas, unknown-cost holds and separate operator acceptance. Estimates remain distinct from invoices.
- A shared execution coordinator for experimental Codex app-server, Claude Agent SDK API, OpenCode v2, Hermes ACP and OpenClaw Gateway turns, with one managed worker, supported exact approvals, cancellation, native session continuation, usage snapshots, and recovery receipts.
- Real CPU, OS memory, process RSS and service-memory visibility, with [managed native worker attribution](docs/RESOURCES.md) and direct review of owning work. A fresh native macOS pressure check holds new managed launches at reported warning/critical pressure; explicit observe-only mode and quiet mode remain available.
- Native activity across profile/account homes: Codex and Claude chats, byte-preserving Codex/Hermes schedule inventory, and capability-aware Hermes/OpenClaw session API observations.
- Optional Agent Deck session inventory and ccusage daily Claude reports through their installed native CLIs.
- Optional macOS user service with verified native installation ownership, start/status/stop/restart/removal and no automatic task replay after a crash.
- Optional generic ntfy alerts with private setup, durable delivery evidence, current-request checks and no uncertain-delivery retry.
- Responsive light/dark views, keyboard search, sanitized setup-blueprint export, and opt-in private phone access to the same workspace/inbox with recorded reviewer identity.

Native adapters have protocol/callback fixtures plus [repeatable native tool conformance checks](tests/native/README.md). Actual Codex, Claude, OpenCode, Hermes and OpenClaw native workers passed an approval, tool execution, exact artifact verification and usage reporting against local deterministic providers, with zero paid model calls. A native Codex-to-Claude-to-second-Claude-profile-to-OpenCode-to-Hermes-to-OpenClaw chain retains one work/profile identity, selected memory, its goal/checkpoint, six verified artifacts, six account usage scopes and six OS-checked native worker roots. A separate native check switches between two OpenCode profiles with distinct synthetic credentials and a verified artifact read. Inference is deterministic and local; live subscription/account isolation and real model quality remain unverified. Native limits, permissions, and compatibility still apply.

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
- [Background operation and macOS service setup](docs/BACKGROUND_SERVICE.md)
- [Private file/Keychain references for background account credentials](docs/CREDENTIAL_REFERENCES.md)
- [Native resource ownership and observation limits](docs/RESOURCES.md)
- [Private phone access and native approval review](docs/PHONE_ACCESS.md)
- [Optional ntfy alerts, private setup and delivery evidence](docs/NOTIFICATIONS.md)
- [Native OpenClaw execution, profile setup and conformance](docs/OPENCLAW.md)
- [Native Hermes execution, memory and conformance](docs/HERMES.md)
- [Native OpenCode profile setup and conformance](docs/OPENCODE.md)
- [Versioned native harness connectors](docs/NATIVE_CONNECTORS.md)
- [Native capability boundary](docs/NATIVE_BOUNDARY.md)
- [Native chats, schedules, sources and coverage](docs/NATIVE_ACTIVITY.md)
- [Native scheduler evidence, aging and remaining controls](docs/SCHEDULER_EVIDENCE.md)
- [Reviewed native Hermes pause/resume and outcome receipts](docs/NATIVE_SCHEDULE_CONTROLS.md)
- [Profiles, scoped native memory and corrections](docs/MEMORY.md)
- [Native Hermes/OpenClaw profile migration and work continuation](docs/NATIVE_MIGRATIONS.md)
- [Initial existing-solution audit](docs/REUSE_AUDIT.md)
- [Customizable workspace blueprints](docs/BLUEPRINTS.md)
- [Architecture and failure semantics](docs/ARCHITECTURE.md)
- [The intended workspace experience](docs/EXPERIENCE.md)
- [Harness interfaces and integration limits](docs/ADAPTERS.md)
- [Dynamic components and replacement rules](docs/COMPONENTS.md)
- [Multiple accounts and workspace continuity](docs/ACCOUNTS.md)
- [Ordered account routing, native evidence and safe continuation](docs/ACCOUNT_ROUTING.md)
- [Spending budgets, counter evidence and accepted work](docs/SPENDING.md)
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
