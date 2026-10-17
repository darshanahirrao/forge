# Work and native process ownership

Forge links a managed attempt to the actual native process created by its adapter. The Resources view shows the work, harness, recorded root PID, observed process tree, memory and a route back to the work's existing controls. Codex, Claude Agent SDK, OpenCode, Hermes ACP and OpenClaw Gateway use the same ownership contract. Existing foreign chats and applications remain observations.

## Evidence and lifecycle

The adapter reports its supervised child PID before releasing model input. The execution coordinator first saves that spawn report in the canonical run. On macOS/Linux it then checks the native OS parent, user and process start marker. A changed parent/user rejects registration before task input. Native worker identity and the original harness stay in SQLite with the run; startup recovery preserves the record and marks an unfinished attempt unconfirmed. Recovery does not adopt the worker or restore an old approval connection.

The native OS `ps` interface supplies PID, parent PID, UID, start marker, RSS, CPU and executable name, using a controlled C locale and UTC. Command arguments and environment values are not collected. Full process observations stay in service memory; the general process table exposes only the largest thirty processes and omits unrelated users' start/UID markers. The owned-work view can include a small worker outside that top-thirty table.

A recorded root must match the sampled OS user and start marker before its memory is attributed. A sampled descendant tree stops at another recorded root and at the current Forge service. This avoids charging a nested managed worker to two work rows. Process reparenting, detached tools, shared services and external effects remain outside this tree guarantee. RSS can include shared pages; it is not physical memory ownership or additive unique memory.

## Observations do not authorize actions

PIDs are recyclable. The start marker is an observational correlation value with the native `ps` granularity, not a cryptographic process identity. Missing, changed, duplicate or unavailable observations produce explicit unknown states. They never confirm a native exit, release capacity, replay an action, restore approval authority or authorize a signal.

The resource view links to the work panel. A current managed attempt is stopped through its existing native driver and supervised child handle. There is no API accepting an arbitrary PID to kill. After restart, a live or missing old worker remains unconfirmed and requires native reconciliation; the resource display does not bypass that boundary. The Claude adapter also refuses an unexpected replacement root from a single SDK query instead of silently moving its process ownership record.

Samples are collected on demand, coalesced and cached for five seconds. A newly recorded process can initially be absent from the latest sample. This is not a continuous resource meter, hard memory/CPU cap, OS memory-pressure signal, or complete resource-cleanup interface. Quiet mode and serialized native admission still gate new managed work, account probes and inventory reads. The [opt-in macOS user service](BACKGROUND_SERVICE.md) supplies background availability separately. Other native service backends and full recovery/cleanup controls remain delivery gates.

## Validation

Functional checks cover actual child capture, retained recovery identity, PID reuse, changed users, absent roots, unknown/duplicate observations, nested worker boundaries and non-disclosure of unrelated identity fields. The six-worker native handoff check requires live OS-checked resource attribution for Codex, two Claude API profiles, OpenCode, Hermes and OpenClaw before its exact native approvals. Native tools still produce the six verified artifacts; inference stays on deterministic loopback fixtures with synthetic credentials.

Browser coverage opens owning work directly from Resources, reviews the original exact native request and continues the existing verified handoff. Desktop/mobile rendering, keyboard scrolling, overflow and axe checks use the same view. These checks prove that boundary on the tested installation; full-stack overhead, hard resource enforcement, platform coverage and external-effect fencing still require their own evidence. See [the full completion audit](COMPLETION_AUDIT.md).
