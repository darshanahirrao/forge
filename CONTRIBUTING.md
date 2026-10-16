# Contributing to Forge

Use Node.js 24 or newer. Install with `npm ci`, then run `npm run dev` for the local API and web interface. The production path is `npm run build` followed by `npm start`.

Before a contribution, run:

```sh
npm run format:check
npm run check
npm test
npm run build
npm run test:e2e
```

Browser tests use installed Google Chrome locally. In CI they use Playwright Chromium, installed with `npx playwright install --with-deps chromium`. Browser-test data lives in a temporary directory and is removed when the test service exits. Native protocol tests use synthetic fixtures and make no model calls. Optional `npm run test:native` runs installed native tools against deterministic loopback providers in temporary projects, sequentially. It needs Codex on PATH and the SDK native platform dependency. No paid endpoint or private credential is used; see [native conformance](tests/native/README.md).

Read [the current runtime boundary](docs/RUNTIME.md) and [the reuse rule](docs/NATIVE_BOUNDARY.md) before extending an adapter. Prefer an existing native interface or component over implementing another execution, memory, terminal, browser, or scheduling stack. Retain native extensions and unsupported capability states.

Keep canonical work and its receipts transactional. Preserve source scope for usage and limits. An SDK cost estimate is not a provider-confirmed charge. A session reference is not permission to control an existing native session. Permission tests must verify the exact native request and reject stale decisions.

Use fictional tasks and account identities in fixtures. Never commit credentials, native conversations, private memory, account records, local absolute paths, runtime databases, generated previews, or billing records. Describe what was tested against a real upstream version separately from synthetic coverage.

Update BUILD_LOG.md and HANDOFF.md with changes, validation, limitations, and a named continuation checkpoint. Keep changes focused and preserve the MIT license and applicable dependency licenses.

Native/continuity changes should preserve the three-worker handoff conformance, source-exit receipts, revision-bound launch and selected-artifact verification. Run `npm run test:native` when the necessary local executables are available. Never replace those checks with invented success counters or treat synthetic inference as real provider-account evidence.
