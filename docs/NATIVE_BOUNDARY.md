# Native capability boundary

Forge integrates existing runtimes and harnesses. It does not rebuild capabilities they already provide. This boundary supersedes wording in the initial architecture that implied a Forge-owned editor, browser, terminal, tool execution stack, or general memory engine.

## Responsibility map

| Capability | Implementation owner | Forge's responsibility |
| --- | --- | --- |
| Browser automation and computer use | Selected runtime and its existing tools | Discover, invoke through supported interfaces, show native events, attribute resources and usage |
| Shell commands, terminals, code and file tools | Native harness | Link work to native sessions and artifacts; attach or open existing views where supported |
| Skills, plugins, connectors, model inference | Native runtime or an existing selected provider | Catalog references, verify compatibility, retain bindings, account for reported usage |
| Memory storage, retrieval, embeddings, knowledge graphs | Existing memory provider, runtime, or user-owned source | Retain portable profile and decision references; coordinate scoped access and supported migration |
| Execution permissions, sandboxing, native approval decisions | Native execution boundary | Route exact approval requests, preserve native restrictions, retain decision receipts |
| Native cron, heartbeats, remote nodes, workers | Their current runtime or scheduler | Aggregate state, coordinate supported controls, transfer ownership explicitly where supported |
| Cross-runtime continuity, identity and work history | Forge | Maintain the durable record, checkpoint manifest, native bindings, and reconciliation state |
| Cross-runtime resource and cost visibility | Forge | Normalize native/OS evidence, deduplicate usage, retain provenance, coordinate supported lifecycle controls |

The operator interface can aggregate native work and embed or open an existing surface when supported. That does not require creating a new terminal emulator, browser automation engine, code editor, computer-use agent, skill executor, or provider SDK inside Forge.

## Integration rule

Before adding a component, identify the missing cross-runtime capability and check the selected runtimes' existing APIs, SDKs, protocols, plugins, and tools. Build the smallest adapter or coordination mechanism that closes that gap. If a native capability is missing or incompatible, select another existing provider or show the limitation. Do not quietly introduce a replacement implementation as a fallback.

This reuse rule also applies to existing libraries and open-source projects, including Forge's proposed core features. Before implementation, map each need to existing solutions, their supported versions and licenses, integration fit, and the remaining gap. Adopt or extend a suitable implementation. If an existing product already solves the complete need, use it rather than rebuild it under the Forge name. Proposed architecture boxes are not evidence that those capabilities are missing elsewhere.

The local journal stores Forge's coordination records and references. Search over those records is different from rebuilding a runtime's memory system. Native memory payloads remain at their sources by default; storing or moving selected content needs an explicit supported data policy.

Forge can validate its own dispatch scope and resource ownership. Native tool execution still follows native permissions and host restrictions. A connected MCP server, approval viewer, or telemetry agent does not become a new universal sandbox.

New productive schedules should use an existing selected scheduler where possible. Forge keeps a portable intent reference and one active owner. A minimal cross-runtime admission queue is justified only for coordination that those schedulers do not supply. It does not duplicate an existing scheduled job or replace the runtime's task execution loop.

## Effect on switching

Switching Hermes to OpenClaw, or Claude Code to Codex, resolves required capabilities against the target's existing implementations. Forge keeps identity, work state, references, and history. It does not promise that a native browser session, skill, permission, or tool can be copied unchanged to an incompatible engine. Any required retained source service is explicit and remains resource-accounted.

Current native integrations and their tested boundaries are recorded in [NATIVE_DRIVERS.md](NATIVE_DRIVERS.md), [NATIVE_BACKENDS.md](NATIVE_BACKENDS.md) and [COMPANION_ACCESS.md](COMPANION_ACCESS.md). The remaining architecture remains a requirement, not an implemented capability.
