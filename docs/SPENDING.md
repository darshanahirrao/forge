# Spending and accepted work

Forge records one durable accounting receipt for each new managed attempt. The ledger covers attempts admitted by this workspace after the feature was installed. Native observations, imported ccusage totals, earlier runs and outside sessions retain separate coverage and are not silently added to this ledger.

## Budget admission

Accounts → Spending and outcomes → Set budgets configures an optional UTC monthly limit, a lifetime limit for each work record and a reservation for each attempt. Monthly or work limits require an attempt reservation. All managed starts, including companion dispatch, pass the same final policy check after context and memory-pressure preparation, before constructing the native driver. The run and its reservation commit in the same SQLite transaction. A changed reviewed policy rejects launch. Money is represented in integer microdollars, conservatively rounded upward to six decimal places.

Capacity is consumed by reported native estimates, explicit human reports and held reservations. Native estimates above their reservation hold further budgeted dispatch until reviewed. Unknown costs retain their reservation and hold further budgeted attempts across month boundaries. Disabling budgets is an explicit human policy change, not an automatic recovery action.

An attempt reservation is an admission control, not a universal provider charge ceiling. Native inference, external tools, background work, unreported costs and late provider charges can exceed it. Forge forwards the reservation to the supported Claude Agent SDK `maxBudgetUsd` option. Other runtimes retain their native spending mechanisms. Forge adds no model proxy or replacement agent loop.

## Evidence and reconciliation

Session-cumulative Codex, Claude and OpenCode counters use their saved baseline to produce per-attempt deltas. Hermes/OpenClaw worker and T3 turn counters retain their native scope. Repeated reports do not add the same tokens or estimate twice. Missing resumed baselines, unknown dollars and decreasing counters remain incomplete; negative deltas never produce budget credits. Scope details remain in the original usage entry. Scope count is bounded, and a scope overflow is explicit incomplete coverage.

Native dollar fields remain estimates. The [official Claude cost guide](https://code.claude.com/docs/en/agent-sdk/cost-tracking) and the pinned SDK 0.3.301 declarations confirm cumulative resumed results and query-local budget semantics. Native bundled pricing and excluded auxiliary calls can differ from billing. Forge does not invent a token-to-dollar rate or label subscription quota as a dollar balance.

A human can record a verified USD amount and evidence note after native settlement. This creates an attributed, immutable review beside the original counters. A review does not settle a native run, release its execution lease, rewrite a provider charge or establish invoice verification. Unconfirmed owners must first pass the existing exact native reconciliation. Crash recovery retains reservations and never replays a model request.

## Acceptance

The work panel records an operator decision and note separately from native completion. Acceptance requires at least one settled managed attempt and no unresolved run. Later work/context edits or attempts make that decision stale while preserving its evidence and timeline. Accepted-outcome counts include current human decisions only.

## Interfaces and limits

- `GET /api/spending` and the human snapshot return policy, monthly totals, open reservations, unresolved counts, token deltas and recent receipts. Recent receipts are bounded to 50; per-work detail is bounded to 100. Aggregate accounting includes all ledger entries, not only visible rows. SQLite aggregates avoid loading every counter into JavaScript during polling.
- `PATCH /api/spending/policy` requires the current policy revision and all three nullable USD settings.
- `GET /api/work/:id/spending` returns current admission and saved evidence.
- `POST /api/spending/:runId/review` requires receipt revision, USD amount and evidence note.
- `POST /api/work/:id/outcome` requires work revision, accepted/needs-work decision and a note.

These are protected human APIs. Companion credentials cannot edit budgets, review their own spend or accept their own work. Companions inherit budget admission through their existing scoped dispatch. No provider keys or native credential bytes enter accounting records. State version 4 remains unchanged; collections and indexes are additive. Full provider billing reconciliation, automatic price provenance and universal native hard limits remain open.
