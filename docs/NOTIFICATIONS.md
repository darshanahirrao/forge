# Notifications

Forge v0.20 connects to an existing ntfy destination for generic attention alerts. It reuses ntfy publishing and native subscriber apps rather than adding a messaging service, device registry, agent loop or scheduler. Notifications are off until configured. No public topic or user account is created automatically.

## Setup

Open Connections, then Configure notifications. Enter your ntfy HTTPS server origin, private topic and optional access token. Self-hosted HTTP is accepted only on loopback. Use a restricted authenticated topic or a sufficiently unguessable topic, and subscribe to it in your own ntfy app. Connecting immediately enables the selected categories, including currently pending approvals. Completed-attempt alerts are optional and off initially.

Use Send test alert and review its receipt. “Accepted by ntfy” means the configured HTTP service returned success. It does not confirm device delivery or a human seeing the message. Attempt completion does not mean its work passed your acceptance criteria. Interruption does not establish native process exit or release execution ownership.

An alert opens the current approval inbox or workspace. It contains no native command, work title, goal, project path, transcript, request digest, bearer or approval action. Forge continues to check the exact native request, generation, expiry and authenticated reviewer when you decide. The review address is the configured private phone origin, when present, otherwise Forge's loopback address. A loopback address cannot open a laptop workspace from a phone. Use the existing [private gateway](PHONE_ACCESS.md) for remote review.

The same private notification reference works in foreground mode and the optional [macOS user service](BACKGROUND_SERVICE.md). Forge and the host must remain running and awake. This integration does not install a startup service, phone gateway, ntfy app or ntfy server.

## Delivery and recovery

SQLite records a small observational outbox. Committed approval/run changes wake a sequential sender, without a timer or model call. Selected terminal runs since opt-in and still-current approvals are deduplicated by destination and source receipt. Old terminal history is not broadcast on first connection. Before sending, Forge rechecks the destination, work generation, current owner and expiry. Withdrawn requests and replaced/disabled destinations are suppressed.

The sender records `sending` before reading the private reference or crossing the HTTP boundary. Requests time out after five seconds and refuse redirects. Successful acknowledgement produces `accepted`. A lost acknowledgement, HTTP error or process death during sending produces `uncertain`. Missing/unsafe private references fail before network delivery. Uncertain and failed deliveries are never automatically retried. A queued request that never crossed the sending boundary can be reconsidered after restart if still current.

The workspace surfaces unreviewed delivery problems. Connections shows bounded receipts with unreviewed problems first, keeping older problems reachable as others are acknowledged. Acknowledgement preserves the original result and sends nothing. Replacing a destination is an explicit new subscription and may notify about still-pending approvals. Disabling prevents queued sends but cannot retract an already submitted request.

## Private references and authority

Topics/tokens live in an owned mode-0600 `.forge-notify-UUID.json` file beside the database. Reading uses the shared bounded, no-follow private-reference helper. SQLite, polling snapshots and blueprints exclude these secrets. The form clears them on submission/cancellation/completion and never uses browser storage. They are not written into URL queries or the launchd plist. Disconnect deletes the active reference; delivery receipts remain.

Only the local human workspace provisions credentials. Authenticated phone reviewers can inspect/test/disable and acknowledge receipts through the existing gateway. Demo mode sends nothing. Companion MCP bearers grant no human notification API or native approval authority. Transactional observers publish only after commit; notification failures cannot roll back canonical work/run/approval changes.

## Evidence and limits

Functional tests cover local HTTP delivery, privacy, selection, stale requests, configuration revisions, disconnect, private-reference failures, redirect refusal, lost acknowledgements and SQLite reopen. An owned child is killed after the loopback receiver reads its message; restart preserves uncertainty and sends no duplicate. Browser checks cover credential clearing, accepted/uncertain receipts, attention navigation, acknowledgement, both themes, mobile action reach and axe. All destinations/tokens are isolated fixtures. No public ntfy topic or paid model call is used.

Actual ntfy hosting/authentication, mobile OS push behavior, a physical subscriber and tailnet connectivity still require live acceptance. HTTP fixture conformance is not device/server certification. Native companion channels, SMS/email delivery, automatic retries and a second approval engine are outside this implementation.

Primary references: [ntfy publishing](https://docs.ntfy.sh/publish/), [access tokens](https://docs.ntfy.sh/publish/#access-tokens), [click actions](https://docs.ntfy.sh/publish/#click-action), [phone subscription](https://docs.ntfy.sh/subscribe/phone/) and [self-hosting](https://docs.ntfy.sh/install/). ntfy is an external open-source service; Forge vendors none of its implementation.
