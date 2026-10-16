# Completion audit

Active goal: finish the full Forge workspace described by the user. This checklist preserves that scope across continuations. An implemented feature is not complete merely because a synthetic test passes. A source release is not a hosted deployment.

Audit started 17 October 2026 from clean main checkpoint `a3e54d2`. The previous goal turn made progress: it created the first runnable application and a verified GitHub checkpoint. Current completion remains unproven.

| Requirement | Evidence needed | Current authoritative evidence | Status |
| --- | --- | --- | --- |
| One polished workspace for all ongoing work | Real connected work and native activities, usable desktop/mobile views | v0.2 interface and five browser flows; existing chats are not yet aggregated | Partial |
| Harness replacement: Codex, Claude Code, OpenCode and extensible others | Versioned adapter contract, native lifecycle/permissions, real compatible continuation | Shared coordinator with Codex and Claude API adapters; SDK transport fixture passes; other choices largely metadata | Open |
| Replace Hermes with OpenClaw or another runtime | Equivalent connection role, portable profile/memory refs, runtime conformance | Hermes discovery only | Open |
| Multiple accounts per harness in one context | Isolated native identity, attributable usage, supported routing/transfer with no duplicate writer | Account slots and native probes; transfer disabled | Open |
| Persistent goals, files, context and progress | Verified Work Capsule, artifact evidence, recovery and context-coverage checks | User-authored notes/checkpoints persist; native/artifact checkpoint incomplete | Partial |
| Permanent curated memory with replaceable providers | Scope, provenance, correction/export/deletion, native memory reuse | Native source references described, no working memory bridge | Open |
| Central native approval inbox and phone access | Exact request correlation, authenticated remote decisions, expiry/withdrawal tests and real integration | Codex request routing tested with fixtures; phone transport absent | Partial |
| Schedules, heartbeats and ongoing activity | Native inventories and supported operations, one scheduler owner, unchanged schedules preserved | Native scheduling not integrated | Open |
| Resource ownership, laptop headroom and cleanup | Defined whole-stack measurements, owned-worker admission/cancellation, safe resource cleanup | OS observation and one managed slot; no full benchmark or ownership proof | Partial |
| Tokens, dollars, quota and outcome accounting | Native counters, currency/rate provenance, deduplication, budget admission, accepted-outcome history | Native Codex tokens, Claude SDK pipeline tokens/cost estimates, overlap-aware aggregate display; outcome accounting and budgets remain open | Partial |
| User-moldable open-source workspace | Import/export blueprints, versioned extensions, configuration/presets, public reproducible setup | MIT repository, small setup export, fixed adapter list | Partial |
| Reuse existing harness capabilities | Concrete upstream interface/license review and delegation to native implementations | Native tool stacks reused; additional adapters require their own checks | Ongoing |
| Reliable recovery and portability | Real artifact-producing cross-account and cross-harness tests, failure injection near external effects | 28 functional/API/driver tests, five browser flows, installed SDK transport fixture and Codex initialization; real artifact handoff remains open | Open |
| Delivery and continuity | Passing relevant local/CI checks, remote commit/tag verification, current build log/handoff | v0.1 checkpoint verified; v0.2 validation passes locally and requires remote checkpoint verification | Ongoing |

## Native compatibility findings

- Claude Agent SDK documentation says third-party products need approval to offer claude.ai login or rate limits. SDK-managed execution must use supported API/cloud authentication unless the required upstream approval is established. Native subscription slots are not converted into a subscription proxy. Source: https://code.claude.com/docs/en/agent-sdk/overview
- The installed Hermes source advertises run APIs but its legacy approval handler resolves the current session prompt without a request ID/generation. Current upstream documentation describes canonical identity-bound controls. Forge must negotiate the deployed contract and refuse identityless approval forwarding. Source: installed API capability declarations and https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server

Update each row from inspected files, native behavior, or test evidence. Leave unsupported or unverified requirements open; do not redefine completion around a smaller release.
