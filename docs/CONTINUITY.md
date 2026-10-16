# Work continuity

Checkpoint `forge-v0.3.0`, 17 October 2026. Explicit native handoff now keeps the same work record and project while changing to another Codex account slot or a Claude API slot. The native worker, tools, authentication and permissions remain supplied by the selected harness.

## Use a verified checkpoint

After a managed attempt finishes, open its work record and choose **Change harness or account**. Select the destination, then prepare a checkpoint. By default, Forge asks Git for the project's tracked and nonignored files. Enter one relative path per line for an explicit selection or a project without Git.

Review the file count, selected context, exclusions and destination. A private JSON download contains the checkpoint evidence and work context. Native activity, detached tools and external effects need reconciliation at this boundary. Switching changes the binding and returns the same work to Ready; it does not launch a worker or authorize metered spending. The next launch checks the new native authentication and permissions.

Original native sessions, runs, usage and user checkpoints stay recorded. The destination starts a fresh native session. Its prompt receives the current goal/context/checkpoints, checkpoint reference and artifact digest, plus selected recent result excerpts. Full native conversations stay associated with their original session references. Hidden native state and native permission grants are not migrated.

## What a Work Capsule records

The versioned `forge.work-capsule` object contains its work ID, source binding/run/session, parent capsule, work revision/generation, goal, acceptance criteria, project context, all saved user checkpoints, up to five recent native result excerpts, selected file fingerprints, exclusions and SHA-256 digests. Excerpts are limited to 4,000 characters each and record whether they were clipped. Original captured results stay in private event history.

File evidence records a relative path, SHA-256, byte count, mode and whether the path was present or absent. File contents remain in the existing project directory. Git inventory can therefore detect a newly added file or a restored deletion before transfer. Explicit selections verify only the named files. Credential/dependency/runtime paths are excluded; symbolic links and nonregular files require another selection. Limits are 2,000 selected paths, 5 MB per file and 50 MB total content. Oversized portable context is rejected rather than silently dropping user checkpoints.

Capsules are private project data and can contain user-authored context and native result excerpts. They are separate from the sanitized setup blueprints intended for sharing.

## Coordination invariants

- Preparation and verification reserve managed admission so a Forge worker cannot start while files are being checked.
- A source attempt must have a durable native-worker exit receipt. Interrupted recovery clears that confirmation; a disconnected transport is insufficient proof.
- The work revision, generation, source binding and context digest must still match the prepared capsule. Handoff rechecks the selected file state and destination configuration before its transaction.
- The transaction retains the work ID/history and capsule lineage, changes the account/harness, clears the native session and advances its generation. Outstanding source permissions are invalidated.
- Every HTTP launch includes the reviewed `expectedRevision`. A changed task or binding cannot reuse the earlier launch/metered decision. Internal native adapters still check effective authentication on their actual worker.
- Native credential files are not copied between profiles. Limits remain native scopes; selecting another slot does not establish a distinct allowance or subscription eligibility.

## Verification and limits

The normal suite has 39 functional/API/continuity/driver checks and six browser flows. Coverage includes changed work/files, unconfirmed source exit, unsupported targets, traversal/symlinks/size limits, deleted/new Git files, checkpoint/launch exclusion, same-harness account changes, retained usage/source references, demo isolation and revision-bound launch. Type checks include test/native fixture sources. The handoff view passes accessibility and overflow checks in light/dark desktop and mobile previews.

`npm run test:native:handoff` also passes with actual Codex 0.159.3 and native Claude Code 2.1.301 through SDK 0.3.301. It chains Codex to Claude API profile one and then profile two, sequentially. Both destinations must observe the retained goal, user checkpoint and manifest, read the preceding artifact through their native tool and create the next artifact. The check verifies three artifacts, three approvals, confirmed worker exits, one work ID, capsule lineage and all three account-attributed usage scopes. Its model providers and credentials are deterministic local fixtures; it uses zero paid model calls.

This evidence does not establish live subscription eligibility, real provider quota isolation, model quality, arbitrary native-session takeover, complete hidden-state migration, remote workspace replication or fencing of foreign processes and external actions. Automatic quota fallback remains disabled. Additional harness/runtime and memory/schedule integrations remain in the [full completion audit](COMPLETION_AUDIT.md).

## Upgrade and API compatibility

Private state version 2 prevents an older app from bypassing the new continuity semantics. A version-1 file workspace receives a native SQLite `workspace.sqlite.before-v2.UUID.sqlite` copy, with private permissions, before upgrade. Its existing records are preserved. Legacy attempts without an exit receipt cannot be used directly as a verified handoff source.

To inspect a rollback copy, stop Forge, preserve the current state separately, and copy the chosen snapshot into a separate data directory as `workspace.sqlite`. Use an appropriate older code checkpoint against that separate copy. Do not combine old snapshots with current SQLite sidecars or overwrite newer work without retaining it.

HTTP clients must send `expectedRevision` when launching. New endpoints are `POST /api/work/:id/capsules`, `GET /api/work/:id/capsules/:capsuleId`, and `POST /api/work/:id/handoff`. Source contracts are in `shared/types.ts`; coordination and fingerprinting are in `server/continuity.ts` and `server/execution.ts`.
