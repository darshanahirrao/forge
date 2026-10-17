# T3 Code activity connection

Forge v0.13 reads activity from an existing local T3 Code server through its authenticated MCP interface. T3 keeps its projects, threads, execution, account instances, tools, approvals and schedules. Forge stores bounded observations beside its other native sources. This is the first implemented gate in the [foundation review](T3_CODE_REVIEW.md); full adoption remains unproven.

Execution uses a separate, explicitly paired [native backend](NATIVE_BACKENDS.md). The read-only activity scope described here is unchanged.

## Connect

1. Use an existing running T3 server on the Forge host. T3's [installation guide](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/docs/user/install.md) describes native setup if you choose to install it separately.
2. In Forge, open **Activity**, **Add source**, then **T3 Code workspace**. Paste the local server address or copied `/mcp` URL and give the source a label.
3. Choose **Sign in to T3 Code**, then **Read only** on T3's own approval page. This native grant covers all projects; it is not project-specific. Forge rejects execution grants.
4. Back in Activity, choose **Read** on that source. **Open T3 Code** leads to its native client for continuing work and reviewing approvals.

The connection currently accepts loopback HTTP/HTTPS only. Complete sign-in on the Forge host. Paired phones can view saved observations, but cannot initiate this host-local OAuth flow. Hosted MCP URLs and remote T3 environments remain unintegrated. Forge never installs or starts T3 when connecting or refreshing.

## Coverage

| Data                                 | Current behavior                                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects                             | One native page, at most 20, with an observed project count.                                                                                          |
| Threads                              | At most 100 across those projects. Native pagination or omitted projects sets partial coverage. This is not a globally complete recent-history query. |
| Fields                               | Native thread ID, bounded title/project name, workspace path, reported status, update time and provider-instance ID.                                  |
| Provider instance                    | Stored separately from the harness label. An instance ID does not verify an account, model entitlement or billing identity.                           |
| Process ownership                    | Native status is an observation. It grants no permission to signal or adopt a worker.                                                                 |
| Transcripts, approvals and schedules | Not imported. Schedules are explicitly marked unread.                                                                                                 |
| Usage and quotas                     | Not imported. No cost or capacity is inferred from metadata.                                                                                          |

Reads are explicit and serialized with other native inventories. Workspace polling reads saved data. Each read uses fixed `t3_project_list` and `t3_thread_list` calls, then requests termination of its own MCP transport session. Native agent threads are separate and remain with T3. No generic tool proxy, transcript/database parser, scheduler or background collector is added.

A failed read retains the previous successful observation and timestamp. **Reconnect** preserves the source ID and starts a fresh sign-in. Starting another sign-in invalidates an unfinished flow; callbacks expire after ten minutes and token exchange is consumed once. A completing exchange must settle before source removal.

## Authentication and recovery

The official MIT `@modelcontextprotocol/sdk` 1.32.1 supplies discovery, registration, OAuth/PKCE and MCP framing. Forge binds state and issuer, accepts exactly the read-only scope, checks the declared native identity/read tools, confines requests to the chosen origin and bounds response size/time. SDK client modules load on demand.

Tokens persist in `.forge-t3-<source-id>.json` beside the private workspace database, outside snapshots and blueprint exports. Writes are atomic/private. Unix reads check owner, mode, regular-file type, symlinks and size. Windows relies on user-data ACLs and has not received this native run. The credential files and temporary writes are ignored by Git. In-memory tests retain credentials only in process memory.

Disconnect removes Forge's reference, observations and local credential. Revoke the upstream grant separately in **T3 Code Settings, Connections**. Forge does not reuse an application-admin token to cross the MCP audience or modify access settings. Missing/expired credentials require reconnecting; a database-only backup does not contain the separate credential file. No native provider credential or account is moved by this connection.

## Validation

Eleven functional checks use the real SDK against deterministic HTTP OAuth/MCP fixtures, covering permission rejection, PKCE, state/issuer binding, restart persistence, origin confinement, private credentials, pagination, response bounds, revocation and retained observations. The browser flow covers copied MCP URLs, native sign-in, provider-instance display, reconnect/disconnect, both themes, mobile geometry and axe accessibility.

The separate opt-in check runs an existing native CLI with temporary homes/data, a synthetic project, no supplied provider keys and telemetry disabled:

```sh
FORGE_T3_BINARY=/absolute/path/to/t3 npm run test:native:t3
```

The 17 October 2026 run used official macOS arm64 T3 **v0.1.0**, source `81493efb71e8e8244f95d3e9f71d8369654ab151`, verified asset SHA-256 `bb54ae6576b78f327afa1a5cc3ca03c4f8635f8ceccfc70a907f737c0dbea9f0`. Native OAuth/PKCE, read-only write rejection, project registration through T3's own CLI, project/empty-thread metadata, grant revocation, observation retention, local credential removal and graceful root/observed-collector exit pass. No model task was submitted. Populated thread normalization uses inspected native schemas and fixtures; live provider accounts remain unverified.

A six-sample headless trace observed approximately 313 to 318 MiB RSS for the native server root and direct children. It included no UI or productive agent and is not a steady-state, full-descendant or whole-stack comparison. The trace does not justify adding another permanent local control plane. Exact samples remain in the ignored native report.

This native check is separate from default multi-harness conformance and Linux CI. No actual user T3 installation, startup item, account, project or phone route was changed. The existing private Forge workspace retains its references and foreground operation.

## Next gate

Continue the [full comparison](T3_CODE_REVIEW.md) with artifact-producing account/harness continuation, native approval correlation, recovery, Hermes outcomes/memory, OpenClaw ownership and comparable resource traces. Reuse T3's existing capabilities where those requirements pass, with one execution owner.

Primary contracts: [outside agents](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/docs/user/outside-agents.md), [environment auth](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/docs/internals/environment-auth.md), [orchestrator MCP](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/docs/orchestration-v2/orchestrator-mcp-server.md), [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk). T3 remains an external MIT product; Forge redistributes no T3 control-plane source or binary.
