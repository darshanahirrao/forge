# Background workspace on macOS

Forge can run outside Codex and start at login through the native macOS user service manager, launchd. It runs the same local application, private SQLite workspace and optional phone gateway. No model loop, native scheduler or new process supervisor is added.

This is an opt-in user login service. The Mac must be awake and you must be logged in. It does not keep a sleeping laptop online or provide mobile push notifications. Linux and Windows use the foreground application until their native service backends are implemented and verified.

## Install and start

From the Forge source directory, with Node.js 24 or newer:

```sh
npm ci
npm run build
node bin/forge.mjs service install
```

Installation creates the private receipt and matching `~/Library/LaunchAgents/org.forgeworkspace.forge.WORKSPACE_HASH.plist` definition. It does not immediately start a second service. Stop your foreground Forge process with Ctrl+C, then run:

```sh
node bin/forge.mjs service start
node bin/forge.mjs service status
```

Open the returned local URL. Connections shows whether this process is running in the foreground or through the user service. No Codex window or browser tab is needed for the service to remain running. UI-driven resource sampling remains on demand.

For an existing nondefault workspace, pass `--data-dir /absolute/private/directory` to every command and pass `--port` during installation. The state directory must be private and owned by your user. Start refuses an occupied port or an active/unconfirmed SQLite workspace owner. The server still acquires its exclusive native SQLite lock after those preflight checks.

Phone options on `service install` match foreground startup: `--phone-origin`, repeated `--phone-user` and `--phone-port`. Native Tailscale Serve setup remains separate. See [private phone access](PHONE_ACCESS.md).

## Identity, credentials and installation changes

The native definition runs the absolute Node executable and source checkout used during installation. Keep both available. After changing build output, stop and restart the service to avoid serving an old asset registry against newly hashed files. Moving the checkout, changing its Node path or changing ports requires an explicit uninstall and reinstall while idle; private work is preserved.

The receipt and logs use mode 0600. Installation records HOME, PATH, LANG and selected absolute native runtime overrides (`FORGE_HERMES_PYTHON`, `FORGE_OPENCLAW_BINARY`, `FORGE_OPENCLAW_NODE`). It does not copy provider keys, shell profiles, `.env` files or arbitrary environment variables. Node preload options are cleared in the native definition before startup. The runner reconstructs its narrow environment from the checked receipt.

Existing native configuration and credential stores remain authoritative. An API slot requiring a provider-key environment variable cannot obtain that variable from your old terminal after this transition. A native secret-reference bridge for those variables remains a delivery gate. Do not put keys in the receipt or plist. Native-profile authentication in a background login context needs its own live-provider verification.

A configuration digest binds the receipt settings into the native argument list. Controls require the private receipt, matching digest, exact unchanged plist, canonical native origin, executable and complete argument list. Running status also requires the installed ID, label and native job PID to match the responding Forge health endpoint. A foreign label or changed definition receives no start, stop or deletion. These checks establish cooperative local installation ownership; they are not protection against an attacker controlling the same user account.

## Stop, restart and remove

```sh
node bin/forge.mjs service stop
node bin/forge.mjs service restart
node bin/forge.mjs service uninstall
```

Stop requests native shutdown and waits briefly for settlement. Active work loses approval authority and follows its existing driver cleanup. The native definition allows 360 seconds before launchd's forced shutdown, covering the evaluated OpenClaw cleanup budget. If cleanup is still pending, the command returns `stopping` and retains configuration. Check status and retry the intended restart/removal after native cleanup. No replacement worker is started while SQLite still has an owner.

Stop unloads this login's service; its installed login definition remains and can run at the next login. Uninstall removes the verified definition and receipt after shutdown. It preserves workspace SQLite, native references, history and private logs. It never deletes native harness profiles or kills an arbitrary saved PID.

launchd restarts abnormal exits with a 30-second throttle. Forge's existing startup recovery marks unfinished work interrupted and preserves unconfirmed native exits. Restarting the workspace does not replay inputs, old approvals or external effects and does not adopt old native workers.

Private `.forge-service.stdout.log` and `.forge-service.stderr.log` files live in the selected data directory. Startup diagnostics are deliberately limited; request/native transcripts are not logged by this service integration. Automatic log rotation remains open. Unconfirmed state or definition edits require review, not an automatic ownership reset.

## Evidence

`npm run test:native:service` is an explicit macOS-only check against actual launchd. It registers a temporary owned definition outside the login auto-load directory, starts the compiled application, creates idle fixture work, verifies graceful restart and abnormal-exit restart, stops/removes its own native service and checks private state retention. It uses no model calls or credentials and removes its temporary test state after native removal is confirmed. A failed/unconfirmed cleanup retains the fixture for review.

Functional checks cover unsupported platforms, private file/argument generation, provider-key exclusion, changed/foreign definitions, exact native arguments, symlink handling, occupied ports, an active SQLite owner and pending-shutdown configuration retention. Browser checks cover the setup and running states, both themes, mobile, keyboard access, overflow and axe. Actual next-login behavior, managed model work during OS logout, live native credentials, native Linux/Windows service managers, laptop sleep and push delivery remain unverified or unimplemented.

The implementation follows Apple's [launchd job guidance](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) and its [native property-list contract](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5), checked against the installed `launchctl` help and `launchd.plist` manual. The app-wide completion boundaries remain in [the full audit](COMPLETION_AUDIT.md).
