# Retrieve retained companion context

Forge v0.29 extends the existing `forge_workspace` and `forge_work` MCP reads. Native clients can reach older canonical work, events and run receipts without loading all work summaries into JavaScript or adding another tool, search engine or memory store. Existing empty/default calls keep their original arrays and limits.

## Work pages

Call `forge_workspace` with `{ "limit": 40 }`. Its `page` contains `nextCursor`, `total`, `limit` and `order`. Pass `page.nextCursor` as `cursor` to read the next page. Stop when it is null. The default limit is 100; explicit limits range from 1 to 100.

The first call establishes an insertion ceiling. Following its cursors excludes newly inserted records, so new work does not cause duplicates or make earlier work unreachable. Start again without a cursor to discover new work. Order is newest insertion first, matching the earlier view; editing a title does not move it between pages.

This is an insertion window, not a frozen database snapshot. Work edits, deletions and current scope changes remain live. No transaction, resident worker or server-side cursor session is held between reads. SQLite filters the exact current profile and project/subdirectories using the same path containment rule as ordinary work authorization. Neighboring paths and other profiles are excluded from both rows and counts. The indexed summary projection excludes large work context. Startup repairs that projection in batches of at most 128 canonical records instead of loading every saved prompt/context.

## Events and run receipts

`forge_work` accepts independent `events` and `runs` paging options:

```json
{
  "workId": "saved-work-id",
  "events": { "limit": 20 },
  "runs": { "limit": 10 }
}
```

Follow `eventsPage.nextCursor` through `events.cursor`, and `runsPage.nextCursor` through `runs.cursor`. The default event/run limits remain 30 and 10. Explicit limits range from 1 to 100; use smaller pages if large native receipts reach the existing 512 KiB MCP response bound. Each stream has its own insertion ceiling. Neither cursor grants access to another work record.

## Complete event detail

Event-list excerpts remain clipped at 2,000 characters. To retrieve retained detail, call `forge_work` with a `detail` selection:

```json
{
  "workId": "saved-work-id",
  "detail": { "eventId": "saved-event-id", "characters": 8000 }
}
```

`eventDetail` returns `content`, `sha256`, `offset`, `totalCharacters`, `nextOffset` and `offsetUnit`. Read subsequent chunks using the returned `nextOffset` and the same `sha256`, concatenating their strings in order. A nonzero offset requires that digest. A changed event is refused; start its detail read again. Stop when `nextOffset` is null.

Offsets use JavaScript UTF-16 code units. Valid surrogate pairs stay together, so clients in other languages can concatenate the returned text without receiving a split emoji. Use the returned `nextOffset`; manually choosing an offset inside a pair is refused. The default chunk is 8,000 units and explicit bounds are 2 to 16,000. A chunk may be one unit shorter to retain a complete pair. Event IDs must belong to the already authorized work; knowing another ID does not expose its content. A stream still receiving native output can change between calls, so its digest check may require a fresh read.

## Continuity and limits

Cursors bind to stream, work where applicable, profile, project root and original companion lineage. They survive Forge restart and reviewed native connection replacement. An unrelated grant cannot reuse one unchanged. Every read rechecks current grant expiry, revocation and work authority. A cursor is an opaque query continuation, not a signed credential or permission; changing query bounds cannot bypass those checks.

This exposes retained Forge canonical records. It does not import an unobserved native transcript, transfer hidden model state, create a memory extraction loop or certify lossless native-history migration. Native memory remains selected through `forge_context` and its existing reference/scope contract. See [companion access](COMPANION_ACCESS.md), [connection replacement](COMPANION_HANDOFF.md) and the [completion audit](COMPLETION_AUDIT.md).

Verification covers more than two pages of scoped work, concurrent inserts, no bulk summary materialization, independent event/run traversal, complete Unicode detail reconstruction, digest changes, invalid/oversized inputs, cross-scope refusal, revocation, profile changes, SQLite reopening and retained cursors across replacement. Existing native clients keep the same tool names and default calls.
