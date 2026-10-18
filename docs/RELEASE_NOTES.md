# Forge 0.40.0 public alpha

An installable local workspace for continuing work across native agent harnesses, with canonical profiles, selected memory, approvals, resource visibility and scoped usage evidence.

## This release

- Compiled GitHub release archive with an explicit public file allowlist, dependency shrinkwrap and SHA-256 checksum.
- Read-only forge doctor and JSON reports without opening workspaces, reading credentials, executing native tools or contacting providers.
- A first-run Codex-to-Hermes example, compact recorded attempt history and reviewed public receipts that exclude prompts, memory, paths, account names and internal identifiers. Fictional exports retain their demo label.
- Actual empty-directory archive installation, served web assets, work creation and restart-retention checks, independent of repository dependencies.
- Short public setup/support guide, security reporting and structured community bug reports.

Use Node.js 24+ on macOS or Linux. Download both assets, verify SHA256SUMS, then install:

```sh
npm install --global --omit=dev --ignore-scripts ./forge-workspace-forge-0.40.0.tgz
forge doctor
forge start
```

Open http://127.0.0.1:4710. Native tools and sign-in remain separately installed/configured. The npm registry is not a release channel yet.

This is a public alpha. Native execution remains experimental on evaluated versions. Windows, arbitrary native-state portability, whole-family resource limits, rich schedule/provider mappings, general UI/policy packages and live provider/device acceptance remain open. Claude managed execution uses supported API authentication; subscription sessions stay in the native client. T3/Codex strict native-history compatibility remains open.

Read the [alpha guide](https://github.com/darshanahirrao/forge/blob/forge-v0.40.0/docs/PUBLIC_ALPHA.md), [security boundaries](https://github.com/darshanahirrao/forge/blob/forge-v0.40.0/SECURITY.md) and [full audit](https://github.com/darshanahirrao/forge/blob/forge-v0.40.0/docs/COMPLETION_AUDIT.md).

Release verification includes 345 functional cases, 45 browser flows, seven compiled-package checks, two independent distribution checks and the actual six-attempt/five-harness native chain with seven approvals, six checked artifacts, six signed closes and zero paid model calls. Local inference is deterministic; real provider/device acceptance remains open.
