# Build log

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
