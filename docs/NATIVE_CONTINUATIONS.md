# Continue an existing native chat

Forge v0.37 can continue a completed stored Codex chat through Codex's own native fork. It keeps the original conversation intact and links a separate managed fork to one canonical Forge work/profile. Native history stays in Codex; Forge stores bounded provenance and a SHA-256 fingerprint, not a copied transcript or a replacement summary.

Open a Codex chat from Workspace, Activity or Commands, then choose **Continue in Forge**. Select an account using that source's exact native home and a persistent Forge profile. If needed, link the account through the existing form; the native home is prefilled and your title/goal/profile draft returns afterward. Review the history boundary and link the work. Linking starts no native fork or model turn.

The normal managed-launch dialog separately requires source settlement, current context/resource review and any metered-provider consent. Forge cannot stop or approve the original foreign worker through its metadata reference. Settle that source's workers, approvals, detached tools and external effects in the native client before launching.

## Native contract

The evaluated installation is Codex CLI 0.159.3. The integration uses public `thread/read` and paginated `thread/turns/list` with full items, followed by `thread/fork` through the last completed turn. Official [Codex app-server thread documentation](https://developers.openai.com/codex/app-server#threads) describes stored-history forks and completed-turn boundaries. The installed generated schema and actual native behavior establish this version's `deferGoalContinuation` and explicit runtime-root support.

A local review checks native identity, canonical native home/project, source/profile/account revisions and the complete bounded public turn fingerprint. The account and original native source must match. A review expires after five minutes. Activation is idempotent and creates one work record with a pending native origin; a refresh of an unbound review updates that same work. A pending source cannot be forgotten or silently rebound through ordinary work editing. Use a reviewed handoff for a different binding.

At managed launch:

1. Check the current native account, project and provider against the reviewed binding.
2. Read the source again and require the same full fingerprint, latest completed turn and item/turn counts. Changed history receives no fork or task input.
3. Ask native Codex to fork through that exact turn, defer inherited goal continuation and explicitly request user approvals, workspace-write permissions and the reviewed runtime root.
4. Verify the returned fork identity/provider/root and its complete copied public turns. A partial or mismatched fork receives no task input.
5. Clear only the fork's inherited autonomous goal. Confirm fresh permission policy, then durably bind the new native ID before requesting the explicit Forge turn.
6. Use the existing exact approval inbox, original-child ownership, resource attribution, native close proof and restart recovery. Later turns resume that fork and retain the same work/profile.

Native tools, instructions, configured MCP integrations and execution remain native. This does not adopt or signal an observed process, settle remote effects, transfer an old pending approval, or preserve opaque provider state across harnesses. Other native clients can change a source between observations; the public fork has no source-revision CAS. Human settlement remains part of the contract. An uncertain launch never automatically repeats; an explicit reconciled retry can leave another dormant native fork if an earlier acknowledgement was lost.

Public turn review is bounded to 1,000 turns, 5,000 items and 8 MiB, with a finite 20-second read budget and the existing 4 MiB native-message limit. Empty, active, latest-failed/latest-interrupted, incomplete, duplicate or oversized history stays held without summary substitution. Native account/read helpers are finite, use the existing cooperative profile lease and share checkpoint/source/pressure admission. Native JSON errors and transcript contents are not persisted as diagnostic excerpts.

When selected Forge memory changes later, the existing fresh-conversation rule still applies. Provenance remains visible while context coverage becomes explicit. A cross-account/harness handoff carries selected Forge context/artifacts through its existing contract; this flow does not claim lossless cross-provider history migration.

## Token accounting

Native Codex forks inherit the source's cumulative token totals. Charging that total to the new work would count the original chat again. Continued work uses a per-run counter key and native `total`/`last` facets from the current turn: its first current native update establishes the inherited baseline, later cumulative updates replace the same run record, and resumed runs establish their own baseline. Duplicate snapshots do not add usage. Missing or inconsistent native facets remain unreported; unknown dollar pricing remains null. This is native usage evidence, not an invoice or account-wide quota claim.

## Validation and rollback

Functional acceptance covers no model startup on link, transcript exclusion, same-work review refresh, native copied-history checks, stale history, local/phone/demo/CSRF boundaries, wrong-profile refusal, pending source holds, exact approvals, retained resume and inherited-token exclusion. Browser acceptance covers account linking with preserved draft, launch settlement, native approval, reload, both themes, desktop/phone layouts and accessibility.

`npm run test:native:continuation` uses the actual compiled Forge and installed Codex with a disposable profile and local deterministic Responses fixture. It creates a real source chat, reviews/links without inference, verifies the native copy, delivers one exact approval, writes a real artifact, restarts the compiled host, resumes the same fork and checks signed closures. Source history/configuration/paused goal remain unchanged, while the fork's inherited goal is absent. Three managed model responses account for 54 tokens, excluding the source's 18 tokens. All inference is local synthetic data; paid calls and personal changes are zero. Supply `FORGE_CODEX_BINARY` only for an isolated executable override.

State 15 protects native-origin bindings and accounting semantics from older readers. The upgrade retains a private before-v15 copy. Actual compiled v0.36/state 14 upgrades with exact canonical rows, a mode-0600 rollback and previous-reader refusal. Native profiles and original worker proofs must be retained separately; restoring SQLite does not undo external effects or settle a source worker.
