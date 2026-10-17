# Private phone access

Checkpoint `forge-v0.8.0`, 17 October 2026. The same Forge workspace and exact native approval inbox can be served through an opt-in private gateway. Forge reuses Tailscale Serve for HTTPS, network access and identity, and MIT `@fastify/http-proxy` 11.6.4 for forwarding. There is no separate mobile app, login service, relay, model loop or second workspace database.

## Configure the native transport

Install and sign in to native Tailscale on the laptop and phone. Follow [Serve setup](https://tailscale.com/docs/features/tailscale-serve) for HTTPS and tailnet access policy. Find the laptop's exact tailnet DNS name and the login identity you intend to approve. The configured identities receive the same owner authority as local Forge access, including work, account references and native launch controls. This is a personal owner workspace, not a team permissions system.

Inspect existing mappings with `tailscale serve status` first. Use an unused HTTPS port so another app's route stays intact. The example uses port 8443:

```sh
npm ci
npm run build
node bin/forge.mjs start \
  --phone-origin https://your-laptop.your-tailnet.ts.net:8443 \
  --phone-user you@example.com
```

Forge still listens locally on `127.0.0.1:4710`. The additional gateway listens only on `127.0.0.1:4712`. In another terminal, point the native private proxy at that gateway:

```sh
tailscale serve --https=8443 --bg http://127.0.0.1:4712
```

Open the exact configured HTTPS URL on the connected phone. Port 443 is also supported by omitting the port from `--phone-origin` and using `--https=443`. If native Serve requests HTTPS consent, complete its own setup. The [native CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve) describes persistent `--bg` mappings and targeted `off` commands. Forge does not change existing Serve routes, install Tailscale, sign in, enable Funnel or automatically install an OS startup service. The separate [opt-in macOS user service](BACKGROUND_SERVICE.md) can keep Forge running outside Codex.

Repeat `--phone-user` for another explicitly trusted owner. `--phone-port` changes the private gateway listener; update the native target to match it. Environment equivalents are `FORGE_PHONE_ORIGIN`, comma-separated `FORGE_PHONE_USERS` and `FORGE_PHONE_PORT`. The origin must be an exact HTTPS `.ts.net` origin without a path, query or credentials. Explicit HTTPS ports at least 1024 are supported alongside the default 443. This route accepts exact ASCII native login names. Tagged devices without user identity and unknown owners are denied.

Keep the local API on loopback and point Serve at the gateway port, never the local API port. Public Funnel does not supply the required native user identity and is not a supported transport. A locally installed untrusted process can impersonate HTTP identity headers; the host account remains inside the trust boundary. Native identity stripping and private network policy are supplied by Serve, not recreated in Forge.

## What the gateway enforces

Every request requires a loopback proxy connection, an expected host and an explicitly approved native `Tailscale-User-Login`. Foreign origins and cross-site API requests are rejected; authenticated top-level navigation from a private link is allowed. Mutations require the exact configured HTTPS origin and the existing per-start Forge CSRF token. Incoming authority/forwarding headers are discarded. The co-owned gateway attests the verified identity to the local API with a random process-only proof; supplying a native identity header directly to the API confers no authority. No bearer secret is placed in a URL, browser storage or setup export.

The maintained proxy targets only the owned loopback service, streams the existing UI/API and disables request retries. Both listeners stop with Forge. Access errors and private data remain non-cacheable under the same restrictive browser policy as the local workspace. Restarting without phone options disables the gateway; changing the approved owner list takes effect on restart. Remove the specific Serve mapping through its native `off` command after checking current status; do not reset unrelated routes.

Approval delivery still checks the exact native request, payload digest, work generation, session/turn binding, expiry and withdrawal. The authenticated reviewer is recorded before native delivery and remains attached if delivery becomes uncertain. The gateway cannot revive an expired request, create a permanent grant, or make a recorded decision proof of native execution. The mobile dialog shows remaining review time and the recorded reviewer. Hermes's shorter native deadline still applies.

## Evidence and remaining work

The functional checks exercise actual HTTP forwarding, owner/origin/CSRF/host rejection, header replacement, forged direct API identities, exact decisions, stale replay and disabled retries. A compiled CLI check starts both listeners in an isolated workspace, reads the same workspace through the private gateway, performs a protected change and confirms both listeners exit together. The production CLI version/help now comes from the package manifest.

The browser check runs the actual built UI over a temporary local HTTPS proxy that simulates native Serve's header contract. It reviews the same native fixture request on a narrow screen, records the owner identity, displays decision history and refuses replay; axe and light/mobile-dark captures pass. The opt-in actual Codex conformance routes its one-time decision through the real gateway and verifies the artifact produced by the native tool. Model inference stays loopback-only and uses no paid provider.

These tests establish the local TLS/UI/API/native-decision path. Tailscale is not installed or connected in the development environment, so actual tailnet authentication, a physical phone and remote-network behavior remain unverified. Optional [ntfy notifications](NOTIFICATIONS.md) now publish generic alerts with the configured private review address; HTTP acceptance is separate from device delivery. The separately tested opt-in macOS user service provides background availability; it is not automatically installed for the private workspace. Forge must be running on an awake host. Preserve the live-device gaps in the [full completion audit](COMPLETION_AUDIT.md).
