# Build log

## 2026-10-17 · forge-v0.1.0

Built the first local application: a responsive light/dark workspace, keyboard search, native installation discovery, SQLite work records and checkpoints, account slots, native account/allowance probes, real OS telemetry, quiet-mode admission, selected context exports, and sanitized setup-blueprint export. Added an experimental Codex app-server bridge for managed turns, native one-time approvals, cancellation, usage snapshots, and interrupted-run receipts. Hermes has explicit read-only health/capability discovery. Existing Agent Deck and ccusage CLIs remain optional inventory/accounting sources.

Used native SQLite exclusive ownership to prevent a second service from recovering or dispatching an active workspace. Work summaries commit atomically with full context and keep polling lightweight. Added revision conflicts, native-request withdrawal handling, CSRF/origin/host checks, bounded capture, and isolated fictional demo state. Source is divided into server adapters, a deterministic controller/store, shared contracts, and focused interface modules. Added contributor setup and a pinned GitHub Actions verification workflow.

Validation: type checks, formatting, production build, 20 functional/API checks, and four Playwright flows with axe checks pass. Browser coverage includes real persistence/reload, demo decisions, keyboard search, themes, and all views at a narrow width. Rendered light/dark desktop and mobile previews. The installed Codex CLI passed a native initialization handshake without an account lookup or model turn. Dependency audit reports zero known vulnerabilities at this checkpoint. Local document links and Git diff checks pass.

Limitations: native execution is experimental and tested with synthetic protocol fixtures plus the initialization smoke check. No real model task, real native approval, account migration, paid usage, or private native import was exercised. Automatic account fallback, cross-harness transfer, mobile approvals, scheduling control, hard resource limits, and full runtime/memory replacement remain delivery gates. Preliminary service RSS was about 80 MB; full-stack performance targets are unproven. No existing native account or schedule configuration was changed. Checkpoint reference: the commit containing this entry; durable tag `forge-v0.1.0`.

## 2026-10-16 · architecture-20261016

Created Forge's open-source architecture proposal for Persistent Agency. Defined a primary workspace with stable agent identity, dynamic component contracts, replaceable Hermes/OpenClaw runtimes, heterogeneous native harness adapters, portable work checkpoints, scoped memory, resource ownership, approval correlation, and source-labeled token and dollar accounting.

Validation: reviewed eight primary research papers and official runtime/harness documentation; inspected installed Hermes capability declarations without reading credentials or changing its configuration. Rendered the complete overview SVG to a 2960 x 3520 PNG and visually checked it. A headless system-Chrome geometry check found zero outer or control-panel text overflows across 56 labels. Local Markdown links and SVG XML validate; source audit found no private local paths, credential patterns, long dashes, or stale mandatory-Hermes wording. Generated previews remain ignored. There is no runtime to test at this checkpoint.

Limitations: design only. No runtime, adapter, mobile approval path, real usage ledger, migration facility, or resource enforcement has been implemented or benchmarked. No existing agent, job, or schedule was changed.

Checkpoint reference: the commit containing this entry; durable tag `architecture-20261016`.

## 2026-10-16 · native-capabilities-20261016

Corrected the product boundary following the user's explicit direction: Forge must reuse capabilities already supplied by harnesses and runtimes, including browser/computer use, terminals, file tools, skills, memory engines, and native scheduling. Added NATIVE_BOUNDARY.md and updated architecture, component contracts, product/experience descriptions, and diagram to show adapters and existing native execution. Forge's scope is continuity and cross-runtime coordination, resource/cost visibility, and routing native approvals.

Validation and limitations: local Markdown links, SVG XML, credential/private-path/style audit, and Git diff checks pass. Re-rendered the full diagram to 2960 x 3520 and visually checked it; system-Chrome geometry checks find zero overflow across 56 labels. Documentation and diagram only; no native tooling, runtime configuration, process, or automation was changed. Checkpoint reference: the commit containing this entry; durable tag `native-capabilities-20261016`.

## 2026-10-16 · reuse-before-build

Extended the reuse rule beyond native harness capabilities to existing libraries and open-source products, including proposed Forge core features. The next step is a product/component reuse map; adopting or extending a suitable existing solution takes precedence over duplicating it. Marked the product-level gap audit as outstanding rather than claiming the proposal establishes novelty. Validation: local document links and Git diff checks pass; documentation-only change. Checkpoint reference: the commit containing this entry.

## 2026-10-16 · blueprints-and-reuse-review

Added the proposal for user-moldable workspace blueprints: presets, configuration, and extensions over existing component bindings, with private data excluded from sharing. Added product judgments around a calm home, stall explanations, attention-aware decisions, outcome accounting, and compatibility previews. Recorded an initial primary-source reuse review of Agent Deck, CC Switch, ccusage, HAPI, and Superset, with observed commit and license references. Marked the initial Rust/SQLite stack as provisional pending existing-foundation evaluation. No candidates were installed, executed, or connected to private data; overlap and integration fit remain distinct. Validation: local document links, source-hygiene audit, and Git diff checks pass; no runtime exists to test. Checkpoint reference: the commit containing this entry.

## 2026-10-16 · multi-account-continuity

Added the explicit multiple-account requirement: separate native account bindings around one durable workspace and work record, with effective-identity checks, scoped routing, context coverage, safe transfer, native quota windows and shared scopes, and continuous account-attributed accounting. Reviewed official Claude multiple-account authentication, Codex credential and app-server account interfaces, and Agent Deck's existing Claude account transfer. Updated the component, product, blueprint, adapter, and reuse documents and architecture figure. Connecting account slots must not start one always-running worker per account.

Validation: local Markdown links, source-hygiene audit, SVG XML and layout checks, and Git diff checks pass. Re-rendered and visually reviewed the architecture figure. Documentation and diagram only; account isolation, continuation, quota routing, and accounting remain unimplemented and untested. No native account, credential, login, runtime configuration, or automation was inspected or changed. Checkpoint reference: the commit containing this entry.
