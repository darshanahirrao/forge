# Dynamic component architecture

Forge owns the durable workspace. Every execution or service backend is selected through a versioned capability contract. The user can replace Hermes itself, including with OpenClaw. The design must not place the canonical identity, policy, or task journal exclusively inside either runtime.

Bindings point to existing implementations. Forge does not rebuild the browser/computer-use stack, terminal execution, file tools, skills runtime, native memory engine, or scheduler. See [NATIVE_BOUNDARY.md](NATIVE_BOUNDARY.md).

## Selectable roles

| Role | Example bindings | State Forge retains |
| --- | --- | --- |
| Agent runtime / companion | Hermes, OpenClaw, another compatible implementation | Agent ID, authored profile, memory references, goals, work history |
| Coding or task harness | Codex, Claude Code, OpenCode, general runtime | Work IDs, artifact evidence, checkpoints, attempt lineage |
| Model route | Native default, supported provider/model selection | Requested and served model records, usage, route policy |
| Memory provider | Local index, user-owned files, optional external backend | Source and schema references, scope, provenance, correction and export policy |
| Tools and skills | Existing runtime tools, MCP services, native skills and plugins | Versioned references, required capabilities, granted scope |
| Channels | Workspace UI, paired phone, runtime messaging gateways | User identity bindings, delivery policy, action correlations |
| Execution host | Runtime's local execution, existing remote node/container/VM | Native host references, artifact references, resource and authority leases |

These are roles rather than a mandatory chain of frameworks. One runtime may serve conversation and execution. A coding harness can execute directly. Selecting one role should not start every installed component or copy every private source into it.

## Replacement transaction

Each binding records component identity, version, capabilities, account reference, host, control level, data contract, and lifecycle. A replacement goes through compatibility discovery, a prepared checkpoint where needed, validation, authority transfer, and activation. Keep the old binding recoverable for explicit rollback without reactivating stale execution authority.

Some stateless changes, such as choosing an available display surface, can apply immediately. A runtime or harness change waits for a safe boundary. A memory backend change needs a verified data export/import with provenance and scope. A host change requires accessible artifacts and credentials provisioned for that host. Unknown external effects block automatic continuation.

Schedules use an existing selected native scheduler, with Forge retaining intent and owner references. Imported schedules keep their original owner until a supported transfer exports the required definition, disables the old owner, verifies that state, and activates the replacement. A runtime cannot be removed while it still owns required schedules, memory payloads, or tools unless those dependencies are migrated or explicitly kept as connected services. Forge adds admission coordination only where a cross-runtime gap requires it.

Pending native approval history stays in Forge, but an old decision cannot authorize a different runtime's new request. Revalidate the action against the new binding and native rules. Retain user-authored policy and re-evaluate it; do not silently broaden a grant to compensate for a missing capability.

## Portability contract

The portable profile and work state have independent versions. Native sessions and runtime-owned caches are references, not the portable source of truth. Adapter-specific event payloads and extensions remain available for diagnosis and richer features. When native semantics cannot be reproduced, declare the limit instead of translating it into a misleading success.

Treat the registry as a set of pinned, permission-scoped components. Heavy adapters load on demand. Out-of-process plugins have explicit lifetime and resource ownership. Plugin code does not gain permission to modify the journal, release credentials, or override policy merely by being installed.

The guarantee to validate is continuity of Forge-owned state across compatible replacements. Equivalent personality, reasoning, tools, authorization, or output quality cannot be assumed from that state alone. Publish conformance evidence for each supported combination.

## First proof

Demonstrate both axes independently: Hermes to OpenClaw for the companion role while retaining the same profile and memory references; Claude Code to Codex for an artifact task while retaining its work record. Then test the combined change with faults and native permission differences. No part of this proof has been implemented yet.
