# Native execution drivers

Checkpoint `forge-v0.2.0`, 17 October 2026. The shared coordinator lives in `server/execution.ts`. Drivers in `server/adapters/` translate native sessions, requests, results and usage without implementing a tool or model loop. Their TypeScript contract is `driver.ts`.

## Codex

Use an existing native sign-in and optional CODEX_HOME reference. Forge retains the app-server policy handshake, same-account session resume and exact supported command/file approvals. Metered or external routes require an explicit launch choice. No new login or credential store is implemented.

## Claude API

Add a Claude account slot with API billing selected. Enter an environment variable name, such as `CLAUDE_STUDIO_KEY`, and set its secret value outside Forge before starting the service. An empty variable-name field defaults to `ANTHROPIC_API_KEY`. The database contains the name only. Multiple API slots can refer to different variables and native configuration directories.

The official `@anthropic-ai/claude-agent-sdk` dependency runs the native CLI, tools, permission rules, hooks, settings and project instructions. It is loaded only on launch; registering account slots starts no workers. The package includes an applicable native executable as an optional platform dependency. Forge does not implement these capabilities.

Launch requires an explicit metered choice. The adapter passes API-key authentication, pins provider/authentication settings with the native host-routing control, clears subscription/cloud bearer-mode overrides for this route, requests manual `default` permission mode, and checks account information on the same worker before releasing any task input. It then checks the native session initialization response. Native project/user rules remain active and may resolve a request before `canUseTool`. A startup hook refuses tool execution until that response is confirmed.

The approval inbox receives the native control `requestId`, tool-use ID, exact tool input, session and attempt. A grant resolves only that callback with its existing input. It creates no persistent permission rule. Native abort signals withdraw prompts. Teardown closes the SDK and waits for the owned child process to exit before releasing the work lease.

Anthropic's [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) requires approval for third-party products offering claude.ai login or rate limits. Forge's SDK route therefore supports API authentication. Native subscription slots remain available for native account inventory and work references; this integration does not proxy subscription execution. Do not remove that gate or silently substitute OAuth. The SDK/native executable retain their own terms and licenses; Forge's MIT license covers Forge's source.

## Usage evidence

Codex replaces cumulative native-thread snapshots. Claude reads cumulative `modelUsage` pipeline counters and `total_cost_usd`, including reported cached/read and cache-creation tokens. These cover the SDK's stated pipeline scope and exclude auxiliary calls outside it. Resumed totals replace the same account/session snapshot. Duplicate result messages are ignored. Unknown native pricing remains unknown.

Daily ccusage imports may cover those same sessions. The overview excludes an imported aggregate when native reports for that harness are present, rather than adding overlapping scopes. Imported evidence remains in private storage. These are reported counters and estimates, not provider invoices, complete lifetime spending, or a proven budget-enforcement boundary. Counter-reset epochs and broader ledger attribution remain delivery gates.

## Verified boundary

The 29 functional/API/driver tests include existing Codex protocol checks, cross-adapter admission, durable lease retention during teardown, mutated input rejection, withdrawn controls, uncertain delivery without replay, Claude permission callbacks, API/metered gates, cumulative usage replacement, unknown pricing, and overlap exclusion. The installed SDK also drives a synthetic executable worker through its real stream-json transport. Five browser flows include API slot setup and launch review without starting a task.

The SDK transport fixture does not execute real tools. Separate opt-in checks now run actual Codex 0.159.3 and the SDK's native Claude Code 2.1.301 against deterministic local providers. Each passed a real native tool, one exact approval through the API, exact artifact verification and native usage capture. The Claude check also supplied conflicting project authentication/routing settings and verified that the selected host route/key prevailed. See [repeatable native conformance](../tests/native/README.md). These checks use zero paid model calls and do not establish real-model quality or account transfer. Real model execution, cross-account isolation and continuation, artifact handoff, runtime replacement, remote approvals, native schedules and resource enforcement remain unverified or unimplemented. Consult [the full completion audit](COMPLETION_AUDIT.md) before claiming the workspace is complete.

## OpenCode v2, forge-v0.6.0

The shared coordinator also supports OpenCode through its installed native server and MIT official client 2.0.6. Native versions 2.0.6 and 2.0.31 pass the real two-profile tool/continuity check. Profile roots, configured agent/model selection, private server identity, native recovery guards, exact one-time requests, temporary policy cleanup, final settlement and usage stay explicit. Provider identity/allowance are not verified. V1 and the older `@opencode-ai/sdk` are not substituted. Read [OpenCode setup and evidence](OPENCODE.md).
