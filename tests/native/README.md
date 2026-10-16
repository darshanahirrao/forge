# Native tool conformance

These opt-in checks exercise actual native executables. They supply deterministic model responses through ephemeral loopback HTTP fixtures, use synthetic credentials only, and keep project/configuration/state inside temporary directories. Native tools perform the file write; the fixture server does not write the proof artifact. No model provider subscription, API key or paid endpoint is required.

```sh
npm run test:native
```

The combined command runs sequentially to avoid concurrent native-worker overhead. `test:native:codex` needs Codex on PATH. `test:native:claude` uses the official SDK and its native platform package. These are intentionally separate from `npm test`, which stays independent of an installed Codex executable. Temporary projects and native configuration are removed after each check; no user harness configuration or existing task is changed.

Verified locally on 17 October 2026: Codex CLI 0.159.3; Claude Agent SDK 0.3.301 with native Claude Code 2.1.301. Each passed one native permission request through Forge's HTTP decision endpoint, real tool execution, exact proof-file verification, native usage capture and owned-worker exit. Native model inference is simulated; the result does not prove model quality, live billing, account isolation or cross-harness handoff.

The Claude fixture includes contradictory project API credentials, endpoint and cloud-provider settings. The native host-routing control must keep the selected synthetic route and credential authoritative, and account information is checked before task input is sent. Its provider checks the selected fixture key without recording headers. Nonessential native traffic is disabled in this isolated check. The Codex fixture uses a native custom-provider configuration with authentication disabled and a minimal child environment.

Protocol references: [Claude Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Claude native environment precedence and host routing](https://code.claude.com/docs/en/env-vars), [Codex app-server](https://developers.openai.com/codex/app-server). Fixtures validate the installed version combination; current online documentation alone is not proof of compatibility.
