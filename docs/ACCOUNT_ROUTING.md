# Ordered native account routing

Configure an ordered pool from a work panel’s Account routing section. The authorization covers that exact project directory, profile identity and selected account bindings. Work identity, goal, checkpoints, artifacts and usage history remain independent of the selected account. Existing registered T3 harnesses and supported direct native adapters use the same routing contract.

## Eligibility and evidence

Each slot pins a hash of harness, native home, credential environment reference, billing mode, backend/model/project selection and observed native identity. Changed authority requires a fresh authorization. Native credential bytes are never read into the route or exported. Profile/project changes invalidate its scope.

Routing chooses the first eligible slot, without adding quota percentages together. Native buckets retain their source, identity and observation time. Equal native buckets and identity aliases share reported exhaustion. The latest native observation wins; equal-time conflicts choose the more restrictive value. A fresh included-usage denial applies to identity aliases. A reset timestamp alone does not restore allowance.

The default policy requires fresh checked identity and native quota evidence. Age is bounded to 30 to 900 seconds, default 300. Unreported quota/identity and API or unverifiable native billing require separate explicit choices. Reported exhaustion, unavailable providers, changed bindings and stale account observations still exclude the slot. Example data cannot establish native allowance. This is provider evidence, not an independent promise of future capacity or identity isolation.

## From recommendation to execution

1. Review the ordered recommendation. A bounded two-minute plan binds the work revision, policy, selected native metadata and shared evidence.
2. For unused work, prepare the selected account without starting a worker or changing its goal/context. For prior native work, the existing verified capsule/handoff path requires source settlement, current artifacts and human reconciliation of external effects. Non-Git projects can supply explicit relative files from the work panel.
3. Launch review reads the new binding’s current profile and memory. Latest account and spending policy are checked after asynchronous preparation, before driver construction. Supported native account observations revalidate routing and companion authority before model input. T3 reuses the same native observation normalization for catalogue import and pre-dispatch checks.

Plans expire, are bounded in memory and cannot replay an execution. Changed files, work, identity or evidence stop preparation. A prepared capsule can remain as a recoverable checkpoint if a later verification fails. Native permissions remain native. A completed T3 account transfer may retain its application thread while T3 chooses compatible native history or its explicitly recorded summary fallback.

The router submits no model input, starts no retry loop and cannot settle an uncertain run. Failed/interrupted attempts retain the existing reconciliation requirement. There is no automatic replay, quota redemption or switch to billing that the route excluded. Scoped companions inherit these admission holds and cannot configure routes or broaden their own grants.

## Native status and resources

Refresh native evidence uses existing status/probe APIs. It shares the workspace’s native-read admission, performs at most four sequential checks and deduplicates backend refreshes. It stops after an earlier eligible choice and starts no resident router. Further stale slots can be refreshed on demand. Status probes retain their native recovery, authentication and ownership constraints. Saving a route starts no native process.

This adds coordination over native account/model/usage contracts, not provider switching middleware. T3’s [pinned native limit contracts](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/packages/contracts/src/providerUsageLimits.ts) and existing public protocol are reused. Forge adds no new credential store, inference gateway, scheduler, browser or memory engine.

## API and recovery

- `GET /api/work/:id/route` returns public policy, candidates and the current recommendation/plan.
- `PUT /api/work/:id/route` requires current work/policy revisions and the explicitly ordered pool and choices.
- `POST /api/work/:id/route/refresh` performs bounded native checks.
- `POST /api/work/:id/route/prepare` requires the reviewed plan ID/digest and reconciliation/files when needed.
- `DELETE /api/work/:id/route` requires current work revision and idle managed execution. It removes policy only; the selected binding and history remain.

These are protected human workspace APIs. Native account deletion is blocked by current work, saved run attribution or an approved route. Private binding hashes stay outside public route responses and blueprints.

State version 5 prevents older releases from ignoring spending/routing policy. The upgrade makes a private native SQLite before-v5 rollback copy from v1 through v4. Stop Forge before restoring an earlier database and application checkpoint. General shared routing presets, live subscription-account isolation, automatic provider billing reconciliation and compatible native-history preservation remain open. Read [SPENDING.md](SPENDING.md), [CONTINUITY.md](CONTINUITY.md) and [NATIVE_BACKENDS.md](NATIVE_BACKENDS.md).
