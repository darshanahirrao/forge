# Native profile migration

Forge reuses the installed native importers to prepare a new Hermes or OpenClaw profile. It retains one canonical work record and profile through the existing [work handoff](CONTINUITY.md). It adds no memory engine, tool stack, planner or scheduler.

## Local workflow

In Accounts, choose Import native profile and an explicit Hermes or OpenClaw source account. Stop and reconcile its managed native owner first. Preparation invokes the target's own dry run and importer into a fresh private directory. Review imported, archived, skipped and overflowed items before adding the resulting account. Source profiles remain in place.

Credentials default to separate native setup. Reusing a provider credential reference is an explicit choice; Forge copies reference metadata, never its secret value. Native provider authentication and model selection still require their ordinary checks.

For OpenClaw, an optional native project directory authorizes guarded sessions in that exact project while imported memory stays in the private native workspace. The dedicated Gateway requires native administrator API scope to create a session outside its configured workspace. This is an explicit local account choice, included in its binding and import receipt. Other project directories are refused before native startup; routing and handoff also exclude a mismatched project. The native guarded permission mode and exact command reviews remain active.

After activation, Continue existing work opens the existing checkpoint dialog with the new account selected. It verifies selected project files and requires review of native activity and external effects before moving the binding. Task/profile identity, goals, saved checkpoints, file evidence and usage history remain together. Native conversations retain their original links; the target starts its own conversation.

Existing curated memory references on the canonical profile keep their original source and scope. Import does not silently repoint them to a transformed native file. Review and update or unpin an obsolete reference in Memory when changing which engine owns a fact; a pinned original can intentionally continue supplying its old text independently of the target engine's corrections.

## Evaluated native contracts

OpenClaw 2026.10.4 provides `migrate plan hermes` and `migrate apply hermes`. Forge supplies the explicit source, `--no-auth-credentials`, JSON output, a private backup destination and a fresh target configuration. Cron is disabled and heartbeat is zero in the initial dedicated execution profile. Native import policy owns compatible memory, persona, instructions, skills and configuration translation.

Hermes 0.17.0 provides the public command-line utility `optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py`. Forge discovers it from installed package metadata and checks the evaluated SHA-256 `20a3c8d30cb49c73eb45a9da2ca7854748b2ef7ed9d25552ce6476abcb32cd25`. The utility runs first in its default dry-run mode, then with `--execute --preset full --json`, explicit source/target/workspace paths, no overwrite and no secret-migration option. Changed implementations require evaluation before use. Forge does not call private Python migration internals or install another runtime.

Native home resolution retains existing `~` workspace/shared-skill meaning. Provider-key and runtime-preload environment variables are not inherited by the import utility. Isolated conformance hosts supply a separate synthetic native user home. Native shared skills can be included, so inspect permissions and native reports before activation.

Upstream contracts: [Hermes migration guide](https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw) and [OpenClaw Hermes migration](https://docs.openclaw.ai/install/migrating-hermes). Installed versions determine supported capabilities; newer documentation does not expand this evaluated contract.

## Evidence, interruption and privacy

State 12 retains preparation receipts and forward-gates reviewed project authority. Earlier file workspaces receive a mode-0600 before-v12 SQLite copy. Account creation and activation receipts commit in one transaction. Repeated activation returns the same account only for the same digest, credential choice and reviewed project. Changed decisions are refused.

Preparation holds the existing execution checkpoint and cooperative source-profile lease. Source identity/binding, native source files and staged files are rechecked before activation. Symbolic links, hard links, unowned or aliased paths, files above 16 MiB, more than 6,000 entries and totals above 128 MiB are refused. These checks protect cooperative local use; they are not an adversarial filesystem snapshot or proof that external native clients have stopped.

Private profile directories use mode 0700, verified files mode 0600. Native reports and backups stay in the private operation directory. Snapshot summaries include counts and metadata, not memory contents or raw native reports. Git and Work Capsules exclude `native-migrations` directories. Native source text is hashed rather than copied into canonical metadata.

Shutdown aborts and drains a running utility before closing storage. Restart marks interrupted preparation failed and never replays it. Partial profiles stay inactive and private for inspection. Dismissal keeps those files; it does not acquire authority to delete native data. Finite native CLI utilities are timeout/output bounded, but this path does not establish signed cold-crash closure or whole-family resource containment for those utilities.

## Coverage limits

The native importers determine compatibility. Native entry grouping can change: the evaluated Hermes reverse importer groups an imported paragraph that can contain several facts. Hermes replace/remove acts on that native entry. Review its current entries and use its native atomic batch to preserve unrelated facts during correction. Forge does not promise identical entry IDs or edit granularity across memory engines.

Hermes memory caps can put entries in an overflow archive: preserved entries outside active memory are counted and shown explicitly. Native scheduled definitions may be archived; migration does not transfer scheduler ownership, activate runnable jobs, preserve channel credentials, or reproduce every provider's search/index/tool/policy state. Hidden conversation state, external memory services, remote effects and unsupported plugins need their own native review. Full-framework acceptance remains in [the completion audit](COMPLETION_AUDIT.md).
