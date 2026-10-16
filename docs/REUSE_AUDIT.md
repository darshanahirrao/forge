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
