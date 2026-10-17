# Native tool conformance

`npm run test:native:t3` separately exercises an existing native T3 CLI with `FORGE_T3_BINARY=/absolute/path/to/t3`. It checks actual OAuth/PKCE, read-only write rejection, native CLI project metadata, revocation, observation retention and root/collector exit. It submits no model task and uses temporary homes/data. The tested macOS arm64 release is v0.1.0; see [T3 evidence and limits](../../docs/T3_CODE.md). This opt-in check is separate from the combined command and Linux CI, and does not use the inference fixtures below.

These opt-in checks exercise actual native executables. They supply deterministic model responses through ephemeral loopback HTTP fixtures, use synthetic credentials only, and keep project/configuration/state inside temporary directories. Native tools perform the file write; the fixture server does not write the proof artifact. No model provider subscription, API key or paid endpoint is required.

```sh
npm run test:native
```

`test:native:hermes` requires native Hermes 0.17.0 with ACP support; `test:native:opencode` requires OpenCode v2 on PATH. The combined command runs sequentially to avoid concurrent native-worker overhead. `test:native:codex` needs Codex on PATH. `test:native:claude` uses the official SDK and its native platform package. These are intentionally separate from `npm test`, which stays independent of an installed Codex executable. Temporary projects and native configuration are removed after each check; no user harness configuration or existing task is changed.

Verified locally on 17 October 2026: Codex CLI 0.159.3; Claude Agent SDK 0.3.301 with native Claude Code 2.1.301. Each passed one native permission request through Forge's HTTP decision endpoint, real tool execution, exact proof-file verification, native usage capture and owned-worker exit. Native model inference is simulated; the result does not prove model quality, live billing, account isolation or cross-harness handoff.

The Claude fixture includes contradictory project API credentials, endpoint and cloud-provider settings. The native host-routing control must keep the selected synthetic route and credential authoritative, and account information is checked before task input is sent. Its provider checks the selected fixture key without recording headers. Nonessential native traffic is disabled in this isolated check. The Codex fixture uses a native custom-provider configuration with authentication disabled and a minimal child environment.

Protocol references: [Claude Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Claude native environment precedence and host routing](https://code.claude.com/docs/en/env-vars), [Codex app-server](https://developers.openai.com/codex/app-server). Fixtures validate the installed version combination; current online documentation alone is not proof of compatibility.

## Cross-harness and profile continuation

`npm run test:native:handoff` runs actual Codex, then native Claude with one API profile, then native Claude with a second profile, then OpenCode v2, Hermes ACP and OpenClaw Gateway. It performs five explicit Work Capsule handoffs through the HTTP API. Each destination must receive the unchanged goal, user checkpoint and manifest reference, read the preceding artifact through its native tool, and create the next artifact. The fixture endpoints check their distinct synthetic credentials. The check verifies one work ID, source/parent lineage, source exit receipts, six artifacts, six separate account-attributed usage scopes and six live OS-checked native worker roots. Resource attribution is checked while each native approval is pending; it neither grants approval nor confirms shutdown.

Observed result with the versions above: six native runs, seven approvals, six artifacts, all expected context/read observations, zero paid model calls. The providers simulate inference and billing metadata. This does not establish live subscription eligibility, provider quota pooling, model quality, or complete hidden-state migration. The combined native command includes this check after the individual adapter checks.

The v0.5 chain also pins a selected native Markdown section to one persistent profile. Codex and both Claude inputs must contain that fact and profile ID while excluding an unselected section. Capsules carry its prepared context receipt. Source text is synthetic and outside the project; no private user memory or paid inference is used. This verifies selected-input portability, not native memory-engine replacement or universal filesystem isolation.

## Existing metadata inventory

`npm run test:native:inventory` is a separate explicit opt-in that reads metadata from existing default/environment-selected Codex, Claude and Hermes profiles. It is not included in the synthetic combined native command or CI. The script keeps its Forge cache in memory, prints only aggregate counts and coverage, and compares native schedule-definition hashes before/after. Native session catalogs can contain private titles, which the script does not print. It starts no model turn, executes no job, changes no account/configuration and performs no native repair.

The 17 October 2026 local run observed 89 Codex chats, 25 Claude chats, nine Codex definitions and four Hermes jobs with unchanged schedule-definition hashes. A scheduler can update records concurrently; the comparison reports that possibility rather than rewriting or retrying the native store. Read [native activity coverage](../../docs/NATIVE_ACTIVITY.md) before running it against another installation.

## OpenCode v2 profiles

`npm run test:native:opencode` runs two actual OpenCode servers with dedicated temporary profile roots, distinct selected credential variables and a loopback chat provider. Native tools write three artifacts and read the preceding artifacts after an explicit account handoff and a same-native-session resume. One work/profile, selected memory, five native approvals, two cumulative usage scopes and native exits are verified. Native 2.0.6 and 2.0.31 passed locally. The native recovery guard is also applied to the real completed profile. `FORGE_OPENCODE_CONFORMANCE_BINARY` is an optional test-only executable path used for version comparison; it does not change the production native selector or user installation. See [adapter setup and lifecycle](../../docs/OPENCODE.md).

## Hermes ACP and native memory

`npm run test:native:hermes` runs native Hermes 0.17.0 with two isolated homes, exact native one-time reviews, native file/memory tools, same-session history resume, selected learned-memory handoff, a fresh-session native memory check and explicit provider-failure reporting. Five native workers run; the continuity work retains three artifacts, three approvals and three run usage scopes. The isolated project is created under the ignored repository `artifacts/` directory because native Hermes denies the macOS `/private` temporary path. No native policy is disabled to bypass that guard. Homes/projects are removed after the check. See [the versioned native contract](../../docs/HERMES.md).

## Private-gateway native decision

The Codex native check now routes its exact one-time decision through the maintained private gateway using a controlled native-Serve-header fixture. Anonymous review is denied before the artifact exists; the selected identity is recorded and the native tool then produces the verified file. This proves the actual local gateway/native-decision path with zero paid inference. It does not establish actual Tailscale/phone compatibility; see [phone evidence](../../docs/PHONE_ACCESS.md).

## OpenClaw Gateway and cancellation

`npm run test:native:openclaw` requires installed OpenClaw 2026.10.4 and native Node 24.16+ or 26.1+. Set absolute `FORGE_OPENCLAW_BINARY` and `FORGE_OPENCLAW_NODE` overrides when the native executable/runtime is outside PATH or differs from Forge’s Node. The full combined native command now requires this runtime too and stays sequential. [Setup and lifecycle](../../docs/OPENCLAW.md) explain the dedicated native profile role.

The standalone check owns five actual foreground Gateways across two synthetic native profiles: three real files and command approvals, native reads of preceding files, saved native UUID/key resume, selected-memory/profile handoff, exact per-run usage, explicit provider failure and cancellation of a held command without producing its artifact. The cross-harness check continues actual Hermes work in native OpenClaw with the same work/profile, selected fact, goal/checkpoint and verified prior artifact. No real provider key or paid inference is used. Inference conformance does not establish always-on companion control, arbitrary plugin/descendant reviews or live account/quota isolation.

## macOS background workspace

`npm run test:native:service` is a separate macOS-only opt-in against actual launchd and the compiled application. It installs an isolated private definition outside login auto-load, starts Forge, retains idle work through graceful and abnormal-exit restarts, removes its native job and preserves state before temporary cleanup. It starts no harness task and uses no model or provider credentials. Unconfirmed cleanup leaves the fixture for review. It is not included in the combined model-tool command or Linux CI. [Service setup and boundaries](../../docs/BACKGROUND_SERVICE.md) distinguish this evidence from real login/logout, managed work during OS shutdown and background API-key/phone delivery.

## Native memory pressure query

`npm run test:native:pressure` reads actual macOS pressure and exercises loopback launch admission with an inert driver. On the evaluated host, native warning flag 2 held the launch before factory creation. No pressure is injected, no native harness starts, and no model or provider key is used. Normal host pressure admits only the inert fixture; the report states whether an actual elevated hold was observed. [Resource evidence and limits](../../docs/RESOURCES.md) describe the masked optional OS ABI, unknown coverage and absence of hard limits.

Other protocol/browser/native-tool fixtures now explicitly inject unavailable pressure coverage. Their native tool, ownership, permission and continuation checks are independent of changing test-host load; they do not validate the pressure guard. The separate native query and functional admission/race checks cover that boundary.

## T3 native execution backend

Use `FORGE_T3_BINARY=/absolute/native/t3 npm run test:native:t3-execution`. It requires an existing protocol-2 T3 CLI and Codex binary, creates isolated native homes, and uses a synthetic loopback inference provider. The production API pairs with read/operate scope, imports provider models, approves two exact native requests and verifies two artifacts and distinct synthetic credentials across two instances in the same work. Native context coverage and native root/observed descendant teardown are checked. No paid model calls or private provider credentials are used.

Tested with official T3 v0.1.0 and Codex 0.159.3. Account switching currently yields a native `full_thread_summary` fallback after an active-writer resume rejection, also observed with T3's pinned Codex 0.156.1. `FORGE_T3_CODEX_BINARY` selects another binary; `FORGE_T3_REQUIRE_NATIVE_RESUME=1` makes that strict history-preservation gate mandatory and currently failing. See [native backend evidence and boundaries](../../docs/NATIVE_BACKENDS.md).
