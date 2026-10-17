# Initial reuse audit

Runtime update: the v0.13 [T3 connection](T3_CODE.md) reuses native MCP/OAuth with official MIT MCP SDK 1.32.1. It observes projects/threads, retains native ownership and starts no T3 process in production. Actual stable v0.1.0 authentication, native read-only write rejection, project CLI metadata, revocation and root/collector exit pass in an isolated synthetic installation. No upstream control-plane source was copied. Whole-product adoption remains gated by the [full comparison](T3_CODE_REVIEW.md), including a defined whole-stack benchmark.

Reviewed 16 October 2026 from primary project documentation and GitHub metadata. This is an initial candidate map, not an integration decision or exhaustive market review. No candidate was installed, executed, benchmarked, or connected to private user data.

Update, 17 October 2026: the user added T3 Code as a reference. Its pinned source and license review is recorded in [T3_CODE_REVIEW.md](T3_CODE_REVIEW.md). T3 is now the first whole-product foundation to evaluate before extending overlapping Forge infrastructure. This later review checked source in an isolated sparse checkout; it did not execute T3 or change the current runtime.

Several functions previously proposed for Forge are already available in existing products. The next step is to assess whether one existing foundation can meet the whole need, and then identify a small, verified gap. Avoid adding several overlapping control planes to a resource-constrained laptop.

## Candidate evidence

| Candidate                                                 | Existing capability documented upstream                                                                                                                                   | License at review                     | Evaluation direction                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Agent Deck](https://github.com/asheshgoplani/agent-deck) | Multi-agent session status, worktrees, configuration, cost views, phone-connected conductor, MCP pooling, and Claude account slots with transcript migration/resume       | MIT                                   | Evaluate as a session/control and account-management foundation, including overhead, ownership, and protocol coverage. Do not rebuild those features before testing fit. |
| [CC Switch](https://github.com/farion1231/cc-switch)      | Provider configuration across multiple tools, MCP/skill/prompt management, and usage/quota views                                                                          | MIT                                   | Evaluate configuration and usage reuse. Switching an API provider does not establish full runtime/task migration.                                                        |
| [ccusage](https://ccusage.com/guide/)                     | Local token and estimated-cost reports across Claude Code, Codex, OpenCode, Hermes, OpenClaw and other sources, with [JSON output](https://ccusage.com/guide/json-output) | MIT, read from repository LICENSE     | Evaluate as a usage-data source before writing parsers. Preserve estimated-cost semantics and missing-pricing indicators.                                                |
| [HAPI](https://github.com/tiann/hapi)                     | Native-agent sessions controlled through mobile/web surfaces, including remote approval workflows                                                                         | AGPL-3.0                              | Evaluate an existing mobile/control surface and documented client contract. Native-session remote handoff is not evidence of cross-harness migration.                    |
| [Superset](https://docs.superset.sh/overview)             | Multi-agent workspaces, worktrees, desktop/mobile surfaces, native agent workflows, CLI/SDK/MCP, and automations                                                          | Elastic License 2.0, source-available | Evaluate whole-product fit and supported external interfaces. Keep the source-available distinction explicit when assessing an open-source foundation.                   |

The license labels above identify the reviewed upstream material. Distribution, modification, and integration choices require checking the actual relevant files and dependencies; no code has been copied into Forge.

## Reproducibility references

GitHub HEAD references observed during the review:

- T3 Code, added 17 October: `02d48aec5c75e6abb90d06fd2c63939a82bd3718`. The root LICENSE is MIT, copyright 2026 T3 Tools Inc.; see the [pinned review](T3_CODE_REVIEW.md) for actual account/continuation limits and adoption gates.
- Agent Deck: `8d0f1fe1506dec1405d774c42c178291d1b20f40`.
- CC Switch: `797e0276ffc20e54cbdf55e3de84505d77231c91`.
- ccusage: `06810ef8075ce6b5297985327ce841382e89c88f`, canonical repository [ccusage/ccusage](https://github.com/ccusage/ccusage).
- HAPI: `317e39a0bb9c768ce135f3fbe3157f9e3fefeebe`.
- Superset: `d456295848fb56a908cfd72699cb102130e5c9e8`.

Documentation and repository snapshots can differ. These references record the review state, not tested release combinations. License metadata was checked against repository license files where the API returned NOASSERTION.

## What remains unproven

This review does not establish that any one candidate supplies all of Forge's intended continuity, existing desktop-session discovery, resource ownership, native schedule aggregation, memory-source portability, or dynamic runtime replacement. Absence from a README is not evidence of absence from the product.

Before choosing a base, check the exact interfaces and run a small isolated evaluation with synthetic data. Measure whole-stack idle overhead and compatibility with existing installations. Verify approval correlation, schedule ownership, native feature preservation, and usage provenance. Do not relabel an existing capability as a novel Forge contribution.

The [account design](ACCOUNTS.md) adds effective-identity checks, authentication-mode isolation, shared limit scopes, and continuation accounting to this evaluation. Agent Deck's documented Claude account transfer is direct reuse evidence, not a demonstrated Forge integration or a universal cross-harness transfer contract.

## Current direction

Prefer one suitable orchestration foundation, native runtime capabilities, and optional data-source adapters. Use a new Forge component only where a tested requirement remains unmet. Shareable workspace blueprints, a calm attention model, causal explanations for stalled work, and evidence-based continuity are product hypotheses to evaluate against these candidates.

Prioritize the [T3 Code comparison](T3_CODE_REVIEW.md) before expanding native account, mobile, orchestration or provider infrastructure. Its existing authenticated MCP boundary, instance model, transactional orchestration and demand-driven resource collector are concrete reuse candidates. Preserve a single execution owner and require measured compatibility and overhead before adoption; do not count this source review as a working integration.

## First implementation decision, 17 October 2026

Reviewed Agent Deck's `list --json` golden output and `session_approve_cmd.go` directly. Its current approval CLI resolves a visibly active native TUI overlay with a guarded keypress. The first Forge adapter needs the native RPC request identity and generation attached to a durable Forge work record. This is the concrete integration boundary chosen for the prototype; it is not a claim that a full upstream product audit proves the entire Forge design is novel.

Keep Agent Deck session management intact and read its inventory through the existing CLI when installed. Reuse ccusage's JSON reports for Claude daily accounting rather than parsing conversations. Use the existing Codex app-server for native execution, permissions, sessions, and tools; Forge adds only the local work binding, request correlation, projections, and interface. Hermes discovery reads the installed API's advertised contract. Other managed adapters remain gated on reuse and conformance evidence.

The first implementation uses Fastify, native SQLite, React, Vite, Lucide, Zod, Playwright, and axe. It installs no replacement browser, terminal, memory engine, native scheduler, or model execution loop. There is no extra always-running orchestration product required to open the workspace. Candidate CLIs were not installed or connected to private data. Whole-product fit and measured overhead comparisons remain open.

## Native SDK reuse, 17 October 2026

The second implementation checkpoint reuses `@anthropic-ai/claude-agent-sdk` 0.3.301, including its native CLI transport, tools, settings, hooks and permission callback contract. Its package metadata declares `SEE LICENSE IN README.md`; native executables and SDK use retain the upstream terms. This dependency is not relabeled MIT. The SDK is imported lazily on launch and its worker exits before Forge releases managed capacity.

The SDK's own documented restriction on third-party claude.ai login/limits means this route uses explicit API authentication. Native subscription inventory remains separate. Native request IDs and abort signals were checked through the actual SDK with a synthetic executable worker; no model or tool stack was recreated. Real native tool behavior and whole-product/runtime reuse evaluations remain open. See [driver setup and evidence](NATIVE_DRIVERS.md).

## Native Markdown memory reuse, 17 October 2026

The v0.5 bridge references existing Hermes/OpenClaw Markdown files and explicit Obsidian/other native paths. Their curation, search and memory engines stay upstream. It reuses MIT `markdown-it` 15.0.3 parser line maps for heading selection rather than inventing a Markdown parser or memory store. The parser loads lazily. Forge retains profile identity, scope, review seals and provenance, with prepared excerpts passed through native harness input. See [memory setup and evidence](MEMORY.md). Managed companion execution, native provider migration and memory-tool/search integration remain open.

## OpenCode v2 reuse, 17 October 2026

The v0.6 adapter reuses MIT `@opencode/client` 2.0.6 and the installed native CLI. The v1 SDK and v2 embedded host were evaluated; neither is installed as a replacement model runtime. Native 2.0.6 and 2.0.31 pass real tool and two-profile continuity checks; the three-harness chain also passes. Official client event decoding, native configuration, tools, permissions, model/provider selection, sessions and usage remain upstream. Forge adds ownership, exact reviews and work bindings. Read-only native recovery metadata prevents unintended startup replay; no native claims are edited. See [versioned evidence and limits](OPENCODE.md).

## Hermes ACP reuse, 17 October 2026

The v0.7 adapter reuses the installed MIT Hermes 0.17.0 ACP runtime and Apache-2.0 `@agentclientprotocol/sdk` 1.9.0 for protocol framing/dispatch. Native tools, model loop, skills, memory, providers and session restoration remain upstream. A small version-gated process-local observer reports existing native outcome flags/counters because the native ACP server can return end_turn after provider failure. It changes no installed files and implements no tool or memory engine. Actual native file/memory operations, two homes, same-session history, fresh-session learned memory, rejected credentials and a five-worker four-harness chain pass with synthetic loopback inference. See [HERMES.md](HERMES.md). OpenClaw's ACP bridge was reviewed, but owned bridge exit does not prove remote gateway-run settlement; managed OpenClaw remains gated.

## Private phone transport reuse, 17 October 2026

The v0.8 gateway reuses native Tailscale Serve for HTTPS/private-network identity and MIT `@fastify/http-proxy` 11.6.4 for HTTP forwarding, with retries disabled. It serves the existing responsive Forge workspace rather than constructing another mobile app or relay. HAPI remains an existing AGPL-3.0 mobile/native-session product; its README/license do not establish control of a pending request already owned by Forge's native coordinator. No HAPI code was copied. Forge adds the small owner/origin/CSRF boundary and process-only identity attestation for its existing exact-request controls. The actual native Codex decision and local HTTPS browser path pass; no real tailnet/device is connected. See [phone setup and evidence](PHONE_ACCESS.md).

## OpenClaw Gateway reuse, 17 October 2026

The v0.9 adapter reuses MIT `@openclaw/gateway-client` 2026.10.4 and the installed MIT OpenClaw 2026.10.4 foreground Gateway with a compatible native Node runtime. The official SDK owns WebSocket framing, authentication, challenge payloads, request correlation and protocol errors. Forge supplies platform signing, supervised process ownership, stable work/session bindings, exact once-only command reviews and counter provenance. No private hashed runtime import, native database parser, replacement agent loop or ACP bridge ownership shortcut is used. Native backend-only lifecycle parameters were rejected during evaluation and are not sent; public input is routed by native session UUID. Native `exec.approval.get` is a display-only projection, so exact revalidation uses the complete public pending list. Separate native execution profiles preserve an existing companion’s channel/schedule owner. See [the versioned contract](OPENCLAW.md). Full always-on companion control, plugin/descendant coverage, live provider isolation and recovery remain open.


## Spending coordination, 17 October 2026

The pinned native Claude SDK 0.3.301 already provides `maxBudgetUsd` and cumulative `modelUsage`/`total_cost_usd`. Forge forwards the native limit and reuses its estimate; it adds only cross-runtime admission reservations, baseline attribution and operator outcome/review receipts. [Official cost documentation](https://code.claude.com/docs/en/agent-sdk/cost-tracking) confirms estimate and resumed-counter semantics. T3 protocol-2 usage is reused as a native turn observation with unavailable dollars. No new pricing catalogue, model gateway or tool loop is added. Provider budgets keep their native owner. See [SPENDING.md](SPENDING.md).
