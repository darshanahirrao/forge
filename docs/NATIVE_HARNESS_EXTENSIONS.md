# Native harness extensions

Forge's public SDK can register managed native turn execution without core edits or an ACP bridge. Native harnesses keep their model loop, tools, skills, browser/computer use, permissions and conversation storage. Forge reuses the existing work/profile, approvals, selected context, spending, routing, resource and signed-recovery coordinator.

## Install and link

Build first, then load an explicitly trusted local module:

```sh
node bin/forge.mjs start --extension /absolute/path/to/extension.mjs
```

The example [native-harness-extension.mjs](../examples/native-harness-extension.mjs) aliases the existing Codex and Hermes drivers. It adds no tool or agent implementation:

```js
import { defineExtension, CodexDriver } from '@forge-workspace/forge/sdk';

export default defineExtension({
  format: 'forge.extension',
  version: 1,
  id: 'example.native-harness',
  name: 'Example native harness',
  release: '1.0.0',
  harnesses: [{
    contract: 1,
    id: 'ext.example.codex',
    name: 'Codex through extension',
    nativeVersion: 'Codex app-server',
    profileFiles: ['config.toml'],
    accountReader: 'codex',
    create: () => new CodexDriver(),
  }],
});
```

Connections lists native harnesses separately from companion runtimes. Link an explicit existing native profile, then select the account in ordinary work setup. Registration and linking start no native worker or model. Configure models/sign-in through the native client. Generic extension slots use native or API configuration with explicit metered/unreported choices; they cannot impersonate a required-subscription slot. The existing Claude Agent SDK route retains its API authentication restrictions.

The public SDK exports `NativeDriver`, `DriverContext`, `DriverSink`, `NativeApproval` and the existing Codex, Claude, OpenCode, Hermes and OpenClaw driver constructors. Reused drivers retain their native setup/version/profile restrictions. The installed native extension acceptance currently covers Codex and Hermes; other provider mappings require their own native checks.

## Driver contract

A module may declare `harnesses`, `companions`, or both. Native role IDs are versioned `ext.*` identifiers, unique across loaded harnesses, runtimes and installed ACP connectors. Entries retain the existing [explicit module loading, ownership, initialization and host trust rules](EXTENSIONS.md). There is no browser upload, package download, automatic discovery, module sandbox or new resident process. Entry/declared-contract fingerprints do not certify every transitive dependency.

`create(context)` returns one inert `NativeDriver`. The factory runs only after the coordinator's resource/context/credential/spending admission; constructing or importing a driver must not start a process. For a different native protocol, implement this interface around its installed public API:

- Start through `context.spawnNative`. Native execution extensions require the persistent original-child supervisor on supported macOS/Linux hosts. A second native root is refused by the existing owner.
- Await `sink.worker` before task input, sessions, turns, approvals or usage. Forward exact native request/session/turn identities and callback decisions. An extension cannot declare delegated execution ownership through this contract.
- Retain the native session ID for compatible continuation; use the existing explicit Work Capsule handoff when changing account or harness. Preserve real artifact reads and selected context. An alias does not make arbitrary native hidden histories interchangeable.
- Report native usage with correct cumulative/per-run scope and provenance. Unknown prices stay null. Forge namespaces the native key and harness; existing snapshot replacement, budgets, shared native quota buckets and uncertain spending remain authoritative.
- Resolve `close` only after the original native handle closes. Completed-without-worker evidence fails. Native root/stdio closure does not prove detached tools, remote jobs or external effects settled; existing human reconciliation still applies.

The coordinator maps an existing driver's internal harness identity to the extension's canonical ID while retaining the original account configuration. Only native identity/plan/quota evidence can update that account. Reused private credential material is rebound for the native adapter, never serialized, and disposed after native startup/finite checks. The original canonical reference/binding remains unchanged. This mapping adds no global credentials or subscription proxy.

## Account checks and immutable bindings

An optional `accountReader` names one existing built-in native reader: `codex`, `claude`, `opencode`, `hermes` or `openclaw`. A deliberate account check reuses its finite native authentication/configuration query and cleanup with the selected profile/credential. It starts no model turn. Native identity/quota timestamps are refreshed only by the actual reader. Named checks obey the shared native-operation exclusion plus fresh pressure/quiet admission. Existing native identity and shared quota scopes remain native evidence, not an invoice or a new allowance.

Without a reader, Check harness binding only validates the loaded module binding. It does not erase, retime or invent earlier native identity/quota evidence. A native driver can still report fresh identity before task input. Missing quota remains unknown and ordered routing needs the existing explicit unreported allowance.

Each account binds the declared module/provider/version/digest and reader role. Credential material, companion grants, account routes, blueprint previews and destination handoff checks include that binding. A changed or missing module holds new launches before a run/factory/model. The UI marks execution unavailable; old work, usage and signed recovery remain accessible. Link a reviewed current account and use the existing handoff rather than editing old authority. On unsupported supervision hosts the execution control stays unavailable.

Native clients keep ownership of their own configuration. In isolated acceptance, installed Codex initialized its Git-root trust record in the disposable profile; model/provider/credential settings stayed equal and the managed native turn still required its exact human command approval. Forge does not rewrite native trust/configuration files for this feature. Native version declarations and profile-file lists describe the module contract, not an automatic native-file migration or a guarantee that native initialization is inert.

State 16 preserves this execution authority and reader role. Upgrades create a private `before-v16` SQLite copy; the actual previous compiled reader must refuse state 16 without changing rows. Native profiles, proofs and external effects remain separate from a database rollback.

## Verification

After building:

```sh
npm run test:native:harness-extension
```

This uses the explicit public example and actual compiled SDK/framework with installed Codex and Hermes. A private JSON credential reaches only the selected loopback native provider. Native Codex produces a real artifact; the compiled host closes/reopens; an explicit capsule transfers the same work/profile/selected memory to native Hermes, which reads the artifact through its own tool and produces the continuation. Exact native approvals, disjoint managed resource attribution, separate native usage and two original signed closes verify. Configuration differences are bounded to the observed native initialization record. Unselected memory, paid calls and personal configuration changes are excluded. Set the existing native interpreter installation override when necessary, as described in [native conformance](../tests/native/README.md).

Functional cases cover module/role collisions, local setup, private credential rebinding/disposal, no-process linking, missing/changed bindings, retained account authority, duplicate usage snapshots, exact approvals, original closure and unsupported ownership. Browser coverage uses ordinary account/work/approval controls in both themes on desktop/phone and reconciles only its own inert fixture cost through the normal public review API.
