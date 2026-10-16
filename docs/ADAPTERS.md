# Harness adapter contracts

Research checked 16 October 2026. All Forge adapters are proposed. Upstream support in this table is not a tested Forge integration.

| Harness | Documented integration surface | Forge mapping | Boundary |
| --- | --- | --- | --- |
| Hermes | Native API capabilities, runs, event streams, session controls, run approvals; gateway surfaces where needed | Companion plus execution adapter, scoped tools and memory through MCP | Probe the installed version. An API-owned session cannot simply take over a foreign messaging or CLI session. |
| OpenClaw | Authenticated Gateway WebSocket protocol, session controls, events, and scoped exec-approval operations | Replaceable companion and execution adapter with native capability extensions | Preserve gateway/operator scopes and host approval policy. A tools-invoke endpoint alone is not a full session or authority integration. |
| Codex | App-server JSON-RPC, lifecycle and item events, server approval requests, token usage events | Native adapter with request correlation and session binding | Owning one app-server connection does not establish control of every existing desktop session. WebSocket transport is documented as experimental. |
| Claude Code | Agent SDK sessions, streaming, hooks and permission callbacks, usage results | SDK adapter preserving native session and extension semantics | Earlier permission rules may bypass a callback. Cost fields are estimates, and usage scopes differ. |
| OpenCode | Server API, session operations, permission responses, SSE events, published API specification | Native HTTP/event adapter | Negotiate against the deployed version and confirm usage provenance. API presence does not prove safe arbitrary session adoption. |
| Other harnesses | ACP when supported; otherwise a native adapter | Common session, event, cancellation, and permission operations where advertised | ACP optional capabilities vary. Shell-only wrapping offers weaker control and must be labeled. |

## Shared contract

An adapter advertises its identity, version, protocol, supported operations, control level, usage fields, and applicable scope. Proposed operations are `discover`, `start`, `attach`, `observe`, `interrupt`, `checkpoint`, `continue`, `respond_to_approval`, `read_usage`, and `release`. Unsupported operations return a typed unavailable result.

Native events map to work/attempt IDs without discarding native evidence. Preserve extension payloads under a versioned namespace. The common interface is a coordination contract, not a replacement for every native feature. A model endpoint is not a complete harness integration.

Declare account discovery, effective-identity verification, credential-context isolation, native resume, and quota visibility independently. Each attempt binds a nonsecret account reference and the observed native account scope. The [multi-account contract](ACCOUNTS.md) governs selection and transfer; no universal login or credential-swapping mechanism is assumed.

MCP exposes tools and resources to Hermes or another client. ACP supports agent-client interaction where implemented. Native adapters carry functionality the common protocols do not cover. Neither protocol alone supplies universal cross-harness checkpoints, machine enforcement, or billing truth.

## Usage normalization requirements

Capture the native metric name, scope, source event ID, counter epoch, timestamp, and whether the report is cumulative, incremental, or a revision. Preserve requested and served models separately. Deduplicate overlapping parent and child reports; if scope cannot be established, mark coverage uncertain rather than forcing a total.

Claude's documentation explicitly distinguishes client-estimated cost from authoritative billing. It also describes repeated message IDs and cumulative resumed-session totals. These require adapter-specific accounting. Codex's usage event provides accounting input, not a provider invoice. A standardized telemetry field does not make unknown billing information available.

For Hermes, discover the installed API's capabilities instead of assuming current website endpoints. A read-only installation inspection during this design found capability names and admin support that differ from the latest documentation. This is a compatibility finding, not an instruction to change or upgrade an existing gateway.

## Conformance suite to build

Each adapter needs recorded, sanitized fixtures and real integration checks for cancellation, reconnects, missed events, terminal state, request correlation, parallel tools, nested usage, and stale decisions. Permission tests must cover the actual runtime modes and upstream rule precedence. A capability is production-supported only after those checks pass for a declared version combination.

## Primary documentation

- [Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- [Hermes persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [OpenClaw gateway protocol](https://docs.openclaw.ai/gateway/protocol)
- [OpenClaw session control](https://docs.openclaw.ai/gateway/protocol/rpc-session-control)
- [OpenClaw exec approvals](https://docs.openclaw.ai/tools/exec-approvals)
- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Claude Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Claude Agent SDK usage and cost](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- [OpenCode server](https://opencode.ai/docs/server/)
- [Agent Client Protocol overview](https://agentclientprotocol.com/protocol/v1/overview)
