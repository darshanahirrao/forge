# Forge

**Your work survives your tools.**

Forge is a proposed open-source coordination workspace for people who work across AI runtimes and harnesses. It connects ongoing work, memory references, approvals, machine resources, and usage accounting in one place while using each runtime's existing capabilities. Hermes and OpenClaw are replaceable agent runtime integrations. Codex, Claude Code, OpenCode, and other harnesses are execution choices. Hermes is a first-class reference integration, with no required runtime dependency.

We call the product concept **Persistent Agency**: your agent profile, memory, workspace, work history, shared connections, schedules, and policies remain in Forge while you change a compatible execution harness at a verified checkpoint.

**Status: research and architecture proposal. There is no runnable Forge application yet.** The diagrams describe intended behavior. No harness integration, migration, resource enforcement, or usage accounting has been implemented or benchmarked here.

![Forge architecture](docs/diagrams/architecture.svg)

## The experience

- See what is running, what owns the resources, and what is waiting for a decision.
- Keep a durable record of project decisions, verified progress, artifacts, and relevant memory.
- Connect native browser/computer use, terminals, file tools, skills, and other capabilities through existing runtime interfaces.
- Choose a harness and model separately, with an explicit capability check before continuing work.
- Replace Hermes with OpenClaw, or another compatible runtime, while retaining Forge's agent profile and work history.
- Answer supported approval requests from desktop or an authenticated phone surface.
- Understand tokens, retries, cache usage, tool charges, and dollars per task and project.
- Preserve laptop headroom through admission control and cleanup of resources Forge owns.

The defining demonstration is a real task checkpointed in one harness, continued in another, with artifact checks, accounting continuity, and a single authorized executor. It must also recover correctly when a worker fails around an external action.

## Read the design

- [Native capability boundary](docs/NATIVE_BOUNDARY.md)
- [Architecture and failure semantics](docs/ARCHITECTURE.md)
- [The intended workspace experience](docs/EXPERIENCE.md)
- [Harness interfaces and integration limits](docs/ADAPTERS.md)
- [Dynamic components and replacement rules](docs/COMPONENTS.md)
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

At this stage, useful contributions are protocol corrections, adapter capability evidence, adversarial failure scenarios, and improvements to the proposed work checkpoint format. Please distinguish documented upstream support from behavior you have tested. Never contribute private conversations, memory, credentials, billing records, or account data.

The project is available under the [MIT License](LICENSE). Runtime integrations retain their own licenses, authentication requirements, and upstream policies.
