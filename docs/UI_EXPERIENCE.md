# Workspace experience

Decision date: 2026-10-17. Checkpoint: `forge-v0.14.0`.

Forge is an everyday operator workspace for people already using agent harnesses. Its first screen must answer: what needs me, what is running, and where can I continue? Setup should reuse an existing native configuration and reveal additional choices when needed. Visual restraint is a workflow requirement.

## Upstream research

Reviewed these primary sources on 2026-10-17:

| Project                                                                                                                                                                                       | Useful evidence                                                                                              | Forge decision                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [T3 Code thread sidebar](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md) and [keybindings](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md) | Work is the navigation object. New threads retain relevant choices; one palette finds work and actions.      | Show existing managed work and native observations immediately. Keep native authority visible. Use one keyboard-operated palette. |
| [OpenCode TUI](https://dev.opencode.ai/v2/docs/cli/tui/)                                                                                                                                      | A prompt and discoverable commands expose the workflow without requiring a dashboard tour.                   | Use direct names, searchable actions, and a short creation form with optional context folded away.                                |
| [Superset README](https://github.com/superset-sh/superset#readme)                                                                                                                             | Agent state in the sidebar, workspace switching, an action palette, and reuse of existing CLI subscriptions. | Prioritize attention and workspace access; keep configuration secondary.                                                          |
| [cmux README](https://github.com/manaflow-ai/cmux#readme)                                                                                                                                     | Context-rich workspace rows, attention navigation, native configuration reuse and composable primitives.     | Put operational information beside the work; avoid mandatory setup ceremonies.                                                    |

These are interaction references, not a comparative performance benchmark or an upstream compatibility claim. No source from these projects is copied in this change. T3 execution-foundation adoption remains a separate decision in [T3_CODE_REVIEW.md](T3_CODE_REVIEW.md). Forge continues to reuse native execution, tools, memory and scheduling rather than adding another terminal, editor or agent loop.

## Design plan

Treatment: utilitarian. Subject: existing work across native harnesses. Audience: frequent agent users. Job: find and operate the next relevant piece of work with minimal navigation.

Preserve the existing theme tokens: paper `#F3F7F7`, ink `#18343E`, accent `#12665F`, panel `#FFFFFF`, muted text `#4E666E`, structure `#DCE5E7`. Dark variants remain token-based. Avenir Next/system sans is the interface face; SF Mono/system monospace is for paths, shortcuts and aligned measurements. No new fonts or UI dependencies.

Layout: a compact sidebar with daily views above configuration, a small page title, a single operational status row, then attention and a searchable work list. Use separators and rows rather than stacked summary cards. Keep touch targets usable on mobile.

Content order: operational status, exact pending decisions, setup only when needed, managed work and native observations in one filterable list, then a short explanation of observation coverage. The first screen must use real saved activity even when no Forge work records exist. Native metadata must never imply current process ownership or permission authority.

## Acceptance and boundaries

- Existing native chats are reachable directly from Workspace and the palette, without opening source settings first.
- The palette supports Arrow Up/Down, Enter, Escape, text search and an actions-only `>` prefix. Actions open the same reviewed forms and approval dialogs as mouse controls.
- New work requires a title and goal; project directory and binding remain readily available. Additional context, acceptance criteria, profile, priority and project label use progressive disclosure without losing saved values.
- Navigation survives reload and browser back/forward. A workspace change closes transient work and approval dialogs.
- Both themes, keyboard access, empty/error states and narrow layouts are verified with the existing browser suite and rendered captures.
- This is a workflow improvement to an early framework. Automatic account routing, arbitrary native-state portability, complete companion interchangeability and full recovery/performance gates remain open in [COMPLETION_AUDIT.md](COMPLETION_AUDIT.md).

## Resource diagnosis, v0.26

Subject: laptop load across Forge and native harnesses. Audience: frequent operators. Job: identify the resource consumer and reach its supported controls. Reuse paper `#f3f7f7`, panel `#ffffff`, ink `#18343e`, teal action `#12665f`, muted `#4e666e` and structure `#dce5e7`, with existing dark tokens, system interface type and aligned monospace measurements. No new palette, chart, font or UI dependency. Order: native pressure/admission, grouped resource use, owning-work controls, then individual processes. One memory/CPU selector scopes both group and process rankings. On phones the table becomes compact group rows with all three measurements visible; the actual column headers remain accessible. Fold measurement details and private export below the map. Empty, failed, unknown and conflicting identity states stay explicit. See [the resource contract and validation](RESOURCES.md).


## Notification controls, v0.20

The job is to configure an existing destination and resolve delivery problems. Reuse the established cool paper `#f3f7f7`, panel white `#ffffff`, ink `#18343e`, teal action `#12665f` and warning `#80501b`, with the existing dark-theme tokens. Avenir/system type carries controls and explanations; existing monospace remains for native data. No new font, UI dependency or decorative surface is added. A compact Connections section owns setup and receipts; the primary workspace attention list links directly to delivery problems. Private setup uses one scrollable column and a fixed action footer. Unreviewed failures are ordered before recent accepted receipts. Both themes, desktop/mobile action reach, credential clearing and axe are validated. The existing Commands control now derives its accessible name from its visible text.
