# Multiple accounts, one continuous workspace

Design proposal, 16 October 2026, with an initial implementation on 17 October. A person should be able to connect several authorized accounts for the same harness and choose among compatible accounts without creating a separate Forge workspace or manually reconstructing the task. Account slots and native Codex/Claude status probes are implemented. An experimental managed Codex task binds one selected account. Automatic switching and native binding transfer are not implemented; see [RUNTIME.md](RUNTIME.md).

## The experience

One work record might continue through Claude Code account A, Claude Code account B, and then Codex account A. Its goal, acceptance criteria, files, decisions, relevant memory references, artifacts, and attempt history stay attached to the same `work_id`. The timeline records the actual account and harness used for every attempt.

The person chooses an account directly or configures an ordered routing policy for that project. A switch preview shows target access, context coverage, available capabilities, quota evidence, and billing mode. With prior routing authorization and a verified safe boundary, compatible continuation can happen automatically. First sign-in, expired authorization, unavailable context, or incompatible access can still require attention.

Connecting an account should not start another always-running harness, browser, or memory service. Keep account inventory lightweight, refresh metadata through supported interfaces on demand, and respect laptop admission policy before starting execution.

## Independent identities

| Record | Meaning |
| --- | --- |
| `work_id` | The durable task, independent of any login or native conversation. |
| `account_ref` | An opaque local reference to a connected native account slot. Secrets remain in the native credential store. |
| Native account and organization | The verified identity actually serving an attempt, including workspace or billing scope where exposed. Several slots may resolve to the same identity. |
| Execution binding | Harness/runtime, version, host, account reference, native session, attempt, and execution generation. |
| Quota scope | A provider-reported limit bucket, with its own scope, window, reset time, source, and observation time. Several accounts or models may share it. |

Account slots retain only the metadata needed for coordination: display alias, native profile reference, supported authentication mode, connection state, permitted project/data scopes, declared capabilities, and usage/quota source references. Public blueprints carry role labels and connection requirements; private account identifiers and credentials stay local.

## Reuse native account support

| Integration | Verified upstream documentation | Design consequence |
| --- | --- | --- |
| Claude Code | Separate `CLAUDE_CONFIG_DIR` values isolate claude.ai logins or API keys, settings, and history. Two keyless Console sign-ins are an explicit exception. | Use native sign-in and supported isolation for the selected authentication mode. Do not treat a directory as proof of isolation for every mode. |
| Codex | Credential storage can use an OS credential store, a file under `CODEX_HOME`, or process memory. App-server exposes active-account and ChatGPT rate-limit operations. | Verify the actual account before dispatch. Test isolation for the chosen version and storage backend; a configuration profile alone does not establish an independent login. |
| Agent Deck | Existing Claude account slots and a documented stop, transcript-copy, and resume flow. | Evaluate this implementation before building account management or native conversation migration. Documented behavior still needs integration and fault testing. |
| Other harnesses and runtimes | Authentication, session portability, quota APIs, and credential precedence vary. | Advertise account discovery, isolation, quota visibility, and continuation as separate tested capabilities. Unsupported behavior stays visible. |

Native login owns credential creation and refresh. Avoid overwriting a shared live auth file to change accounts. Launch only the selected native account context, check the effective identity and provider after native configuration precedence applies, and keep unrelated credentials out of the child environment. Credential-store isolation does not isolate workspace files; file access still follows the existing execution host and native permissions.

## Continuing safely

1. Select an account allowed to receive this project's data, with the required capabilities and billing mode. Routing authorization must cover the target organization and data scope. A change from subscription access to paid API access needs an applicable budget and an explicitly allowed route.
2. Reach a native safe boundary, persist the Work Capsule and artifact evidence, and reconcile uncertain external actions. Stop the source executor or enforce the existing fencing contract before transferring exclusive write authority.
3. Prefer a supported, tested native resume path. Otherwise provide the target a scoped continuation package: goal, decisions, artifact references, verified progress, relevant source context, and unresolved actions. Preserve original evidence references and disclose context that could not be imported. Never silently truncate required context to fit a smaller window.
4. Verify the target's effective identity, workspace access, tools, memory sources, and native permissions. Create the successor attempt and generation, correlate its native session, and record the transfer receipt. Old pending approvals cannot authorize its new requests.
5. Continue once. If target activation fails, keep the durable work recoverable and reconcile target activity before rollback. Restoring an old binding does not restore stale execution authority.

The continuity promise is preservation of recorded work and required context across supported bindings. Native hidden state, reasoning, caches, connectors, browser sessions, and authorization may differ. Native conversation reuse and cross-harness continuation have separate compatibility evidence. A common work record cannot guarantee identical reasoning or outcomes.

## Capacity and spend

Show each native limit window with its reported scope, reset time, freshness, and source. Keep subscription allowance, API throttles, organization budgets, and local machine capacity distinct. Unknown or stale allowance remains unknown or stale. Do not manufacture a common remaining-token balance across incompatible windows, or count duplicate slots and shared organization buckets as extra capacity.

An ordered route can choose another eligible account when supported and permitted by native provider policy. Preserve native retry and reset instructions. Distinguish exhausted allowance, transient throttling, authentication failure, unavailable capability, and a policy denial; they require different actions. A denial does not authorize changing identity or policy to retry the action. The dashboard should explain which eligible routes remain and why a task is waiting.

Attribute usage to the verified native identity and quota scope as well as project, work, attempt, harness, and model. A transfer does not reset the work's cost history. Deduplicate imported transcripts and cumulative counters using native event identity, counter epoch, scope, and transfer lineage. New accounts may incur context reload or cache costs; retain those in outcome accounting. Keep estimated API-equivalent cost, confirmed charges, subscription allocation, and unknown amounts separate.

## Evidence required before release

Use synthetic projects and sanitized fixtures first. Test two native accounts of one harness, then a compatible cross-harness change, checking identity isolation, shared quota buckets, expired sign-in, stale quota metadata, configuration precedence, context coverage, unsupported native resume, and missing tools. Inject failure around transfer and external effects; prove one writer per exclusive scope, no stale approvals, no duplicate spend, and recovery without erasing work history. Measure idle overhead with many connected account slots and few active workers.

## Primary references

- [Claude Code multiple-account authentication](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts)
- [Claude Code environment and precedence](https://code.claude.com/docs/en/env-vars)
- [Codex credential storage](https://learn.chatgpt.com/docs/auth#credential-storage)
- [Codex app-server account and rate-limit interfaces](https://developers.openai.com/codex/app-server)
- [Agent Deck account switching](https://github.com/asheshgoplani/agent-deck#switch-a-sessions-account-on-the-fly)
