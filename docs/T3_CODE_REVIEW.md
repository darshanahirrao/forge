# T3 Code reuse decision

Implementation update: v0.13 adds a [read-only native T3 connection](T3_CODE.md) and stable-release OAuth, metadata, mutation-denial and revocation checks. The source-review boundary below describes checkpoint `456ad84`; later runtime evidence is recorded separately. The first MCP observation gate passes. Full foundation adoption, account/companion continuity and whole-stack fit remain unproven.

Reviewed 17 October 2026 at upstream commit `02d48aec5c75e6abb90d06fd2c63939a82bd3718` in [pingdotgg/t3code][upstream]. This is a source and interface review, not a runtime benchmark or an integration release.

## Decision

Evaluate T3 Code first as the existing execution and control foundation for Forge. Its overlap includes harness adapters, account instances, portable continuation, usage, remote clients, background operation and resource diagnostics. Those capabilities are existing work, not a new Forge contribution. Another implementation of them needs a demonstrated integration gap.

Keep the current v0.12 Forge runtime and its native conformance evidence recoverable while testing that choice. The next implementation gate is an isolated comparison of T3 with Forge's actual requirements, before expanding duplicate account, mobile, orchestration or provider infrastructure. Adoption is not yet established. Do not permanently stack both control planes or move private work simply because this source review looks promising.

Prefer T3's existing supported interfaces first. If they satisfy the requirements, use T3 as the execution owner and build only the remaining Forge continuity, memory and policy functions. If a necessary change requires a fork, evaluate a small maintained patch before choosing a separate implementation. A fork and a runtime dependency have different upgrade costs; neither choice has been made here.

## License and evaluation boundary

The pinned [LICENSE][license] is MIT, copyright 2026 T3 Tools Inc. Retain the upstream copyright and permission notice in any distributed copies or substantial portions. Inspect relevant dependency licenses before packaging an adopted component. The inspected `@t3tools/provider-core` package is private, imports other workspace packages and exposes TypeScript source; it is not established as a separately supported, published SDK.

This review used an ignored sparse source checkout. No dependencies, installer, T3 server, provider process, account login, startup service or relay were started. No T3 code was copied into Forge. No private configuration was connected or changed.

## What already exists

| Forge requirement                                     | Inspected T3 evidence                                                                                                                                                                 | Consequence for Forge                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One control surface for multiple harnesses            | [Repository][upstream], [provider boundary][providers] and [adding a provider][adding]                                                                                                | Evaluate the whole product before building more provider-specific surfaces.                                                                                                          |
| Multiple accounts without conflating sessions         | Driver kinds are separate from account/configuration instances; see [provider constraints][providers]                                                                                 | Route by verified instance and compatibility, not just harness name.                                                                                                                 |
| Compatible account continuation                       | [Codex guide][codex] supports a shared session home with separate shadow authentication; [Claude guide][claude] restricts native thread switching to the same configuration directory | Same-harness account switching is conditional. Separate Claude account directories do not become lossless continuation automatically.                                                |
| Reliable command processing                           | [Architecture][architecture] and [EventSink][event-sink] commit events, projections, command receipts and outbox work transactionally, then publish                                   | Reuse this boundary where possible. An accepted command is durable intent, not proof that its external action completed.                                                             |
| Harness replacement within ongoing work               | [Context handoffs][handoffs] and [handoff source][handoff-source] use portable textual summaries                                                                                      | Preserve explicit context coverage. Text-bearing eligible items are compacted to at most 240 characters each; native tool/session state is not reconstructed.                        |
| Companion-driven coordination                         | [Outside-agent access][outside-agents], [environment authentication][auth] and [orchestrator MCP][mcp]                                                                                | A companion supporting HTTP MCP and OAuth can potentially use the existing orchestration boundary. Start the proof with a read-only grant.                                           |
| User approvals and questions                          | [Provider constraints][providers] preserve native option IDs; [orchestrator MCP][mcp] distinguishes child questions from approvals                                                    | Keep native human approval authority. Do not turn companion orchestration access into an agent that approves its own tools.                                                          |
| Token, dollar and quota visibility                    | [Usage guide][usage] combines native histories, distinguishes estimates from subscription bills and avoids counting a shared history directory twice                                  | Evaluate its usage surface and data contract before adding another set of native parsers. Per-work budget enforcement still needs its own evidence.                                  |
| Background and phone operation                        | [Background service][service] and [remote access][remote] describe native user services, pairing, T3 Connect and private-network routes                                               | Reuse supported deployment and remote surfaces if the isolated proof passes. The host still needs to be available.                                                                   |
| Resource visibility without expensive idle collection | [Resource telemetry][resources] uses an isolated native collector, demand-driven sampling and bounded history                                                                         | Compare collection overhead and ownership coverage before replacing Forge's existing monitor or adding another collector.                                                            |
| A moldable provider boundary                          | [Provider guide][adding] supports generic ACP integrations, capability declarations and native adapters; [local ACP commands][acp] need no registry download                          | Test Hermes through the existing local-command path before considering another T3-specific driver. Source-level registration is not evidence of a general third-party plugin loader. |

## Limits that matter for this workspace

T3's compatible Codex account path is not arbitrary cross-home migration. Its documented Claude native switching keeps one configuration directory. Portable cross-provider handoff explicitly omits native session state and parts of the recorded history. None of these observations establishes automatic quota fallback, permission to pool a subscription, or an effective identity match with a live provider. Forge's existing authentication boundaries remain in force.

T3's external MCP authorization is a separate audience from its application RPC. Read-only grants expose orchestration reads; stronger grants impose a runtime-mode ceiling. The documented external grant can reach every project, so it must not be described as project-scoped authorization. Never reuse an application token, assume an MCP token can call arbitrary RPC methods, or bypass the native human approval surface.

Hermes as a T3 ACP worker and Hermes as an always-on companion are separate proofs. The installed Hermes ACP version previously returned `end_turn` even after provider failure; the Forge native outcome check must remain an acceptance case. A generic ACP connection alone does not prove correct outcome, memory behavior or cleanup. OpenClaw's managed foreground Gateway and its existing companion channels/schedules also have separate ownership. Neither replacement path was run in T3 during this review.

T3 already documents resource diagnostics. That is not evidence of whole-stack performance on this laptop, continuous memory admission, a hard limit, or safe cleanup of another application's processes. Its collector samples only on demand without diagnostics subscribers; retained history is bounded by age, count, rows and bytes. Compare that behavior with actual Forge traces before choosing a collector.

This review does not prove that memory-provider portability, native schedule aggregation, outcome budgets or general recovery are missing from T3. Those are unverified fit questions. Inspect and test the corresponding product paths before building a supposed gap.

## Next implementation gate

Use a pinned T3 build, a temporary home and synthetic project with no access to private provider or memory directories. Preserve the v0.12 Forge checkpoint. Reuse the existing deterministic loopback/native conformance cases where compatible; do not equate transcript fixtures with a successful live native run.

1. Establish external MCP read-only authentication and inventory. Verify mutation denial, revocation and reconnect behavior. Inspect the supported RPC/usage interface only if MCP lacks required read coverage. Do not add a private SQLite parser as a shortcut.
2. Continue one artifact-producing work item across compatible account instances and harnesses. Verify the preceding file, selected profile/memory, context omissions, effective account and usage baseline. Require source-worker settlement and no duplicate writer. Test incompatible homes as explicit failures.
3. Exercise a pending native approval through client disconnect, expiry, changed payload, cancellation and restart. Verify exact native option/request correlation. A recorded decision or outbox receipt must not replay an uncertain tool execution.
4. Run Hermes through a local ACP command with isolated native memory. Check success, rejected provider credentials, memory writes/fresh-session reads and actual process exit. Evaluate a companion-to-MCP connection separately. Check OpenClaw's public Gateway contract before treating it as an ACP substitute.
5. Compare the same project under Forge, T3 alone, and only then the minimum proposed integration. Record versions, hardware, complete process trees, idle and active RSS/CPU, process-table sampling, recovery and UI-open/UI-closed traces. Report the native workers separately and in the total; do not claim low overhead from framework choice.
6. Inspect existing native schedule, usage, recovery and extension capabilities against [COMPLETION_AUDIT.md](COMPLETION_AUDIT.md). Choose a single execution and scheduler owner. If T3 becomes the execution owner, Forge controls must call its supported boundary and retain external references, rather than also launching or killing the same native worker.

Publish the measured result as an adoption decision: use the existing product directly, extend it with a small Forge layer, maintain a focused fork, or keep a separate runtime with the failed requirements documented. Do not infer completion or increase the engineering completion estimate from the review alone.

[upstream]: https://github.com/pingdotgg/t3code/tree/02d48aec5c75e6abb90d06fd2c63939a82bd3718
[license]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/LICENSE
[architecture]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/internals/overview.md
[providers]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/internals/providers.md
[adding]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/internals/adding-a-provider.md
[codex]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/user/providers-codex.md
[claude]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/user/providers-claude.md
[event-sink]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/apps/server/src/orchestration-v2/EventSink.ts
[handoffs]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/internals/context-handoffs.md
[handoff-source]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/apps/server/src/orchestration-v2/ContextHandoffService.ts
[outside-agents]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/user/outside-agents.md
[auth]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/internals/environment-auth.md
[mcp]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/orchestration-v2/orchestrator-mcp-server.md
[usage]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/user/usage.md
[service]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/user/background-service.md
[remote]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/user/remote-access.md
[resources]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/internals/resource-telemetry.md
[acp]: https://github.com/pingdotgg/t3code/blob/02d48aec5c75e6abb90d06fd2c63939a82bd3718/docs/user/providers-acp.md
