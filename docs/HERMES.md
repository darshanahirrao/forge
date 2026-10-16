# Native Hermes execution

Checkpoint `forge-v0.7.0`, 17 October 2026. Forge hosts the installed Hermes ACP implementation through Apache-2.0 `@agentclientprotocol/sdk` 1.9.0. Hermes retains its model loop, tools, skills, memory, native provider routing and session history. The tested native contract is Hermes 0.17.0 with ACP protocol 1. Other versions stop before task input until their compatibility is established.

## Select a native home

Install Hermes and its ACP support through its native setup. `hermes acp --check` checks the native dependencies. Configure the desired provider and model through Hermes first. Use a separate, existing native home per account configuration and finish native setup before referencing it in Forge. Exit other clients using that home before launching work from Forge.

In **Accounts**, select Hermes and enter the absolute native home that Hermes normally receives as `HERMES_HOME`. Choose native or API billing. Forge does not copy credentials from another home, pool subscription limits, or establish provider identity from an ACP connection. A profile check initializes/authenticates the owned native ACP process, then stops it without creating a session or sending a prompt. It confirms the native contract; provider credentials and allowance remain unverified until the native provider acts.

The optional credential field accepts one provider environment-variable name, never a secret value. Set its value outside Forge before starting the service. The worker receives a small system/network environment plus that selected variable. Ambient provider keys, native-home overrides, `PYTHONPATH` and `PYTHONHOME` are excluded. Credentials and native settings in the chosen home stay native. Launch requires explicit consent for external/metered access; subscription-required routing is unavailable.

The installed native launcher supplies the Python interpreter metadata. Forge resolves literal launcher paths without evaluating shell code and preserves the native virtual-environment interpreter path. For other installation layouts, `FORGE_HERMES_PYTHON` can reference an absolute native interpreter with Hermes and ACP installed. The build copies Forge's small reporting adapter alongside the compiled driver; the installed Hermes files are unchanged.

## Owned native lifecycle

Each attempt owns a native ACP child, selected home and session binding. A cooperative SQLite lease in the home excludes another Forge worker using the same home until native child exit. It does not fence arbitrary native clients, detached tools or external systems. Reconcile uncertain effects in the native tools before retrying. No turn or decision is automatically replayed after transport loss.

Before input, Forge verifies protocol/version, configured native authentication, session provenance and the native `default` edit-review mode. It uses native `session/load` for continuation; a missing or mismatched session cannot silently become a fresh conversation. Native history replay stays native and is excluded from Forge's new-result excerpts. Forge advertises no client filesystem or terminal implementation: Hermes uses its own tools. Native ACP's upstream tool surface and native policies apply; this is not a promise that every CLI or gateway feature exists through ACP.

A native permission-mode change during an attempt closes the connection. A native `session/cancel` request asks Hermes to stop; Forge also closes its owned process and retains managed capacity until exit. This is not universal fencing of detached native tools or remote external effects.

## Exact permission reviews

The native JSON-RPC request ID, tool-call ID, session and Forge work/run generation bind each review. The displayed JSON contains the exact native input. Only a unique `allow_once` and `reject_once` option are accepted. Forge sends the actual option ID supplied by Hermes, never an `allow_always` or session-wide grant. Foreign sessions, duplicate/ambiguous options, unreviewable inputs, changed pending payloads and withdrawn requests receive no replacement grant.

Reviews expire after at most 55 seconds, below the tested native callback's 60-second wait. The shared inbox honors the earlier native deadline. Native cancellation, changed tool state, turn completion or connection loss withdraw pending reviews. Native command policies can resolve actions without an inbox request; the native default mode does not turn Forge into a separate host sandbox. The legacy Hermes HTTP approval endpoint is not forwarded because the inspected installed contract lacks exact request identity.

## Native outcome, memory and accounting

The tested native ACP server can return `end_turn` after a provider failure. Forge therefore uses a small process-local reporting adapter around the unchanged native `run_conversation` result. It exposes only whitelisted outcome flags, native token counters and native cost status over ACP metadata. Explicit early native failures and native exceptions remain failures even when ACP returns `end_turn`. Missing evidence remains interrupted/unknown. It does not parse success text, reproduce the loop, expose raw exceptions, or make task acceptance equivalent to native turn completion. The adapter uses private native seams and must be revalidated when Hermes changes.

Native `memory` writes remain in the selected Hermes home. Hermes deliberately preserves a resumed session's stored system prompt for prefix caching; a fresh native session loads current native memory. To carry learned facts to another home or harness, explicitly register and pin the relevant native Markdown reference in the persistent Forge profile, review the prepared input, and hand off at a verified checkpoint. Native memory is not silently copied between account homes. Full provider/search migration and runtime-to-workspace orchestration remain open.

Token counters reset when the tested native agent is constructed, so each owned worker has a distinct run usage key. ACP `usage_update` is context pressure and is excluded from billable-token accounting. Unknown native cost is null, not free. Native dollar estimates are not invoices. Early failures can omit usage; Forge does not invent zero counters for them.

## Evidence and remaining scope

`npm run test:native:hermes` uses the actual installed 0.17.0 implementation, two isolated native homes and distinct synthetic credentials, with inference restricted to loopback providers. It checks three real native file writes and exact one-time HTTP reviews, native artifact reads, same-session history resume, native memory-tool persistence, memory loading in a fresh native session, selected-memory handoff to the second home, three run usage scopes and native process exits. An additional rejected-credential run verifies native failure reporting. Five native runs occur in total; no paid provider or private credential is used.

The five-worker cross-harness chain continues Codex to two Claude API profiles, OpenCode, then Hermes. One Forge work/profile, reviewed memory, goal/checkpoint, five real artifacts, six approvals and five account usage scopes survive. Unit checks use the official ACP SDK for cancellation, exact native option IDs, payload/mode changes, version/auth/provenance gates, outcome handling, usage separation and startup/exit ownership. Browser checks cover account setup and launch consent on desktop and mobile in both themes.

Managed OpenClaw, authenticated phone approval transport, companion planning/control across Forge work, live provider/quota isolation, native schedule operations, general extensions and full resource/external-effect fencing remain in the [completion audit](COMPLETION_AUDIT.md). An OpenClaw ACP bridge can outlive or disconnect from a gateway run; bridge exit alone is insufficient ownership evidence.

Primary interfaces: [Hermes ACP](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp), [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [OpenClaw ACP](https://docs.openclaw.ai/cli/acp). Installed source and actual native behavior determine this adapter's support.
