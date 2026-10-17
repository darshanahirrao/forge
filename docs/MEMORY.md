# Persistent profiles and native memory

Implemented in v0.5. Forge keeps stable profile identities and references to existing native Markdown memory. Native owners continue to curate, edit and search their memory. Forge adds scoped selection, preview, input provenance and continuation checks. It does not implement embeddings, a memory extraction loop, a native memory editor or another memory engine.

Version 0.25 adds reviewed [private portable memory packs](MEMORY_PACKS.md). Selected text can be exported explicitly or copied into independent private Markdown on the same profile. Imports bind local scopes and retain target instructions by default. Native provider search, learning tools and policies stay upstream.

## Configure a profile

Open Memory to create or select a profile. A profile has an immutable ID, a revision, user-authored working instructions, optional Hermes/OpenClaw companion reference and up to eight memory references. Work records select a profile independently of their harness/account. Compatible handoff preserves that profile ID and its references. Choosing a companion reference does not start it or enable managed execution; current companion connections remain observation adapters.

Use Find native files to locate default Hermes/OpenClaw `MEMORY.md` and `USER.md` files, or add an explicit Markdown path from Obsidian or another native owner. Discovery returns paths only. Inspect a file, choose the whole file or a unique heading path, review the selected text, choose its scope and save. Then pin the reference to a profile and save the profile. Native source files are never rewritten or copied into Forge's source registry.

Scopes are explicit:

- Global references apply to work using profiles that pin them.
- Project references apply to a canonical project directory and its descendants, using directory boundaries.
- Work references apply only to one work ID.

References outside a task's scope are skipped before opening their files. Their text and labels are not added to the native prompt or its input receipt. Profile instructions are user-authored common context; choose a separate profile when those instructions should differ by project. References do not follow Markdown/wiki links or recursively ingest a vault.

These scopes govern context added by Forge. A harness can also load its own native project/global instructions or memory and use tools under its native permissions. Selecting a section here does not disable those features or establish filesystem isolation.

## Review and native delivery

The launch dialog reads the current selected sections and displays their profile and applicable references. A new selected context requires review. An unchanged selection previously prepared for the same work is preselected for review, avoiding an extra confirmation click. API launches with selected memory require the matching context-review digest and work revision.

The execution coordinator reserves admission before any asynchronous memory read. It rechecks work revision, quiet/shutdown state and the context seal before creating a native execution driver. Native inventories and other managed launches cannot consume that slot during preparation. Closing Forge waits for preparation to settle and prevents a late worker from starting.

Full-file hashes preserve source provenance. The launch seal binds the actual selected text, source identity, scope and profile/work revisions; an unrelated edit outside the selected section does not invalidate unchanged context. Native file growth or modification during a read is rejected. Input is bounded to UTF-8 Markdown, 1 MiB per source file, 2,000 top-level headings, 32,000 selected profile/memory characters and the existing combined native-input limit. A larger source needs a smaller curated section. Nothing is silently truncated.

Each prepared run records profile/source IDs, scopes, selected-section hashes and file fingerprints, without storing memory text in the registry or input receipt. Selected text is delivered as reference material in the native harness input; it does not grant a tool permission. Native project instructions, tools, permissions and conversation storage remain native. A prepared receipt proves which input Forge constructed, not that a model understood or acted on it.

## Corrections, unpinning and history

Correct a memory file through its native tools or editor. Changed selected content invalidates an old launch review. The next approved launch starts a fresh native conversation, keeping the same Forge work ID and saved earlier history. Earlier native assistant excerpts with a different memory digest are excluded from the new prompt and from newly prepared compatible handoff excerpts. This prevents automatic reintroduction of a corrected or unpinned fact through the portable result cache.

Unpin a source from every profile before forgetting its reference. Forgetting removes the registry entry, not the native file or earlier native/provider conversation history. Work receipts and private capsules retain historical provenance. This is a future-input control, not universal erasure from upstream transcripts or user-authored work notes. Native deletion/export controls remain authoritative.

Capsules carry the prepared context receipt, not a new permanent copy of every native memory file. Keep memory in a durable native store independent of a runtime installation when it must survive removal of that installation. If a required source disappears or its heading becomes ambiguous, Forge blocks that launch instead of silently dropping it. Full native memory/provider migration and search remain with existing implementations; reviewed selected-text snapshots can be retained independently through private memory packs.

## Implementation and evidence

The selector reuses MIT `markdown-it` 15.0.3 parser line maps, including heading hierarchy and fenced-code handling, without rendering HTML. It loads lazily on the first memory inspection. See its upstream [parser architecture](https://github.com/markdown-it/markdown-it/blob/master/docs/architecture.md). Native file choices follow [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) and [OpenClaw memory](https://docs.openclaw.ai/concepts/memory); custom native paths remain explicit because runtime profiles can change their storage locations.

Functional checks cover hierarchy, bytes, bounds, symlinks, ambiguity, scope exclusion, stable identity, companion-reference replacement, revision conflicts, correction/unpinning, compatible excerpt filtering, private blueprint export and asynchronous preparation/shutdown. Eight browser flows include source selection, profile pinning, scoped launch review, light/dark accessibility and mobile geometry. Actual installed Codex and two native Claude API workers passed the three-run handoff with the same profile ID and selected memory marker, excluding an unselected section while producing three native artifacts through local deterministic providers. No paid inference or private user memory was used in that conformance.

Private state is version 3. Existing version-1 or version-2 file workspaces receive a native SQLite `workspace.sqlite.before-v3.UUID.sqlite` rollback copy before upgrade. Older apps refuse newer state. The observed local upgrade preserved four sources, 114 chat observations and 13 schedules, with a private mode-0600 version-2 copy. This is installation-specific preservation evidence, not a universal migration or performance claim.

Live companion execution, native memory-tool/search bridging, verified provider removal/import, arbitrary hidden-state transfer and authenticated phone approval delivery remain separate delivery gates. The full [completion audit](COMPLETION_AUDIT.md) remains active.
