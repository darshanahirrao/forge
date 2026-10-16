# Handoff

## Current state

Forge is an MIT-licensed architecture proposal. The concept is Persistent Agency: durable identity, workspace, work, and memory with replaceable agent runtimes and execution harnesses. Hermes is important as a first-class reference integration, but the user explicitly requires replacing Hermes itself with OpenClaw or another compatible runtime. Codex, Claude Code, and OpenCode also need real native adapters with explicit capability negotiation.

The current request is research, concept naming, and an architecture diagram for a primary agentic workspace. The user specifically wants whole-harness switching with persistent identity, memory, workspace, tools, schedules, policies, progress, and usage history. Do not describe this repository as a working dashboard or claim that any proposed feature is deployed.

The user's latest correction is a firm scope boundary: reuse browser/computer use and every other capability already implemented by runtimes or providers. Forge builds the missing coordination, continuity, resource/cost visibility, and native approval routing. It must not become a replacement browser, computer-use, editor, terminal, skills, memory, or task-execution framework. Read docs/NATIVE_BOUNDARY.md first.

The user also requires that anyone can mold the workspace around their own needs. docs/BLUEPRINTS.md proposes presets, configuration, and extensions with shareable sanitized component bindings. docs/REUSE_AUDIT.md records initial evidence for Agent Deck, CC Switch, ccusage, HAPI, and Superset. None has been installed or tested. Choose a suitable existing foundation before treating the earlier Rust/SQLite sketch as an implementation decision.

The latest requirement is multiple native accounts for the same harness, with the same Forge workspace and work context across eligible account changes. docs/ACCOUNTS.md separates account slots from work identity, specifies scoped routing and safe continuation, and keeps native limits, shared quota scopes, and billing modes explicit. Reuse Agent Deck's documented Claude account flow where suitable. Claude's native multiple-account modes and Codex credential/account interfaces were reviewed; isolation, native resume, and cross-harness behavior still need conformance tests. No actual account was inspected or changed.

## Setup

Public repository: https://github.com/darshanahirrao/forge, branch `main`.

No application dependencies or server setup are required to read this checkpoint. Start with README.md, docs/ARCHITECTURE.md, docs/COMPONENTS.md, docs/ADAPTERS.md, and docs/RESEARCH.md. Diagram source is in docs/diagrams/architecture.mmd and docs/diagrams/handoff.mmd. The overview SVG is editable vector source.

## Important decisions

- A deterministic local core owns durable state and grants. A selected replaceable runtime, such as Hermes or OpenClaw, proposes actions and provides assistant capabilities. No runtime is a required permanent dependency.
- Prefer a small local installation built on a suitable existing foundation. The initial Rust/SQLite topology is provisional. Private runtime state stays outside the public repository.
- The Work Capsule is the task portability unit. Credentials, live authority, hidden reasoning, and browser cookies are excluded.
- Observe, cooperate, and enforce are different control levels. No universal control is assumed for existing desktop sessions.
- Accounting distinguishes native usage, estimates, confirmed charges, subscription allocation, and unknown coverage. Avoid cumulative and nested double counting.
- Account slots are independent bindings, not separate workspaces. Verify effective identity, project data access, and billing mode; preserve transfer lineage and account attribution. Multiple slots may share one quota bucket. Connecting accounts must not require a running worker per account.
- Native schedules keep one owner. Harness switching occurs at verified checkpoints with source stop or enforcement evidence.
- Prefer existing native implementations for every capability, including memory and scheduling. Minimal new mechanisms require a demonstrated cross-runtime coordination gap.
- Apply the same reuse rule to existing libraries and open-source products, including proposed Forge core features. Use or extend a suitable existing solution; do not assume the architecture proves an unfilled gap.

## Concrete next steps

1. Extend the initial reuse map in docs/REUSE_AUDIT.md with interface checks and a synthetic-data evaluation, including native account switching and the evidence in docs/ACCOUNTS.md. Decide whole-product fit, then adopt/extend/build only a verified remaining gap. Compare alternatives without running multiple overlapping control planes by default.
2. Define adapter capability and event schemas, then build usage fixtures for two native harnesses with sanitized data.
3. Implement read-only inventory and measure whole-stack idle overhead before adding managed execution.
4. Build native approval correlation, source ownership, reconciliation, and adapter conformance before claiming cross-harness continuation.
5. Demonstrate real artifact-producing work across two harnesses, including a failure near an external side effect.

Current continuation checkpoint: `multi-account-continuity`, the commit containing that BUILD_LOG entry. Architecture milestones are retained at `native-capabilities-20261016` and `architecture-20261016`. Source control publication does not deploy an application or change any existing automation.
