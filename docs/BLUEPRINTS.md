# A workspace people can shape

Product proposal, 16 October 2026. The user wants anyone to mold Forge around their own work. This extends beyond changing models or selecting a harness.

## Shareable workspace blueprints

A blueprint describes an arrangement of existing components: agent profiles, runtime and harness choices, memory-source references, tools and skills, workflows, native schedule references, dashboard views, resource preferences, budget preferences, and decision-delivery channels. Keep workspace data separate from the blueprint so changing the arrangement preserves work history.

One person could use Hermes, Codex, Obsidian, and phone notifications. Another could use OpenClaw, OpenCode, an existing external memory provider, and a terminal-oriented view. Their configurations should not require maintaining separate forks of Forge.

Blueprints refer to existing capability implementations. They do not carry a new browser, computer-use engine, terminal, model client, or memory engine. Prefer compatible existing preset and manifest formats before defining a new schema. The format and packaging remain to be selected after the reuse audit.

## Three levels of customization

- **Presets:** a clear default and optional arrangements for personal work, development, or operations. A preset configures existing services and native workflows.
- **Configuration:** change runtime bindings, memory scopes, tools, native workflows, views, notification preferences, and supported resource/budget policies without changing core code.
- **Extensions:** add an adapter, panel, data source, or workflow package through a versioned contract. Reuse an upstream extension mechanism when it fits. Ordinary customization should not require a fork; the MIT license still permits forks.

Expose useful defaults first. Keep deeper choices accessible rather than showing every available setting on the home screen. The default experience and the extension model are separate design concerns.

## Sharing and portability

Export a sanitized blueprint with dependency versions, required capabilities, source ownership, and environment requirements. Credentials, private memory content, native sessions, machine identifiers, live approval tokens, and billing records are excluded. Importers connect their own accounts and choose their own data sources.

Preview required access and missing dependencies before activation. Validate compatibility, retain a rollback reference, and transfer active bindings at a supported boundary. Layout changes can be immediate; changing an executing runtime or memory backend has different state requirements.

Community packages should be inspectable, pinned, and optional. Installing a package does not grant access to private memory, credentials, or native execution. Existing provider permissions remain authoritative.

## Experience ideas to prioritize

1. **Connect the setup already in use.** Discover supported installations and present a read-only inventory before requesting migration or changing configuration. Surface incomplete discovery honestly.
2. **A calm home.** Show work in progress, decisions requiring attention, and upcoming activity. Resource and cost details are available from the work that caused them.
3. **Explain a stall.** Join native evidence into a concrete reason: pending approval, unavailable capability, provider error, or insufficient managed capacity. Preserve uncertainty when the source is incomplete.
4. **Budget attention as well as compute.** Group notifications by work and delegated scope. Keep approval identities separate and honor expiry; grouping a display must not imply bulk authorization.
5. **Evaluate cost per accepted outcome.** Include failed attempts, retries, and coordination overhead where supported. Suggest routes using observed outcomes and compatibility rather than a universal model leaderboard.
6. **Inspect a switch before making it.** Show which capabilities, data, policies, and native services remain compatible. Keep the same visible work record after a verified continuation.

These are experience priorities, not claims that every mechanism is new. Evaluate existing implementations first and build only the remaining gap.
