# Native scheduler evidence

Forge v0.21 adds an on-demand Hermes ticker check. Activity keeps schedule definitions and ticker observations separate. A stored job, enabled flag, next-run time or gateway process does not establish successful ticks or delivery.

Use Check native scheduler on a Hermes schedule source. Forge resolves the installed interpreter and reads that explicit profile, reusing Hermes's raw configuration parser, public ticker-age functions and native cadence. It invokes no job loader, migration pipeline, provider/plugin resolver, job controls, repair, scheduler tick or model loop. No resident scheduler process is added.

The observation distinguishes recent loop/successful-tick markers, a recent loop with stale success, a stale loop, missing/unavailable evidence and an externally configured provider whose delivery health remains unknown. Staleness follows the native convention, three intervals plus twenty seconds. The browser ages saved evidence between checks, so an old observation cannot remain fresh indefinitely. Marker evidence does not confirm current gateway availability or individual job results, effects or channel delivery.

Native getters can clamp invalid/future epochs to zero. Forge validates their small regular marker files first: oversized, nonfinite, future, malformed and symlinked markers remain unknown. The canonical profile home is checked again after reading. Missing installations, unsupported native APIs, timeouts and malformed output do not become health. An unavailable check retains the previous successful evidence and timestamp while clearly marking the latest attempt unavailable.

The child has a bounded output and five-second timeout. Its environment reuses the native allowlist with an explicit home, no ambient provider credentials and bytecode writes disabled. Checks share native metadata/admission, run only on explicit request and cannot start during managed execution. Demo and companion bearers cannot invoke this human workspace route. Forgetting a source removes only Forge's observation; definitions, ticker and ownership remain native.

## Evidence

`npm run build && npm run test:native:scheduler` uses the installed interpreter and an isolated profile. It loads the compiled Forge module and packaged Python asset, exercises missing/current/stale/malformed/nonfinite/future/oversized markers and external-provider configuration, and compares every profile file before/after reading. No tick or model call starts. The evaluated installation is Hermes 0.17.0, source `3aebdb1d2349f1b228aa0478fce2e2fe91827278`.

Functional tests cover aging, malformed/replayed contracts, admission, concurrency, disconnect fencing, evidence retention, native-file preservation and API authority. Browser tests cover states, persistence, both themes, mobile, overflow and axe. The browser fixture injects synthetic observations and never invokes the developer's installation. A separate check of the existing private profile observed recent native markers with unchanged configuration/job-definition bytes; this dated observation is not an ongoing health guarantee.

## Remaining controls

Pause/resume and scheduler ownership transfer remain open. The installed Hermes CLI supports ID-based controls but exposes no expected-revision parameter. A preview/read followed by an unfenced command has a concurrency window; this release does not present it as an exact reviewed mutation or silently edit `jobs.json`. Codex and other scheduler providers need their own supported health/control contracts. No second scheduler or synthetic liveness timer is added.

Primary references: [native cron status and controls](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron), [cron internals](https://hermes-agent.nousresearch.com/docs/developer-guide/cron-internals/), [evaluated marker readers](https://github.com/NousResearch/hermes-agent/blob/3aebdb1d2349f1b228aa0478fce2e2fe91827278/cron/jobs.py) and [evaluated config parser](https://github.com/NousResearch/hermes-agent/blob/3aebdb1d2349f1b228aa0478fce2e2fe91827278/hermes_cli/config.py).
