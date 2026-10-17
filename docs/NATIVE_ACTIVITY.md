# Native activity

The v0.13 [T3 Code source](T3_CODE.md) uses native OAuth and a strictly read-only MCP grant. Connect from Activity using a local server address or copied MCP URL, then read bounded project/thread metadata. T3 keeps execution, approvals and schedules. Provider-instance IDs stay separate from harness/account identity. Revocation retains the prior observation; reconnect and disconnect preserve the native owner.

Forge's Activity view keeps native session references and schedule observations together. It reuses installed native interfaces and preserves the existing execution and scheduling owners. Adding a source does not launch an agent, adopt a foreign chat or enable approval controls.

## Connect existing activity

Open Activity and choose **Discover profiles** to register existing default Codex and Claude homes, Codex automation definitions and the active Hermes profile's job store. Discovery checks known locations; it does not read conversations, execute jobs or scan the entire filesystem. Environment-selected homes (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `HERMES_HOME`) take precedence over default user directories. Use **Add source** for another account/profile home, or an already-running local Hermes/OpenClaw API.

Read a source explicitly to collect its metadata. Refresh is on demand, one source at a time. Native inventory reads and managed launches exclude one another through the HTTP admission boundary. Registering more accounts does not create permanent workers. A failed read keeps the previous observation and its original timestamp, with an error visible beside it. Forgetting a source removes Forge's reference and cached observation; native files and services remain unchanged.

Native titles and short summaries can contain private information. They remain in the private local Forge database. Forge drops full transcript fields, schedule prompts, delivery destinations and native system prompts from the saved projection. The demo never reads native homes or APIs. Metadata from different sources can describe the same chat and is presented as separate source observations; counts are not a deduplicated global workload or proof of process ownership.

## Interfaces and coverage

| Source | Reused interface | Observation limit |
| --- | --- | --- |
| Codex chats | Installed `codex app-server`, `thread/list` with `useStateDbOnly: true`, `modelProviders: []`, native update ordering | Up to 100 recent interactive, unarchived chats. Does not load/resume threads or repair rollout metadata. An observer's `notLoaded` status says nothing about another client's worker. Its short owned metadata connection exits after the read. |
| Claude Code chats | Official SDK `listSessions({ limit: 101, includeProgrammatic: true })` in a short metadata process with the selected `CLAUDE_CONFIG_DIR` | First 100 SDK sessions, with a more-available notice when known. No model/query process or execution permission is requested. Native titles/summaries may derive from an initial prompt. |
| Codex schedules | Bounded `automations/*/automation.toml` metadata read using `smol-toml` 1.9.1 | At most 2,000 directory entries and 256 KiB per definition. Empty folders without a definition are ignored. Next run and last result are unknown because this store does not supply them. No native scheduler is duplicated. |
| Hermes schedules | Bounded profile-scoped `cron/jobs.json` metadata read | At most 2 MiB and 2,000 stored jobs. Reads recorded rule/state/next/last/outcome without computing a new schedule. This native file may not include an external cron provider. Stored state does not prove ticker health. An explicit native marker check is separate from this definition read; see [scheduler evidence](SCHEDULER_EVIDENCE.md). |
| Hermes sessions | Existing loopback `/health`, `/v1/capabilities` and `/api/sessions?limit=100&include_children=true` | Requires advertised `session_resources`. Up to 100 records and a native more-available indicator. Does not enable absent job/memory/approval capabilities. |
| OpenClaw sessions | Existing loopback `/tools/invoke` with the fixed native `sessions_list`, `action: json`, `limit: 100`, `messageLimit: 0` | Gateway authentication and its native tool policy remain authoritative. Unsupported/denied output fails the read. No arbitrary tool payload, exec, job tick, session send/spawn, allowlist change or approval bypass is exposed. |

HTTP sources use a bounded response, timeout, no redirects and loopback-only endpoints. A source may reference a `FORGE_…` environment-variable name; the token value is not stored. Set that environment variable before starting Forge. A browser does not receive the secret. Native file reads reject final symlinks, nonregular/oversized files and growth beyond their read budget. Unknown parser/child diagnostics are replaced by a generic error so native excerpts are not persisted as diagnostics.

Hermes's installed job loader can repair its store during an apparent read. Forge deliberately reads only the bounded metadata file and rejects unsupported legacy shapes without invoking that loader. It never ticks, repairs, pauses, resumes or rewrites the native scheduler here.

OpenClaw's gateway tools endpoint can expose powerful operator actions in other contexts. This adapter only sends the fixed metadata request above. It is an observation adapter, not a managed runtime or a universal native approval proxy. See the upstream [tools HTTP interface](https://docs.openclaw.ai/gateway/tools-invoke-http-api), [Hermes API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) and the installed capability response before adding controls.

## Evidence and remaining work

The v0.4 checkpoint passes functional checks for byte-preserving schedules, metadata projection, timestamps, bounds, symlink rejection, source discovery/deduplication, serialized reads, demo/API isolation, persistence, error retention and fixed gateway calls. The browser flow reads synthetic native Codex metadata and schedule fixtures, then verifies reload, search, private-field exclusion, source removal, both themes, accessibility and narrow-screen geometry.

`npm run test:native:inventory` is an explicit opt-in read of existing profile metadata. It reports counts and compares native schedule-definition hashes without printing titles or file contents. The 17 October 2026 local run observed 89 Codex chats, 25 Claude chats, nine Codex definitions and four Hermes jobs; all schedule-definition hashes remained unchanged. These are one installation's metadata counts, not portable performance or global liveness evidence. No model call, job execution, account/configuration change or paid usage was requested.

Native pagination, archived/subagent coverage, foreign-session adoption, native schedule operations, other-provider health, cross-source identity reconciliation and exact native approval routing remain separate integration work. A source connection alone does not make Hermes or OpenClaw replaceable as managed executors. [The completion audit](COMPLETION_AUDIT.md) retains those delivery requirements.


The v0.21 [native scheduler check](SCHEDULER_EVIDENCE.md) reuses Hermes configuration/ticker readers through an isolated native interpreter. It observes marker freshness and preserves unknown/external-provider coverage without calling the job loader, repairing files or starting a tick. Native controls and scheduler ownership transfer remain open.
