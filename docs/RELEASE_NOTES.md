# Forge 0.41.0 public alpha

A compact operator workbench for continuing work across native agent harnesses.

## This release

- A distinct graphite/copper interface with a narrow activity rail, crisp controls, aligned metadata and a work queue beside pending decisions.
- Expandable navigation, Compact/Comfortable row density and browser-local View options with a reset. Both themes remain available.
- Keyboard access: Ctrl/Cmd K or / for Commands, N for a work draft, ? for Help, Alt+1 through Alt+8 for views, and Ctrl/Cmd+backslash for the desktop rail. Single-key shortcuts can be disabled. Typing and modal reviews retain their own input handling.
- Mobile navigation traps focus, returns it on dismissal, closes on Escape/selection and keeps background controls inert. Pending decisions precede work on narrow screens.
- No new UI dependency, font download, background observer or server schema migration. Native execution, ownership, approvals and account data retain their existing boundaries.

Use Node.js 24+ on macOS or Linux. Download both assets, verify SHA256SUMS, then install:

```sh
npm install --global --omit=dev --ignore-scripts ./forge-workspace-forge-0.41.0.tgz
forge doctor
forge start
```

Open http://127.0.0.1:4710. Native tools and sign-in remain separately installed/configured. The npm registry is not a release channel yet. Existing inactive workspace backups remain required before upgrading; state stays at version 16.

This is a public alpha. Native execution remains experimental on evaluated versions. Windows, arbitrary native-state portability, whole-family resource limits, rich schedule/provider mappings, general UI/policy packages and live provider/device acceptance remain open. Claude managed execution uses supported API authentication; subscription sessions stay in the native client. T3/Codex strict native-history compatibility remains open.

Read the [alpha guide](https://github.com/darshanahirrao/forge/blob/forge-v0.41.0/docs/PUBLIC_ALPHA.md), [experience decisions](https://github.com/darshanahirrao/forge/blob/forge-v0.41.0/docs/UI_EXPERIENCE.md), [security boundaries](https://github.com/darshanahirrao/forge/blob/forge-v0.41.0/SECURITY.md) and [full audit](https://github.com/darshanahirrao/forge/blob/forge-v0.41.0/docs/COMPLETION_AUDIT.md).

Verification covers 345 functional cases, 47 browser flows, seven compiled-package checks, two independent distribution checks and type/format/build checks. The interface is rendered and accessibility-checked across all eight views in both themes at desktop/phone widths. Keyboard and display changes are checked for persistence and zero server mutations. Existing native conformance evidence is retained from v0.40; no new live provider/device acceptance is claimed.
