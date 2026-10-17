# Native OpenClaw execution

Forge reuses the installed OpenClaw foreground Gateway, its native tools and memory, and the MIT `@openclaw/gateway-client` reference client. It does not implement an OpenClaw agent loop or use the ACP bridge as proof of Gateway ownership. The evaluated contract is native OpenClaw **2026.10.4**, Gateway protocol **4**, and reference client **2026.10.4**. Other native releases require conformance before admission.

## Two native roles

An existing companion Gateway can be connected through Activity for observation. Its channels, schedules and sessions retain their original native owner. Observation does not confer approval or cancellation authority.

Managed turns use a separate, explicit **execution profile**. Forge owns its foreground Gateway process for one attempt, uses the native control-plane embedding mode, and stops that process after settlement. Native channels are skipped in this embedding role. The profile must explicitly disable native cron and heartbeats and turn configuration reload off. Forge validates these settings with native CLI JSON before starting the Gateway; it never rewrites an existing companion profile to satisfy admission. Full always-on companion planning and lifecycle control remain separate work.

## Native setup

Install and configure OpenClaw through its own supported setup. OpenClaw 2026.10.4 requires Node.js **24.16+ within 24.x, or 26.1+ within 26.x**. Forge itself can run on another supported Node release; set `FORGE_OPENCLAW_NODE` to an absolute compatible native Node executable in that case. `FORGE_OPENCLAW_BINARY` optionally points at the installed package's absolute `openclaw.mjs`; the package name/version are checked without evaluating a shell launcher. Forge does not download a native runtime or perform an automatic upgrade.

Use a new dedicated native state directory for each independent account configuration. In a shell dedicated to its native setup:

```sh
export OPENCLAW_HOME="$HOME/.local/share/forge/openclaw-personal"
export OPENCLAW_STATE_DIR="$OPENCLAW_HOME"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_HOME/openclaw.json"
mkdir -p "$OPENCLAW_HOME"
openclaw onboard
openclaw config set gateway.mode local
openclaw config set gateway.reload.mode off
openclaw config set cron.enabled false
openclaw config set agents.defaults.heartbeat.every 0m
```

Select a native default model and configure native provider authentication. Any per-agent heartbeat override must also be `0m`. Do not run an interactive agent session in this new execution profile before initial attachment: Forge's first ownership receipt requires an empty native session catalog. Existing profiles with conversation history are observed through their original owner; automatic foreign adoption is not implemented.

In Forge, add an OpenClaw account slot pointing at this exact state directory. Native/API billing and explicit external/metered launch consent are required. A subscription-only preference is refused because provider identity, eligibility and quota are not verified. Credentials remain native. An optional selected provider environment-variable name can be supplied; Forge forwards that variable and a small runtime environment, excluding other ambient provider credentials. A status check validates native setup without starting a Gateway, creating a session or prompting a model.

## Sessions and approvals

Each new managed session is created through native `sessions.create`, with the canonical project directory and native `guarded` permission mode. The native stable session UUID and its routing key are stored separately. Resume verifies the UUID, key, project root, local runtime, guarded policy, empty input queue and explicit idle evidence. Model selection is resolved by OpenClaw and pinned through its native session patch with an expected session identity.

Input is addressed through the public `agent` RPC by stable native session UUID and agent ID. The accepted response must identify the saved routing key and exact run. Internal backend-only identity/lifecycle parameters are not sent. A native reset or changed policy/root stops continuation. A Work Capsule preserves both original identifiers as provenance; a handoff or selected-memory correction clears both identifiers before new native input.

Native guarded policy can allow reads and writes inside the project without prompting. Forge forwards supported **Gateway command** requests only when native session/run/tool observations establish their ownership. The full live pending record is reread through `exec.approval.list` before presentation and before delivery. `exec.approval.get` returns a display projection and is insufficient for complete request binding. Changed, expired, foreign, resolved or withdrawn requests receive no earlier grant. Only native `allow-once` or `deny` is sent; no permanent rule is minted. Plugin, remote-node and descendant request coverage is not claimed.

## Ownership, transport and recovery

Forge acquires a cooperative per-profile SQLite lease through the actual process exit. It creates its own mode-0600 Ed25519 device identity in `.forge-openclaw.json`; the reference SDK constructs and signs native challenge payloads using platform cryptography. This is a transport identity, not a model-provider account or subscription identity. Forge does not copy a native credential store or parse/write OpenClaw's private database schema.

The foreground CLI binds to a random loopback port with a process-only random shared token. The native version, negotiated protocol, required methods and rejection of an incorrect transport token are checked before task input. `OPENCLAW_NO_RESPAWN=1` retains the supervised process through in-process restarts; Bonjour, ambient shell snapshots and native Tailscale exposure are disabled for this owned embedding role. After the first successful handshake, transport loss, a sequence gap, shutdown or reconnection invalidates controls. No input or decision is replayed.

Completion requires native terminal settlement, an exact terminal receipt, idle native session evidence and actual owned-process exit. Stop withdraws controls immediately, requests native run cancellation when that exact accepted run is still active, and acknowledges HTTP admission with `202`. The UI shows that native shutdown is pending. The work lease and capacity remain reserved through native cleanup. OpenClaw advertises a 330-second shutdown budget; Forge allows 335 seconds before a forced process kill. A forced or unsuccessful exit does not become a completed outcome.

The private ownership receipt is marked unclean before native startup and cleared only after a successful native exit. An unconfirmed exit refuses another managed start from that profile. Do not delete or reset this receipt to work around a crash: native work and external effects require reconciliation first. Automated recovery/adoption and a reviewed reconciliation interface remain open requirements. A cooperative lease does not fence arbitrary clients, detached native tools or external effects.

## Usage and validation

Usage comes from the native root **agent-run** counters and is keyed by the Forge attempt. Native cost is an estimate, never an invoice or inferred subscription allocation. Missing cost stays null; an explicit native zero stays zero. `lastCallUsage`, session `totalTokens` and context-budget estimates are not substituted for billable run totals. Descendant and utility coverage remains explicit and incomplete.

`npm run test:native:openclaw` uses the real installed native Gateway, synthetic provider credentials and deterministic loopback inference. Native tools produce the artifacts; the fixture does not write them. Run it with the native Node/binary overrides above when needed. The main functional suite also exercises exact request changes, native session resets, transport loss, source-exit ownership and asynchronous stop admission. See [the completion audit](COMPLETION_AUDIT.md) for remaining scope. Native inference conformance does not establish live provider identity, model quality or quota isolation.

Primary references: [Gateway embedding](https://docs.openclaw.ai/gateway/embedding), [reference clients](https://docs.openclaw.ai/gateway/clients), [protocol](https://docs.openclaw.ai/gateway/protocol), [permissions](https://docs.openclaw.ai/tools/permission-modes), [exec approvals](https://docs.openclaw.ai/tools/exec-approvals), [native package source](https://github.com/openclaw/openclaw/tree/v2026.10.4/packages/gateway-client).

The root Forge dependency audit reported zero advisories at this checkpoint. The isolated native install also contained npm; five audit advisories (three high, two moderate) were in npm’s nested dependencies. Those packages are outside Forge’s root dependency tree. They were not automatically patched or relabeled safe; maintain and review native installations through their upstream distribution.
