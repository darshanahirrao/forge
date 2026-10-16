# Initial reuse audit

Reviewed 16 October 2026 from primary project documentation and GitHub metadata. This is an initial candidate map, not an integration decision or exhaustive market review. No candidate was installed, executed, benchmarked, or connected to private user data.

Several functions previously proposed for Forge are already available in existing products. The next step is to assess whether one existing foundation can meet the whole need, and then identify a small, verified gap. Avoid adding several overlapping control planes to a resource-constrained laptop.

## Candidate evidence

| Candidate | Existing capability documented upstream | License at review | Evaluation direction |
| --- | --- | --- | --- |
| [Agent Deck](https://github.com/asheshgoplani/agent-deck) | Multi-agent session status, worktrees, configuration, cost views, phone-connected conductor, MCP pooling, and Claude account slots with transcript migration/resume | MIT | Evaluate as a session/control and account-management foundation, including overhead, ownership, and protocol coverage. Do not rebuild those features before testing fit. |
| [CC Switch](https://github.com/farion1231/cc-switch) | Provider configuration across multiple tools, MCP/skill/prompt management, and usage/quota views | MIT | Evaluate configuration and usage reuse. Switching an API provider does not establish full runtime/task migration. |
| [ccusage](https://ccusage.com/guide/) | Local token and estimated-cost reports across Claude Code, Codex, OpenCode, Hermes, OpenClaw and other sources, with [JSON output](https://ccusage.com/guide/json-output) | MIT, read from repository LICENSE | Evaluate as a usage-data source before writing parsers. Preserve estimated-cost semantics and missing-pricing indicators. |
| [HAPI](https://github.com/tiann/hapi) | Native-agent sessions controlled through mobile/web surfaces, including remote approval workflows | AGPL-3.0 | Evaluate an existing mobile/control surface and documented client contract. Native-session remote handoff is not evidence of cross-harness migration. |
| [Superset](https://docs.superset.sh/overview) | Multi-agent workspaces, worktrees, desktop/mobile surfaces, native agent workflows, CLI/SDK/MCP, and automations | Elastic License 2.0, source-available | Evaluate whole-product fit and supported external interfaces. Keep the source-available distinction explicit when assessing an open-source foundation. |

The license labels above identify the reviewed upstream material. Distribution, modification, and integration choices require checking the actual relevant files and dependencies; no code has been copied into Forge.

## Reproducibility references

GitHub HEAD references observed during the review:

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

## First implementation decision, 17 October 2026

Reviewed Agent Deck's `list --json` golden output and `session_approve_cmd.go` directly. Its current approval CLI resolves a visibly active native TUI overlay with a guarded keypress. The first Forge adapter needs the native RPC request identity and generation attached to a durable Forge work record. This is the concrete integration boundary chosen for the prototype; it is not a claim that a full upstream product audit proves the entire Forge design is novel.

Keep Agent Deck session management intact and read its inventory through the existing CLI when installed. Reuse ccusage's JSON reports for Claude daily accounting rather than parsing conversations. Use the existing Codex app-server for native execution, permissions, sessions, and tools; Forge adds only the local work binding, request correlation, projections, and interface. Hermes discovery reads the installed API's advertised contract. Other managed adapters remain gated on reuse and conformance evidence.

The first implementation uses Fastify, native SQLite, React, Vite, Lucide, Zod, Playwright, and axe. It installs no replacement browser, terminal, memory engine, native scheduler, or model execution loop. There is no extra always-running orchestration product required to open the workspace. Candidate CLIs were not installed or connected to private data. Whole-product fit and measured overhead comparisons remain open.

## Native SDK reuse, 17 October 2026

The second implementation checkpoint reuses `@anthropic-ai/claude-agent-sdk` 0.3.301, including its native CLI transport, tools, settings, hooks and permission callback contract. Its package metadata declares `SEE LICENSE IN README.md`; native executables and SDK use retain the upstream terms. This dependency is not relabeled MIT. The SDK is imported lazily on launch and its worker exits before Forge releases managed capacity.

The SDK's own documented restriction on third-party claude.ai login/limits means this route uses explicit API authentication. Native subscription inventory remains separate. Native request IDs and abort signals were checked through the actual SDK with a synthetic executable worker; no model or tool stack was recreated. Real native tool behavior and whole-product/runtime reuse evaluations remain open. See [driver setup and evidence](NATIVE_DRIVERS.md).
