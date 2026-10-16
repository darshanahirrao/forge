# Native tool conformance

These opt-in checks exercise actual native executables. They supply deterministic model responses through ephemeral loopback HTTP fixtures, use synthetic credentials only, and keep project/configuration/state inside temporary directories. Native tools perform the file write; the fixture server does not write the proof artifact. No model provider subscription, API key or paid endpoint is required.

```sh
npm run test:native
```

The combined command runs sequentially to avoid concurrent native-worker overhead. `test:native:codex` needs Codex on PATH. `test:native:claude` uses the official SDK and its native platform package. These are intentionally separate from `npm test`, which stays independent of an installed Codex executable. Temporary projects and native configuration are removed after each check; no user harness configuration or existing task is changed.

Verified locally on 17 October 2026: Codex CLI 0.159.3; Claude Agent SDK 0.3.301 with native Claude Code 2.1.301. Each passed one native permission request through Forge's HTTP decision endpoint, real tool execution, exact proof-file verification, native usage capture and owned-worker exit. Native model inference is simulated; the result does not prove model quality, live billing, account isolation or cross-harness handoff.

The Claude fixture includes contradictory project API credentials, endpoint and cloud-provider settings. The native host-routing control must keep the selected synthetic route and credential authoritative, and account information is checked before task input is sent. Its provider checks the selected fixture key without recording headers. Nonessential native traffic is disabled in this isolated check. The Codex fixture uses a native custom-provider configuration with authentication disabled and a minimal child environment.

Protocol references: [Claude Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Claude native environment precedence and host routing](https://code.claude.com/docs/en/env-vars), [Codex app-server](https://developers.openai.com/codex/app-server). Fixtures validate the installed version combination; current online documentation alone is not proof of compatibility.

## Cross-harness and profile continuation

`npm run test:native:handoff` runs actual Codex, then native Claude with one API profile, then native Claude with a second profile. It performs two explicit Work Capsule handoffs through the HTTP API. Each destination must receive the unchanged goal, user checkpoint and manifest reference, read the preceding artifact through its native tool, and create the next artifact. The fixture endpoints check their distinct synthetic credentials. The check verifies one work ID, source/parent lineage, source exit receipts, three artifacts and three separate account-attributed usage scopes.

Observed result with the versions above: three native runs, three approvals, three artifacts, all expected context/read observations, zero paid model calls. The providers simulate inference and billing metadata. This does not establish live subscription eligibility, provider quota pooling, model quality, or complete hidden-state migration. The combined native command includes this check after the two individual adapter checks.

## Existing metadata inventory

`npm run test:native:inventory` is a separate explicit opt-in that reads metadata from existing default/environment-selected Codex, Claude and Hermes profiles. It is not included in the synthetic combined native command or CI. The script keeps its Forge cache in memory, prints only aggregate counts and coverage, and compares native schedule-definition hashes before/after. Native session catalogs can contain private titles, which the script does not print. It starts no model turn, executes no job, changes no account/configuration and performs no native repair.

The 17 October 2026 local run observed 89 Codex chats, 25 Claude chats, nine Codex definitions and four Hermes jobs with unchanged schedule-definition hashes. A scheduler can update records concurrently; the comparison reports that possibility rather than rewriting or retrying the native store. Read [native activity coverage](../../docs/NATIVE_ACTIVITY.md) before running it against another installation.
