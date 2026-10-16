# Handoff

## Current state

Forge is an MIT-licensed architecture proposal. The concept is Persistent Agency: durable identity, workspace, work, and memory with replaceable agent runtimes and execution harnesses. Hermes is important as a first-class reference integration, but the user explicitly requires replacing Hermes itself with OpenClaw or another compatible runtime. Codex, Claude Code, and OpenCode also need real native adapters with explicit capability negotiation.

The current request is research, concept naming, and an architecture diagram for a primary agentic workspace. The user specifically wants whole-harness switching with persistent identity, memory, workspace, tools, schedules, policies, progress, and usage history. Do not describe this repository as a working dashboard or claim that any proposed feature is deployed.

## Setup

Public repository: https://github.com/darshanahirrao/forge, branch `main`.

No application dependencies or server setup are required to read this checkpoint. Start with README.md, docs/ARCHITECTURE.md, docs/COMPONENTS.md, docs/ADAPTERS.md, and docs/RESEARCH.md. Diagram source is in docs/diagrams/architecture.mmd and docs/diagrams/handoff.mmd. The overview SVG is editable vector source.

## Important decisions

- A deterministic local core owns durable state and grants. A selected replaceable runtime, such as Hermes or OpenClaw, proposes actions and provides assistant capabilities. No runtime is a required permanent dependency.
- Begin as a small single-node system with SQLite and local artifacts. Private runtime state stays outside the public repository.
- The Work Capsule is the task portability unit. Credentials, live authority, hidden reasoning, and browser cookies are excluded.
- Observe, cooperate, and enforce are different control levels. No universal control is assumed for existing desktop sessions.
- Accounting distinguishes native usage, estimates, confirmed charges, subscription allocation, and unknown coverage. Avoid cumulative and nested double counting.
- Native schedules keep one owner. Harness switching occurs at verified checkpoints with source stop or enforcement evidence.

## Concrete next steps

1. Agree the first implementation slice from docs/PRODUCT.md without expanding the architecture into supporting infrastructure.
2. Define adapter capability and event schemas, then build usage fixtures for two native harnesses with sanitized data.
3. Implement read-only inventory and measure whole-stack idle overhead before adding managed execution.
4. Build native approval correlation, source ownership, reconciliation, and adapter conformance before claiming cross-harness continuation.
5. Demonstrate real artifact-producing work across two harnesses, including a failure near an external side effect.

Checkpoint: `architecture-20261016`, the commit containing this handoff. Source control publication does not deploy an application or change any existing automation.
