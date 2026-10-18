# Native schedule transfer

Forge moves compatible local agent schedules between evaluated Hermes 0.17.0 builtin profiles and OpenClaw 2026.10.4 Gateway protocol 4 connections. The native runtimes continue to own timing, model selection, tools, execution, billing, history and delivery. Forge runs no scheduler or model loop.

In Activity, open Schedules and choose **Move schedule**. Connect a second Hermes scheduler or an OpenClaw scheduler with locally reviewed administrator access first. Review instructions, timing, both complete native definitions and the explicit changes. **Stage move** pauses future source scheduling and creates a disabled destination. Inspect both native runtimes for already selected work, pending mutations, runs and deliveries. **Review transfer** reads both owners again. After the separate human settlement review, **Enable destination** enables its native scheduler and keeps a durable Forge resume hold on the original.

**Keep both paused** disables the destination and releases the original's Forge resume hold. The original stays paused until a separate native resume review. Original native definitions and histories are retained, and Forge does not delete native jobs. Reverse a chain from its newest transfer first. A native definition edited after staging can be reviewed and paused without restoring the old definition; activation remains held when its portable semantics changed.

## Portable intersection

Supported tasks have self-contained agent instructions, local output and independent native sessions:

- One-shot ISO instants, at least two minutes in the future when reviewed. Milliseconds and timezone offsets resolve to the same instant. Native completion semantics must match one execution.
- Whole-minute repeating intervals. Enabling starts the destination's native cadence; the original interval phase is explicitly not preserved.
- Common five-field numeric cron expressions with an explicit profile timezone and no native staggering. Six-field, named and extended expressions need native mapping because the parsers differ. A destination Hermes profile must already use that exact timezone. The native parsers validate the actual expression.

The destination uses its native defaults for models, tools, memory and permissions. OpenClaw uses the native main agent and an isolated automation session. The reviewed default administrator-origin tool policy and wildcard tool selection are accepted; restricted tool policies are held. Missed-run and daylight-saving behavior follows the destination native scheduler. The original native record stays available for provenance. Native run history is not replayed or treated as fresh execution history.

Pinned models/providers, commands, scripts, skills, dependent outputs, working directories, attached sessions, channel delivery, finite repeat counters, conditional triggers, pacing, special native session targets and unknown execution fields need explicit native mapping before they can move. Forge rejects them instead of dropping their semantics. Native profile memory migration and curated memory-source selection remain separate reviewed workflows. This contract does not claim arbitrary lossless schedule translation, Codex automation transfer or other scheduler-provider support.

## Native implementation and interruption

OpenClaw uses the existing paired operator client and public `cron.add`, `cron.get`, `cron.list` and revision-fenced `cron.update`. Its native disabled creation carries a unique `forge.transfer.<uuid>` declaration key. A lost create acknowledgement is reconciled by locating the existing native declaration, never by replaying creation. Listing is bounded to 2,000 records; absent or hidden rows do not prove absence.

Hermes creates its template through native `create_job` in an owned inert temporary profile, then pauses it there. Only a paused template is published to the live destination through native `save_jobs`, inside the evaluated native reentrant cross-process lock. Thus no enabled template is published to the live destination between create and pause. Native inference-default drift guards are regenerated for the destination through the installed native implementation. The destination job/config fingerprints must still match the review. Temporary profiles are private and removed after construction. Templates carry no credentials or channels.

State 13 forward-gates the persistent transfer receipts and holds. Before any native mutation, Forge saves its intent. Interrupted preparing, activating or cancelling states become uncertain on restart; no native operation is automatically retried. Human **Record outcome** reads both owners and records the verified scheduling state with a note, without creating, enabling, pausing or running anything. Explicit native-store and pending-operation review is required before recording that an absent or hidden target was never created. Prior uncertain native-control receipts must be resolved first.

Resume holds follow the canonical Hermes profile and conservative OpenClaw loopback port identity, including connection aliases and previously prepared Forge control reviews. An unknown OpenClaw destination ID holds all Forge resumes for that destination until reconciliation. Both source connections remain referenced until cancellation. The workspace checkpoint and shared source gate exclude concurrent Forge launches, setup and source operations; shutdown drains finite operations before closing state.

This is cooperative ownership across Forge's native interfaces. Another native client can bypass a Forge hold, and pausing future scheduling does not settle previously selected work, detached processes or remote delivery. The separate human activity review is required. There is no distributed atomic transaction across two native schedulers. A human cancellation or reconciliation does not prove unobserved external effects stopped.

## Evidence

`npm run test:native:schedule-transfer` uses the compiled coordinator and actual installed native runtimes with owned disposable profiles. It verifies one-shot, interval and cron transfers in both directions, disabled native staging, exact one-shot time, source resume holds, a lost native create acknowledgement located without recreation, reviewed cancellation, retained definitions/configuration and original signed Gateway closure. Model requests and paid inference are zero; personal profiles are untouched.

Functional/API checks cover stale definitions, canonical aliases, old prepared resume requests, pending native controls, bounded public projections, interrupted state, explicit absence review, local human/CSRF authority and shared checkpoint/source exclusion. Browser checks cover staging, activation, reversal, outcome reconciliation, keyboard accessibility and both-theme desktop/phone layouts. This is not live subscription, native job-delivery or physical-device acceptance.

Public upstream references: [Hermes cron internals](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/cron-internals.md), [OpenClaw automation commands](https://docs.openclaw.ai/cli/cron) and [native schedules](https://docs.openclaw.ai/automation/cron-jobs/schedules). The installed versions, rather than newer web documentation, define the evaluated ABI.
