import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompanionGrant } from '../shared/types.js';
import { Store } from './store.js';
import { assert } from './errors.js';

export const companionPageInput = z
  .object({
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(768)
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
const cursorSchema = z
  .object({
    v: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    before: z.number().int().positive().safe(),
    ceiling: z.number().int().positive().safe(),
  })
  .strict()
  .refine((value) => value.before <= value.ceiling);
type Stream = 'work' | 'events' | 'runs';

/** A cursor selects a bounded insertion window, never authority or a retained SQLite transaction. */
export function companionPage<T>(
  store: Store,
  grant: Pick<CompanionGrant, 'id' | 'lineageId' | 'profileId' | 'root'>,
  stream: Stream,
  input: z.infer<typeof companionPageInput>,
  defaultLimit: number,
  workId?: string,
) {
  const collection = stream === 'work' ? 'work_summaries' : stream;
  const scope = createHash('sha256')
    .update(
      JSON.stringify([grant.lineageId ?? grant.id, grant.profileId, grant.root, stream, workId]),
    )
    .digest('hex');
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (input.cursor) {
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')),
      );
    } catch {
      assert(false, 400, 'This history cursor is invalid. Start a fresh read.');
    }
    assert(cursor.scope === scope, 403, 'This history cursor belongs to a different scope.');
  }
  const ceiling =
    cursor?.ceiling ??
    Number(
      store.db
        .prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM records WHERE collection=?')
        .get(collection)!.value,
    );
  const limit = input.limit ?? defaultLimit;
  const where =
    stream === 'work'
      ? "json_extract(data,'$.profileId')=? AND forge_in_project(?,json_extract(data,'$.cwd'))=1"
      : "json_extract(data,'$.workId')=?";
  const bindings = stream === 'work' ? [grant.profileId, grant.root] : [workId!];
  const total = Number(
    store.db
      .prepare(
        `SELECT COUNT(*) AS value FROM records WHERE collection='${collection}' AND ${where} AND rowid<=?`,
      )
      .get(...bindings, ceiling)!.value,
  );
  const rows = store.db
    .prepare(
      `SELECT rowid, data FROM records WHERE collection='${collection}' AND ${where} AND rowid<=? AND rowid<? ORDER BY rowid DESC LIMIT ?`,
    )
    .all(...bindings, ceiling, cursor?.before ?? ceiling + 1, limit + 1);
  const more = rows.length > limit;
  const kept = rows.slice(0, limit);
  const nextCursor = more
    ? Buffer.from(
        JSON.stringify({
          v: 1,
          scope,
          ceiling,
          before: Number(kept[kept.length - 1].rowid),
        }),
      ).toString('base64url')
    : null;
  return {
    records: kept.map((row) => JSON.parse(String(row.data)) as T),
    page: { nextCursor, total, limit, order: 'newest-insertion-first' as const },
  };
}
