# Native process policy

Forge can apply a reviewed native OS policy to new owned agent processes. **Resources → Native process policy → Review policy** offers utility scheduling priority and an optional memory limit in MiB. Native defaults remain unchanged until a human configures a policy.

## Scope

The evaluated backend is the installed macOS Darwin 27 `taskpolicy` command. It uses native utility QoS to favor foreground applications and the native original-process memory limit. Utility priority is scheduling guidance; it does not reserve a CPU percentage. The memory limit covers the original native process, not summed descendant RSS, detached work or a remote backend. A small limit can prevent startup or terminate a turn. Use native defaults until the profile’s requirements are understood; fixture limits are not general sizing guidance.

The native utility class preserves gateway communication in the tested OpenClaw installation. An isolated comparison found that full Darwin background mode disrupted readiness, while utility priority with the same memory limit passed. Forge therefore uses utility priority for this preference. It does not change global kernel settings or start another service, scheduler, watchdog or model loop.

The native implementation uses same-PID exec and native spawn attributes. Read Apple's [taskpolicy implementation](https://github.com/apple-oss-distributions/system_cmds/blob/main/taskpolicy/taskpolicy.c). Forge invokes the existing system binary; no upstream tool implementation is copied into the application. CPU/QoS hints and per-process limits are different from whole-family containment. Broader OS/family governance remains in the [completion audit](COMPLETION_AUDIT.md).

## Review and launch

Configuration requires human access, an exact policy revision and explicit effect review. The existing host CSRF boundary and private-phone identity apply. Native MCP bearer credentials and demo cannot change the policy. A bounded native no-op verifies the selected arguments before committing configuration. It starts no account, model, job or service.

An active policy binds the evaluated host release and system-binary fingerprint. Changed or unsupported native support holds new launches until a human reviews the policy on that host or restores native defaults. Other operating systems do not silently accept limits they cannot apply.

Work context review and native gateway review include the current policy. Changing it invalidates a prepared review before a new process can start. Configuration waits for native startup and rechecks admission after the native setup probe, preventing a concurrent start from racing the policy commit. The original-child prepared/committed protocol checks the current policy again. Delegated execution backends retain their own resource controls; an active local policy cannot silently disappear when switching to one.

Each admitted run or gateway retains its policy receipt. The receipt digest becomes part of the signed original-child scope. A running process keeps that launch policy when the workspace preference changes; the new preference applies to future launches. Utility priority or memory limits do not reset work/profile identity, selected memory or a compatible native conversation.

## Exit and recovery

The signing child owner stays outside the native process memory limit. If the native process is killed, that owner can still wait for original native and inherited-stdio closure and write exact signed evidence. Current policy changes cannot rewrite the original receipt or make old closure mean a new launch.

An exit signal alone does not identify its cause or prove detached/external effects settled. Existing approval withdrawal, spending uncertainty and recovery rules remain authoritative. No prompt or native action is automatically replayed after a limit ends a process. Resource observations never become arbitrary-PID controls. Read [original-child recovery](NATIVE_RECOVERY.md) and [companion lifecycle](COMPANION_RUNTIME.md).

Policy configuration uses canonical private state. State 10 prevents older readers from ignoring these reservations and receipts. Upgrading an earlier file workspace creates a private `before-v10` rollback copy. Retain native profiles/proofs separately; a database rollback does not undo native effects. Setup blueprints do not transfer this host-bound policy or its active authority.

The private OpenClaw profile marker records confirmed ownership closure, independently of whether the native outcome was successful. Admission rejected before any child exists restores only that attempt’s preparation marker. With supervision, the original signing evidence must validate before a live parent marks the profile closed. A killed signing owner or unavailable evidence retains the hold. Version 0.32 also recovers a captured version-2 SDK marker after parent loss by verifying that exact original signature and retaining the same device identity. Unbound legacy markers stay held; restoring native defaults does not clear unknown ownership. [Recovery and private format migration](OPENCLAW.md).

## Verification

Functional checks exercise exact configuration/revisions, human boundaries, unsupported-host refusal, stale work/gateway reviews, policy changes during a running gateway, sealed-receipt tampering and recovery after a later policy change. On the evaluated host, the same inert 96 MiB allocation completes under native defaults and is killed under a 64 MiB process limit; both retain original input/PID and valid signed close evidence.

The browser flow reviews the real native configuration in desktop light and phone dark, checks accessibility/overflow/reachable actions, verifies the policy in native launch context and restores defaults without starting a model turn. Unsupported-host coverage checks unavailable controls explicitly.

After building, the native transport fixtures accept `--native-resource-policy` for the evaluated host. They use temporary profiles, utility priority with a 4,096 MiB full-work limit or 2,048 MiB gateway-startup limit:

```sh
npm run test:native:handoff -- --native-resource-policy
npm run test:native:companion-lifecycle -- --native-resource-policy
```

Use the existing isolated native installation overrides from the [test guide](../tests/native/README.md). A successful transport fixture must retain exact approvals, context/artifacts, the policy scope and signed closure; it is not evidence of live subscription billing, device push or universal resource containment.
