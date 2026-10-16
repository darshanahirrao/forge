# Product direction

**Forge: Persistent Agency. Your work survives your tools.**

One place to understand and operate ongoing AI work. Hermes and OpenClaw are replaceable companion runtimes. Runtimes, harnesses, models, memory backends, tools, channels, and hosts are explicit choices around a durable agent profile and task record.

Anyone should be able to reshape that arrangement through presets, configuration, and extensions. The proposed [workspace blueprints](BLUEPRINTS.md) separate a shareable setup from private work data. A strong default should remain simple while deeper customization stays accessible.

## Capabilities worth earning

| Capability | What the person gets | What makes it credible |
| --- | --- | --- |
| One control surface | Work, native activity, approvals, resources, memory references, and usage. | Existing runtime capabilities and surfaces connected through adapters. |
| Work Capsules | Continue the same goal through a compatible harness. | Verified artifacts, explicit missing capabilities, safe handoff. |
| Dynamic components | Replace Hermes or OpenClaw, as well as the coding harness and other service backends. | Independent profile and work state, versioned contracts, verified replacement. |
| Multiple accounts | Continue the same work through compatible accounts of one harness or several harnesses. | Native account isolation, verified identity, scoped routing, safe continuation, and honest limit visibility. |
| Workspace blueprints | Shape and share a setup for different work and preferences. | Existing component bindings, sanitized configuration, compatibility preview, and supported extension contracts. |
| Resource view and Quiet mode | See ownership and preserve capacity for foreground work. | Real telemetry and admission control over managed work. |
| Token and dollar ledger | Understand spend by project, task, harness, and model. | Source-labeled usage, deduplication, estimated versus confirmed charges. |
| Approval inbox | Handle supported decisions from desktop or phone. | Authenticated responses tied to the exact live native request. |
| Run timeline | See tools, waits, failures, artifacts, and cost in one factual sequence. | Recorded events and receipts; playback never silently reruns an action. |
| Memory with receipts | Recover decisions and evidence without repeating the whole history. | Scope, source, correction, deletion, and retrieval evaluations. |
| Harness recommendations | Choose a capable route for the task and budget. | Acceptance quality, measured task outcomes, actual access, and explicit policy. |
| Recovery and optional remote work | Resume after failure or continue on an available configured worker. | Reconciliation, available artifacts, and a single executor per exclusive scope. |

These are intended capabilities. They are not currently available in Forge.

Browser/computer use, terminal and file execution, native skills, memory engines, and existing schedulers are supplied by connected runtimes and providers. Forge's contribution is their coordination, continuity, and cross-runtime visibility. See [NATIVE_BOUNDARY.md](NATIVE_BOUNDARY.md).

## Delivery sequence

First evaluate the [existing-solution candidates](REUSE_AUDIT.md). The sequence below describes needed outcomes; it does not require implementing a new service for each row or rebuilding an existing control plane.

1. **Observe:** ship a small local resource and schedule inventory, honest source coverage, a usage ledger from two supported harnesses, and a read-only Hermes bridge. Preserve native schedule ownership.
2. **Control:** manage newly created sessions, own their resources, route native approvals, and persist recoverable task state. Prove permission and accounting conformance.
3. **Continue:** demonstrate artifact-based handoff between two harnesses and then add OpenCode. Integrate scoped memory retrieval and test corrections and leakage boundaries.
4. **Extend:** add authenticated mobile access, connections to existing native remote execution, measured routing recommendations, and shareable sanitized capsule templates.

Launch evidence should be a complete real workflow. A dashboard screenshot alone cannot demonstrate work continuity, cost accuracy, or lower resource pressure.

## Open-source boundaries

Keep the useful local core, capsule format, and adapter contract open. Default to local data and bring-your-own native accounts. Start without a hosted service requirement. Public examples must use clearly fictional data. A future hosted relay or team edition is a separate product decision, not a dependency of the initial architecture.
