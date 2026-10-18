# Security

Forge is an early local application with native execution privileges. The current supported release line is the latest public alpha. Security fixes go to that line; older checkpoints are retained for recovery.

Report a vulnerability through [GitHub private vulnerability reporting](https://github.com/darshanahirrao/forge/security/advisories/new). Include the affected Forge/native version, a minimal fictional reproduction and the expected access boundary. Exclude credentials, personal conversations, private memory, native profile contents and raw workspace databases. Use public issues for ordinary bugs.

## Trust boundaries

- The default listener binds to 127.0.0.1 for the local OS user. Host/origin checks and mutation tokens protect browser requests; they do not isolate Forge from another process or user with access to the host.
- Native tools execute with the selected native profile and the local user's privileges. Permissions, sandboxing, tools and authentication remain native. An approval authorizes the displayed request; it does not sandbox all future external effects.
- Local extension modules are explicitly trusted Node.js code with host privileges. Entry/contract fingerprints detect supported binding changes, but do not attest every transitive dependency. Review modules and their dependencies before loading them.
- Credential references point to private native files or supported OS credential storage. Forge does not provide tenant isolation, a shared public agent server or a credential broker for unrelated users.
- Phone access requires the documented private Tailscale Serve route and owner allowlist. Keep the phone gateway on loopback. Do not expose Forge through a public proxy or Tailscale Funnel.
- Usage figures, native limits and spending admission have explicit evidence scopes. They are not provider invoices or universal spending ceilings.

## Data and recovery

Workspace state, proof files, native profile references and backups are private local data. Keep the data directory outside public repositories and shared cloud folders. Memory exports and diagnostics can contain selected project content or local metadata; review them before sharing.

Before an upgrade, stop managed work and the original Forge host, then back up the complete private data directory together with any separately owned native profiles. Retain worker proofs and ownership markers. A newer database cannot necessarily be opened by an older release. Do not remove recovery holds or private markers to force a restart.

Read the [alpha guide](docs/PUBLIC_ALPHA.md), [native recovery contract](docs/NATIVE_RECOVERY.md), [phone setup](docs/PHONE_ACCESS.md) and [full audit](docs/COMPLETION_AUDIT.md).
