# Native OpenCode execution

Checkpoint `forge-v0.6.0`, 17 October 2026. Forge reuses OpenCode v2's installed CLI and MIT `@opencode/client` 2.0.6. OpenCode supplies its model loop, native agents, tools, project configuration, permissions, sessions and provider connections. Forge supplies the work/profile binding, admission, review surface, selected context and usage projection. The adapter accepts the v2.0 protocol family; native 2.0.6 and 2.0.31 were tested. V1 is a different interface and is not silently substituted.

## Configure a native profile

Use a dedicated profile root for each native account configuration. It contains four XDG homes, rather than only an OpenCode config directory. Forge references these files without copying another account's credentials. Two slots referencing the same profile or provider can still share identity and limits.

For example, create an empty root and open the existing native client to configure it:

```sh
FORGE_OPENCODE_PROFILE="$HOME/.local/share/forge/native/opencode-personal"
mkdir -p "$FORGE_OPENCODE_PROFILE/config/opencode" "$FORGE_OPENCODE_PROFILE/data/opencode" "$FORGE_OPENCODE_PROFILE/state" "$FORGE_OPENCODE_PROFILE/cache"
env XDG_CONFIG_HOME="$FORGE_OPENCODE_PROFILE/config" \
    XDG_DATA_HOME="$FORGE_OPENCODE_PROFILE/data" \
    XDG_STATE_HOME="$FORGE_OPENCODE_PROFILE/state" \
    XDG_CACHE_HOME="$FORGE_OPENCODE_PROFILE/cache" \
    OPENCODE_DB="$FORGE_OPENCODE_PROFILE/data/opencode/opencode.db" \
    opencode --standalone
```

Use native `/connect` and `/models`. Set an explicit default model in `config/opencode/opencode.json` or the applicable native project configuration, such as `{"model":"provider/model"}`. Forge pins the resolved configured agent/model before admitting input; it does not silently select a catalog fallback. Native policies and configuration precedence apply. Exit the native client before using this root in Forge. Do not share the root concurrently with another client/server.

In **Accounts**, choose OpenCode, enter this root, and use native or API billing. An optional credential field accepts a provider environment-variable name only. Set its value outside Forge before starting the service. The worker receives that selected variable and a small system/network environment; other ambient provider keys, native config overrides and simulation flags are excluded. Native file credentials remain native. The profile check confirms a private v2 server, not a provider identity, subscription entitlement or quota. Subscription-required routing is unavailable; launches require explicit external/metered consent.

## Native ownership and recovery

Each launch owns a separate loopback server on a random port with an ephemeral Basic credential. Before input, the adapter verifies the native version and process ID and proves anonymous access receives 401. It never attaches to an existing global daemon. A SQLite ownership lease excludes other Forge workers using the same root until the child exits. This cooperative lease does not control arbitrary native processes.

Before starting a server, Forge reads only the native database's recovery metadata using read-only SQLite. Any suspended execution claim, queued input or pending background-job recovery prevents startup. Unknown schemas also stop startup. Forge does not clear native claims, invoke repair, or let a status check resume uncertain work. Reconcile through the native client first. A fresh profile needs no database migration by Forge.

Native events are volatile. The adapter follows the official CLI's event-stream pattern, verifies that its input became a native user message, waits for native settlement, and checks the matching final outcome. The experimental session log returned no durable records in the tested isolated setups and is not used as completion evidence. Stream loss blocks further native requests; reconnects do not replay input or decisions. Closing the transport alone does not release admission. The owned server must exit. Detached tools and external effects still require native reconciliation.

## Permission review

Forge converts resolved native allow rules to ask for the managed session and preserves ordered native denies. Native hard policies and saved native grants remain upstream. The selected session must begin without residual session permission rules. Temporary review rules are removed only after native root/descendant settlement, with native state checked before and after removal. A crash or conflicting native policy change can require reconciliation rather than reusing an uncertain overlay. The next attempt rebuilds rules from current native configuration so an old Forge ask rule cannot override a newly configured denial.

The inbox shows the exact native action, resource list, session/request/tool IDs and tool input. Descendant requests require a verified parent chain to the owned root. Immediately before delivery, Forge re-reads the pending native request and input. Acceptance sends `once`. Rejection sends `reject`, whose native semantics dismiss all pending requests in that session; sibling Forge inbox items are withdrawn. It never sends `always`. Interactive forms and requests without a reviewable tool identity receive no invented answer. These are native permissions operating with host authority.

## Evidence and limits

`npm run test:native:opencode` uses two real native profile roots and distinct synthetic credentials, with inference restricted to a loopback provider. The native tools create three verified artifacts, read the preceding artifact, preserve one work/profile and selected native memory, exclude an unselected section, retain two usage scopes, and confirm worker exit. Five exact HTTP approvals are exercised. A third run resumes the same native session with its prior tool history and keeps the same cumulative usage key. Native 2.0.6 and 2.0.31 pass this check.

The combined handoff check chains actual Codex, Claude API profile one, Claude API profile two, OpenCode and Hermes: five native runs, five verified files, one work/profile, selected memory, six native approvals and five account usage scopes. Unit checks cover changed payloads, session-scoped rejection, unowned requests, reconnects, missing input promotion, native recovery, temporary-policy cleanup and residual overlays. The browser flow checks profile setup and launch consent in both themes and on mobile.

Usage replaces a cumulative native session snapshot under an account/session key. Tokens retain OpenCode's input, output, reasoning and cache facets; dollar values are native provider estimates. They are not invoices or verified subscription capacity. Full native histories remain in OpenCode. Real model quality, live account/allowance isolation, automatic fallback, native descendant feature coverage and fencing of external effects remain open in the full audit.

Primary interfaces: [official client](https://opencode.ai/v2/docs/build/client/), [v2 API](https://opencode.ai/v2/docs/api), [permissions](https://opencode.ai/v2/docs/permissions/), [native providers](https://opencode.ai/v2/docs/providers/). Native recovery was reviewed against [the v2.0.6 restart implementation](https://github.com/anomalyco/opencode/blob/v2.0.6/packages/core/src/session/execution/restart.ts). Installed behavior and conformance evidence determine support.
