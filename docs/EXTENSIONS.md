# Native runtime extensions

Managed turn providers also use this loading/host-trust contract. See [native harness extensions](NATIVE_HARNESS_EXTENSIONS.md) for the public execution driver and account-reader contract.

Forge can load a native companion provider from an explicitly configured local Node module. It appears in Accounts and Connections and uses the existing profile, scoped MCP context, runtime review, original-child supervision, resources, stop, recovery and companion-handoff controls. There is no separate work database, approval inbox, model loop or tool implementation.

Build once, then load the included working example:

```sh
npm run build
node bin/forge.mjs start --extension ./examples/hermes-runtime-extension.mjs
```

The example aliases the existing installed Hermes adapter through the public SDK. Linking a slot does not start Hermes. In Connections, choose **Link an account** beside the provider, select an existing dedicated native home, create scoped companion access, link the native runtime and review its start. Native tools, model configuration, memory, channels, permissions and scheduling remain in that profile. Multiple slots may use the same provider with separate native homes. Forge account identity and allowance remain unknown until an appropriate native integration reports them.

Repeat `--extension` for another module. Explicit flags replace the environment's module list. `FORGE_EXTENSION_MODULES` accepts a JSON array of absolute entry paths. Native service installation also accepts repeated `--extension` options and retains those paths in its private reviewed configuration, excluding provider keys and shell injection variables. The foreground-to-background review preserves the same configuration. Service preparation reads no module code and executes no extension.

## Public contract

Import from `@forge-workspace/forge/sdk` in an installed or linked package, or author an example inside this checkout. Public JavaScript and TypeScript declarations are built together. The SDK exports `defineExtension`, the existing Hermes/OpenClaw native adapters, `nativeCompanion`, original-spawn types and selected credential helpers. Loading the SDK by itself starts no server or native process.

```js
import { defineExtension, hermesCompanion } from '@forge-workspace/forge/sdk';

export default defineExtension({
  format: 'forge.extension',
  version: 1,
  id: 'example.hermes-runtime',
  name: 'My native runtime',
  release: '1.0.0',
  companions: [{
    id: 'ext.example.hermes',
    name: 'Hermes through my extension',
    contract: 1,
    nativeVersion: '0.17.0',
    profileFiles: ['config.yaml', '.env', 'cron/jobs.json'],
    connect: hermesCompanion,
  }],
});
```

Provider IDs must be unique, start with `ext.` and differ from installed ACP connector IDs. Each provider declares its evaluated native version and the bounded native profile files that must match launch review. An account stores the provider ID, extension identity/release and a digest of the module entry and declared native contract. Changed or missing bindings refuse new starts and probes; existing slots, work, profiles, attribution and original exit evidence remain retained. Link a reviewed current slot rather than silently replacing old execution authority.

Runtime-only providers are not advertised as managed turn executors. A generic harness that speaks ACP uses the existing separately reviewed [native connector contract](NATIVE_CONNECTORS.md), with a distinct versioned ID. Generic native runtimes connect to Forge's existing [scoped MCP interface](COMPANION_ACCESS.md). Canonical work/profile identity, selected memory and finite operation lineage survive an existing [companion handoff](COMPANION_HANDOFF.md). Native memory engines, schedules and hidden histories need their respective native migration contracts; declaring a provider does not assert their equivalence.

For another runtime, implement `connect(account, root, credentials, spawn)` using its installed public interface. The SDK's `nativeCompanion` helper acquires the native profile lease, starts the original signed child through `spawn`, waits for a finite native readiness probe and provides original-handle stop. Supply an explicit command, argument array, narrow environment, evaluated version and a probe that checks the native runtime's own readiness/version and observes its abort signal. It supplies no browser, filesystem, terminal, planner, inference or scheduling tools. Native readiness probes are bounded, and a stopped or timed-out startup cannot later use the retained spawn hook to create a replacement root.

Modules initialize once at startup, with a ten-second initialization deadline. Extension native starts have a 45-second readiness deadline and respond to explicit stop. The original native cleanup budget and signer remain authoritative after a child starts. Uncertain closure stays held; no native prompt or gateway is automatically replayed. Forge acquires its existing exclusive SQLite owner and checks forward compatibility before extension initialization, preventing a second host or older reader from running extension startup code against that workspace.

These are explicitly trusted local Node modules running with the host's privileges. They must remain thin native adapters and must not start workers at module top level. This is not a sandbox or a downloaded-plugin installer. Entry fingerprints bind provenance and declared versions, not every transitive dependency; evaluate and version dependencies and verify the actual native runtime version in the adapter. Entry files must be owned regular files, at most 1 MiB, without group/world write access; symlinks, hardlinks, changed entries, duplicate IDs and unsupported contracts are refused. Keep secrets in native profiles or existing reviewed private credential references rather than extension source.

## Evidence and scope

Functional checks cover module/ID/format/file bounds, local account authority, immutable bindings, real original-child signed closure, retained work/profile context, changed-extension restart holds, nonresponding-start cancellation and native service configuration without module execution. Package checks import the actual public SDK, compile a real TypeScript consumer, start the CLI with an extension without creating native work and verify future-version/existing-owner refusal before module initialization.

The browser flow links an ordinary extension account, reviews and starts its runtime, follows its existing resource controls, stops the original child and preserves unknown provider identity/allowance across both themes and phone/desktop layouts. Opt-in `npm run test:native:extension` loads the public example module and runs the actual installed Hermes gateway, stops it with signed closure, hands the same canonical work/profile/selected memory to OpenClaw and closes the second original gateway. Native configured interfaces, memory and configuration remain unchanged; model requests are zero. OpenClaw installation overrides match the other [native conformance commands](../tests/native/README.md).

General UI/layout/host/channel/policy packages, arbitrary native history/provider-store equivalence, foreign process adoption and real provider/device acceptance are separate full-vision requirements. State 14 protects extension-bound account/runtime authority from earlier readers and retains a private before-v14 copy.
