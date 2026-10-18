# Public alpha

Forge v0.40.0 is an installable open-source alpha for individual developers on macOS and Linux. It provides a local workspace over existing native tools. The full product vision remains in [COMPLETION_AUDIT.md](COMPLETION_AUDIT.md); publishing this alpha does not close those gates.

## Install a release

Install Node.js 24 or newer. Download the .tgz archive and SHA256SUMS from the [v0.40.0 release](https://github.com/darshanahirrao/forge/releases/tag/forge-v0.40.0).

In the download directory, verify the archive:

```sh
# macOS
shasum -a 256 -c SHA256SUMS
# Linux
sha256sum -c SHA256SUMS
```

Then install the downloaded file:

```sh
npm install --global --omit=dev --ignore-scripts ./forge-workspace-forge-0.40.0.tgz
forge doctor
forge start
```

Open http://127.0.0.1:4710. Stop foreground Forge with Ctrl+C. Use a Node installation with a user-writable npm prefix; do not run Forge as root. The archive contains the compiled app, native helper files, typed SDK, examples, documentation and a dependency shrinkwrap. No build or developer tools are needed after archive installation. The install command disables install-time scripts.

The npm registry is not a release channel yet. Use the versioned GitHub archive or source.

## Run from source

```sh
git clone https://github.com/darshanahirrao/forge.git
cd forge
git checkout forge-v0.40.0
npm ci
npm run build
node bin/forge.mjs doctor
npm start
```

Doctor is read-only: it checks Node/SQLite availability, production dependency entry points, compiled assets/helpers and optional command presence on PATH. It does not open the workspace, read native profiles or credentials, execute those commands, check login/limits or contact providers. Missing optional native tools do not prevent opening Forge. Run forge doctor --json for the same scoped report as JSON.

## First useful session

1. Open Forge. The real workspace starts empty; the separate labeled demo uses fictional work and never starts native execution.
2. Create a work record with a goal and existing project directory. Saving work needs no model account.
3. Add a native account slot in Accounts. Install, configure and sign in through that native harness first. Select its native profile and private reference when required, then use its account check.
4. Create a profile and select Markdown memory. Review the selected context and account in the launch dialog before a managed turn.
5. Use the shared approval inbox for supported native requests. Inspect Resources and usage evidence. Save a checkpoint before a reviewed account/harness handoff.

The work detail shows recorded native attempts. Choose Share receipt to review an allowlisted public summary, then copy or download it. Nothing is uploaded. Read [the receipt contract](PUBLIC_RECEIPTS.md) and [the actual native handoff example](NATIVE_HANDOFF_EXAMPLE.md).

Forge adds no model subscription. Native account policies and capability checks apply. Read the integration-specific setup before enabling execution.

## Support matrix

| Surface | Alpha coverage |
| --- | --- |
| Core workspace | Persistent work/profiles, selected memory, approvals, account references, scoped usage/budgets and restart retention |
| macOS | Foreground app and evaluated native integrations; optional reviewed launchd; native memory pressure admission |
| Linux | Node 24 CI, clean archive installation, workspace/restart/assets and native Linux PSI checks; foreground operation |
| Windows | Outside alpha acceptance; original-worker execution and native OS governance are unavailable |
| Codex | Experimental app-server execution, exact supported approvals and same-profile completed-chat fork on evaluated versions |
| Claude | Experimental official Agent SDK with supported API authentication; claude.ai subscription execution stays in the native client |
| OpenCode | Experimental evaluated v2 client/server profiles; configured capabilities must match |
| Hermes | Evaluated 0.17 ACP execution, selected native memory and optional reviewed runtime/schedule integration |
| OpenClaw | Evaluated 2026.10.4 Gateway execution/runtime/schedules; dedicated native execution profile |
| More providers | Trusted typed runtime/execution extensions and reviewed ACP connectors; each adapter needs its own conformance |
| Phone and alerts | Optional private Tailscale Serve and ntfy paths; real device/tailnet/push acceptance remains open |

Native fixtures use real installed tools with deterministic local inference. They establish protocol/tool/artifact behavior, not live subscription isolation, invoice accuracy or arbitrary model quality. Doctor does not certify a native version.

## Known limits

- Work, profiles, selected context and receipts remain canonical. Arbitrary hidden native state cannot move losslessly across accounts/harnesses. Strict T3/Codex native-history continuation remains a failed compatibility gate.
- Resources attribute supported owned workers and hold new launches on known native memory pressure. There is no universal whole-family cap or arbitrary foreign-process cleanup.
- Hermes/OpenClaw transfers cover the documented basic schedule intersection and selected file-backed native memory routes. Rich scripts/models/channels/dependencies and external memory engines need more integration.
- Modules have host privileges. General UI, host, layout, channel and policy packages are unfinished.
- Real provider/quota/invoice, physical phone/push, locked-login and OS logout/shutdown acceptance remain open.

## Upgrade and remove

Before upgrading, stop managed work, then stop the original host or reviewed service. Back up the complete private data directory and separately owned native profiles while inactive. Retain proof/ownership files and recovery holds. Install the chosen archive, run doctor and reopen the same directory. Older binaries refuse newer state; rollback may need the matching inactive backup. State remains version 16 in v0.40.

Use forge start --data-dir DIRECTORY --port PORT for a separate workspace and loopback port. The default data root is ~/Library/Application Support/Forge on macOS or the forge directory beneath $XDG_DATA_HOME (default ~/.local/share) on Linux. Startup services, native jobs, provider logins, phone access and notifications are opt-in.

Remove an installed native service through its reviewed controls before uninstalling. Run npm uninstall --global @forge-workspace/forge to remove the global package. This preserves private workspace data and native installations.

For ordinary bugs, include the Forge version, OS/Node version, redacted doctor report and fictional reproduction in [an issue](https://github.com/darshanahirrao/forge/issues/new/choose). Follow [SECURITY.md](../SECURITY.md) for private security reports. Review diagnostics and selected memory before sharing.
