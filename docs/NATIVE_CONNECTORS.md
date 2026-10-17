# Native harness connectors

Register an installed ACP v1 agent in Connections without writing another provider-specific Forge driver. A versioned manifest binds the executable, arguments, native name/version, permission mode and profile variables. Its account slots use the existing work, profile, selected memory, handoff, approval and resource coordinator. Built-in adapters retain their richer native contracts.

Registration starts no executable and downloads no package. Forge supplies no new inference loop, file/browser/computer-use tools, memory engine or scheduler. The native agent supplies those under its own policy. Agents requiring client-side file/terminal tools are outside this contract; Forge advertises those capabilities as unavailable.

## Register and bind

Install/configure the agent through its native workflow first. Choose **Register connector**, paste a manifest and prepare a review. Review the full arguments, profile variables, mode, resolved executable and SHA-256; confirm trust and register within two minutes. The executable is checked again at registration and before launch. For example:

```json
{
  "format": "forge.native-connector",
  "version": 1,
  "id": "ext.opencode-acp.v2031",
  "name": "OpenCode ACP",
  "protocol": "acp/1",
  "executable": "/absolute/path/to/opencode",
  "args": ["acp"],
  "agent": { "name": "OpenCode", "version": "2.0.31" },
  "mode": "build",
  "model": "provider/model",
  "homeVariables": {
    "XDG_CONFIG_HOME": "config",
    "XDG_DATA_HOME": "data",
    "XDG_STATE_HOME": "state",
    "XDG_CACHE_HOME": "cache"
  }
}
```

Replace paths/model with your supported native setup. IDs begin with `ext.` and remain immutable. Install a new versioned ID when changing the contract. Optional `model` requests that exact advertised native selection through ACP configuration, followed by acknowledgement verification. An unavailable choice holds input; no alternative model is selected. Omit it only when you intend to accept the native session's choice. It does not verify the served provider, account or invoice.

In Accounts, select the connector, an existing dedicated profile directory and native/API billing. Configure native sign-in and model in that environment first. The child gets an isolated HOME (and Windows user/AppData roots), reviewed home variables beneath the selected directory and basic OS runtime variables. Arbitrary ambient provider keys, preloads, proxies and other account profiles are excluded. An optional [private credential reference](CREDENTIAL_REFERENCES.md) supplies one selected provider variable. Native implementations differ in which configuration locations they honor.

The account check verifies the native protocol/name/version through a short owned connection. It creates no conversation/model prompt, performs no interactive login and claims no verified provider identity or quota. The slot remains configured with identity/limits/billing unknown. Session/model/mode are checked again before input; the launch requires the existing explicit metered/external billing choice.

## Runtime contract

Keep keys, tokens and authorization headers out of manifests and arguments. Use native sign-in or a private account credential reference.

The official SDK handles framing and cancellation. Hermes reuses the shared ACP driver with its stricter native version, provenance and outcome checks. Generic connectors require protocol 1 and exact advertised name/version. Native sign-in remains external. No automatic login, hidden-history fallback or model fallback occurs.

Modes can use legacy ACP modes or current `category: mode` configuration options. Conflicting/unavailable modes refuse input. Mode/model changes during a turn close the connection and withdraw pending approvals. A reviewable native permission request must offer unique one-time allow/reject choices; permanent grants are never selected. Native policy can allow actions without asking. Choosing a mode does not sandbox the agent or force upstream tools to prompt.

A new session is used unless the same binding retains a session and advertises loading. Loading names the exact session and cwd. Forge's goals, checkpoints, selected context, capsule/artifact evidence and attribution survive reviewed handoff. ACP cannot certify another agent's hidden-history or memory semantics. End-turn reports turn completion, not task acceptance or absence of external effects. Generic billable counters remain unverified; context-window updates are never fabricated into paid tokens or zero dollars. Spending unknown-cost handling remains available.

The existing serialized admission, fresh pressure check, scoped companion authorization and cooperative profile lease apply. Registration starts no resident worker. Retirement prevents new work and preserves history; removal refuses account/work/history references. Bindings include the connector digest; old no-connector account hashes stay unchanged. State remains 6: older code cannot dispatch the namespaced harness, and registry metadata is additive.

Only a local human can register, enable/retire or remove executable connectors. Demo, companion bearers and phone provisioning cannot. Authenticated phone humans retain managed approval access. Public setup blueprints export roles/requirements, not private executable paths, registry metadata or credentials.

## Integrity and ownership limits

Hashing streams with bounded memory. Nonregular/oversized and Unix group/world-writable executables are refused. Arguments pass directly without an implicit shell wrapper. This pins the main executable; dependencies, argument scripts, plugins and native configuration still require trust through their owner. These are cooperative same-user checks, not a sandbox or protection from a hostile local account.

Forge owns the launched ACP connection/process and profile lease. The agent remains responsible for tools/descendants and their shutdown. Generic ACP supplies no universal orphan adoption, hard resource ceiling, remote-host authority or scheduler ownership transfer. Unsupported behavior is surfaced without widening permissions or redirecting work.

## Evidence

Functional/API tests cover immutable review, binary drift, schema/environment boundaries, exact approval, same-session resume, model choice, retirement/removal and human authority. Protocol tests reject conflicting mode surfaces and prove that a configuration change withdraws a pending grant. Browser tests cover registration, account selection/probe, retirement/reload/removal, themes/mobile, axe, overflow and fixed footers.

`npm run test:native:connector` uses compiled Forge and an actual installed OpenCode ACP child with a local synthetic provider. Optional `FORGE_CONNECTOR_CONFORMANCE_BINARY` compares a separate compatible executable without changing the production selector or global install. Evaluated 2.0.31 passed native model selection, one edit approval, exact artifact, selected context and private credential routing, with three local requests including native title generation and zero paid calls. The isolated npm binary's SHA-512 matched registry metadata. Billable usage remains unverified.

Installed 2.0.6 omits the configured model from initial ACP choices. `npm run test:native:connector -- --expect-model-hold` verifies rejection before input, zero provider requests and no artifact. Its builtin v2 HTTP adapter retains separate successful execution evidence. Protocol initialization alone does not establish account/model compatibility.

Primary contracts: [ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json), [OpenCode v2 ACP](https://dev.opencode.ai/v2/docs/cli/acp/), [configuration](https://dev.opencode.ai/v2/docs/config/) and [permissions](https://dev.opencode.ai/v2/docs/permissions/). The observed old-build model/catalog behavior is consistent with [upstream report 50378](https://github.com/anomalyco/opencode/issues/50378) and [catalog report 52729](https://github.com/anomalyco/opencode/issues/52729); local conformance determines support.
