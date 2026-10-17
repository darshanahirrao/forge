# A workspace people can shape

The v0.17 local application implements version-1 setup import, review, activation and unused-import rollback. The wider proposal below remains a roadmap: people should be able to mold Forge around their own work beyond choosing a model or harness.

## Implemented local flow

Open **Connections → Workspace blueprints** and select a JSON file up to 256 KiB. The existing version-1 setup export remains compatible. The [native workspace example](../examples/native-workspace.json) adds named profiles, instructions and a ready work template without including a credential or private path.

Bind account roles to your existing native slots, memory roles to existing selected references, and project roles to local directories. Harness and billing mode must match. Native driver IDs remain open through connected backends. Memory keeps its owner and scope; project/work references outside the imported work remain excluded and appear as warnings. An activity reference does not grant companion control. Configure native MCP access separately.

Review the exact profile instructions, work goals/context, local account and resolved directory before activation. Selected memory is reread and checked within its existing scope. Native identity/model/home references, selected content and directories are checked again before commit. A preview expires after ten minutes. Repeated/concurrent activation returns one persisted receipt, including after importer restart. Profiles, ready work, selected preferences and that receipt commit in one SQLite transaction.

Workspace preferences are opt-in during import. The default preserves your current memory protection. Import starts no native task, creates no account or companion grant, rewrites no native file and activates no schedule. The existing default profile and work remain intact. Changes to existing work and active native bindings continue through their ordinary review/handoff flows.

Recent imports offer **Roll back unused import**. Only unchanged initial work and profiles can be removed. Native runs, later edits/checkpoints, other work referencing a profile, active companion grants or changed imported preferences block rollback. Source files, native accounts and memory references retain their owners. A rollback tombstone keeps retry behavior idempotent.

The machine-readable schema is `GET /api/blueprints/schema`. Human, CSRF-protected local-workspace APIs are `POST /api/blueprints/parse`, `/inspect` (definition and bindings), `/apply` (plan ID and digest) and `/api/blueprints/:id/rollback`; `GET /api/blueprints/imports` returns bounded receipt history. Bindings use `accounts`, `profiles` (local names), `memories`, `companions`, `projects` and `applySettings`. A memory binding key is `<profile-role>:memory:<one-based-index>`. The TypeScript contracts are in [shared/blueprints.ts](../shared/blueprints.ts).

The optional `workTemplates` array names a role, title, goal, optional acceptance/context and the `accountRole`, `profileRole` and `projectRole` it uses. Profile `name` and `instructions` are also optional. The default setup export deliberately excludes existing private instructions and work contents; hand-authored templates are reviewed as new setup. Unknown executable hooks, secrets/grants, unsupported versions and undeclared binding roles are rejected.

This implements profile/reference/work-template activation. General extension packaging, layout/plugin imports, host provisioning, schedule transfer, dollar policies and native memory-provider migration remain open. Blueprints do not transport hidden native session state.

## Shareable workspace blueprints

A blueprint describes an arrangement of existing components: agent profiles, runtime and harness choices, memory-source references, tools and skills, workflows, native schedule references, dashboard views, resource preferences, budget preferences, and decision-delivery channels. Keep workspace data separate from the blueprint so changing the arrangement preserves work history.

One person could use Hermes, Codex, Obsidian, and phone notifications. Another could use OpenClaw, OpenCode, an existing external memory provider, and a terminal-oriented view. Their configurations should not require maintaining separate forks of Forge.

Blueprints refer to existing capability implementations. They do not carry a new browser, computer-use engine, terminal, model client, or memory engine. Prefer compatible existing preset and manifest formats before defining a new schema. The local application imports and exports its version-1 setup manifest with reviewed local bindings; richer packaging and upstream preset compatibility remain to be evaluated. See [RUNTIME.md](RUNTIME.md).

## Three levels of customization

- **Presets:** a clear default and optional arrangements for personal work, development, or operations. A preset configures existing services and native workflows.
- **Configuration:** change runtime bindings, memory scopes, tools, native workflows, views, notification preferences, and supported resource/budget policies without changing core code.
- **Extensions:** add an adapter, panel, data source, or workflow package through a versioned contract. Reuse an upstream extension mechanism when it fits. Ordinary customization should not require a fork; the MIT license still permits forks.

Expose useful defaults first. Keep deeper choices accessible rather than showing every available setting on the home screen. The default experience and the extension model are separate design concerns.

## Sharing and portability

Export a sanitized blueprint with dependency versions, required capabilities, source ownership, and environment requirements. Credentials, private memory content, native sessions, machine identifiers, live approval tokens, and billing records are excluded. Importers connect their own accounts and choose their own data sources.

Preview required access and missing dependencies before activation. Validate compatibility, retain a rollback reference, and transfer active bindings at a supported boundary. Layout changes can be immediate; changing an executing runtime or memory backend has different state requirements.

Blueprints can define account roles and ordered routing preferences, such as a preferred coding account followed by eligible alternatives. Each importer connects their own native accounts and authorizes project data scopes and billing modes. Export role labels and requirements rather than private account identifiers, quota records, or credentials. See [ACCOUNTS.md](ACCOUNTS.md).

Community packages should be inspectable, pinned, and optional. Installing a package does not grant access to private memory, credentials, or native execution. Existing provider permissions remain authoritative.

## Experience ideas to prioritize

1. **Connect the setup already in use.** Discover supported installations and present a read-only inventory before requesting migration or changing configuration. Surface incomplete discovery honestly.
2. **A calm home.** Show work in progress, decisions requiring attention, and upcoming activity. Resource and cost details are available from the work that caused them.
3. **Explain a stall.** Join native evidence into a concrete reason: pending approval, unavailable capability, provider error, or insufficient managed capacity. Preserve uncertainty when the source is incomplete.
4. **Budget attention as well as compute.** Group notifications by work and delegated scope. Keep approval identities separate and honor expiry; grouping a display must not imply bulk authorization.
5. **Evaluate cost per accepted outcome.** Include failed attempts, retries, and coordination overhead where supported. Suggest routes using observed outcomes and compatibility rather than a universal model leaderboard.
6. **Inspect a switch before making it.** Show which capabilities, data, policies, and native services remain compatible. Keep the same visible work record after a verified continuation.

These are experience priorities, not claims that every mechanism is new. Evaluate existing implementations first and build only the remaining gap.

The setup export now includes the generic `memoryPressurePolicy` choice (`protect` or `observe`). It carries no machine measurements or private work. An absent policy defaults to protecting against reported macOS warning/critical pressure; the importer applies that preference only after the explicit workspace-preferences choice.
