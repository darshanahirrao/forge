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

## Initial design plan, v0.14

Treatment: utilitarian. Subject: existing work across native harnesses. Audience: frequent agent users. Job: find and operate the next relevant piece of work with minimal navigation.

Preserve the existing theme tokens: paper `#F3F7F7`, ink `#18343E`, accent `#12665F`, panel `#FFFFFF`, muted text `#4E666E`, structure `#DCE5E7`. Dark variants remain token-based. Avenir Next/system sans is the interface face; SF Mono/system monospace is for paths, shortcuts and aligned measurements. No new fonts or UI dependencies.

Layout: a compact sidebar with daily views above configuration, a small page title, a single operational status row, then attention and a searchable work list. Use separators and rows rather than stacked summary cards. Keep touch targets usable on mobile.

Content order: operational status, exact pending decisions, setup only when needed, managed work and native observations in one filterable list, then a short explanation of observation coverage. The first screen must use real saved activity even when no Forge work records exist. Native metadata must never imply current process ownership or permission authority.

## Operator interface, v0.41

Decision date: 2026-10-18. Checkpoint: `forge-v0.41.0`. This plan supersedes the earlier palette and interface typography, preserving the native review and authority rules.

Treatment: utilitarian. Subject: daily operation across harnesses. Audience: frequent technical operators. Job: scan current work and decisions, find the next item, and act with minimal navigation. Futuristic means precision, aligned information and immediate controls, without ornamental effects.

Forge has its own visual identity: a developer workbench with an activity rail, work queue and separate decision pane. Navigation, type and structure express the operational purpose.

Use cool light paper `#f6f7f8`, white panels, ink `#20262d`, muted text `#58636f`, separators `#dce1e6` and copper `#9c461f`. Dark uses graphite paper `#121518`, panel `#181c20`, ink `#edf0f2`, muted text `#a0abb6`, separators `#2b3239` and copper `#e5aa7a`. Navigation shares the cool neutral surface family. Keep warning/danger colors semantic. Use native system sans for controls and SF Mono/system monospace for structural labels, counts, measurements and keyboard keys. Corners are small and consistent. No new dependency, font, image, gradient, glass effect or decorative animation.

Layout: a 60 px desktop activity rail by default, expandable to 208 px with labels, a 48 px command strip and a fluid work surface. Workspace puts the queue beside a 300 px decision/setup pane; narrow screens put pending decisions before work and setup below the queue. An empty decision region collapses to one line. Compact is the default; Comfortable adds row spacing without changing information or review controls. Desktop density never shrinks phone touch targets. Display preferences are browser-local and shared between local/demo views, with explicit reset controls. Mobile navigation retains labels and closes with Escape, scrim or selection, returning focus to its trigger.

Order: one instrumentation strip, searchable work and exact pending decisions side by side, then setup only when needed, a compact handoff example and coverage. Keep the example readily reachable while moving promotional framing out of the daily work path. Use text hierarchy, tabular metadata and thin separators instead of nested cards. Preserve both themes, all essential values and existing approval semantics.

Keyboard: Ctrl/Cmd K or `/` opens Commands, `N` opens the new-work draft, `?` opens help, Alt+1 through Alt+8 switch views in navigation order, and Ctrl/Cmd+backslash toggles the desktop rail. Single-key shortcuts can be disabled in View options. Single-key/view shortcuts do not intercept editable fields, composed input or modal reviews. No shortcut grants approval, starts native execution or bypasses a review. Discover shortcuts in Help and View options. Collapsed controls keep accessible names, visible focus and hover/focus labels.

Acceptance: render all eight views in both themes at desktop, 805 px Codex-panel and phone widths; check no page overflow, contrast and accessibility, collapsed navigation labels/focus, preference persistence/reset, keyboard guards and unchanged server state. Run the existing browser regressions for reviewed native workflows. UI preference changes require no provider calls, new watcher or server schema migration.

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


## Native OpenClaw schedules, v0.33

Subject: native recurring work and exact pause/resume reviews. Audience: operators replacing native runtimes in one workspace. Job: connect the existing Gateway once, find a job and review its exact current definition before changing future scheduling. Treatment stays utilitarian. Reuse cool paper `#f3f7f7`, panel white `#ffffff`, ink `#18343e`, teal action `#12665f`, muted text `#4e666e` and warning `#80501b`, with existing dark tokens. Avenir/system text carries controls; SF Mono/system monospace carries native definitions and references. No new style, chart, font or UI dependency.

Order: connection reference, native pairing/setup error when needed, saved schedule rows, one exact review and durable outcome receipts. Read the current native definition on demand. Setup stays one column with a scrolling body and fixed action footer. Native authorization remains visible; a device-pairing refusal explains the native repair step. Human review distinguishes whole-store Hermes locking from OpenClaw per-job native revisions. Both themes, keyboard, phone inner overflow, action reach and accessibility are acceptance gates.

## Native profile import, v0.34

Subject: keeping native memory, instructions and compatible skills/configuration when changing Hermes or OpenClaw. Audience: existing harness users. Job: select an existing account, prepare a separate native profile, review what imported or needs manual work, then add the resulting account. Use a compact Accounts section and the existing scrolling dialog body/fixed footer. Reuse paper `#f3f7f7`, white `#ffffff`, ink `#18343e`, action `#12665f`, muted `#4e666e` and warning `#80501b`, their dark tokens, Avenir/system controls and SF Mono/system path text. No new dependency, font or decorative surface. Order: source account, new label/target, preparation, imported/archived/skipped/overflow counts, bounded native item details, explicit review, then account activation. Private paths stay behind details. Local setup authority is explicit; demo/phone setup stays unavailable. Changes, interruption, native version refusal and partial files retain visible failed/held states. Both themes, keyboard, mobile overflow, action reach and axe are required checks.

## Existing chat continuation, v0.37

Subject: continuing completed native Codex work through the existing workspace. Audience: operators with existing chats and accounts. Job: select a chat, retain its native history and reach the normal managed approval path. Reuse the existing paper, panel, ink, teal action, muted/warning colors and dark tokens; Avenir/system text and SF Mono/system paths remain unchanged. No new CSS, dependency, font or decorative surface. Account linking prefills the source home and returns the title/goal/profile draft. Review shows counts, source provider, canonical account/profile/project and a folded history boundary. Linking creates no native execution; the existing launch dialog owns current settlement/context/resource/billing review. Source ownership remains explicit. Both themes, keyboard, mobile overflow, action reach, retained draft, exact approval and reload are checked.
