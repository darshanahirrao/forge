import { z } from 'zod';
import type { NativeSource } from '../shared/types.js';
import type { PortableSchedule, ScheduleEvidence } from '../shared/schedule-transfers.js';
import { assert } from './errors.js';

export const portableScheduleSchema = z
  .object({
    title: z.string().min(1).max(160),
    prompt: z.string().min(1).max(20000),
    schedule: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('at'), at: z.iso.datetime({ offset: true }) }).strict(),
      z.object({ kind: z.literal('every'), minutes: z.number().int().min(1).max(525600) }).strict(),
      z
        .object({
          kind: z.literal('cron'),
          expr: z
            .string()
            .trim()
            .min(1)
            .max(160)
            .refine((value) => {
              const fields = value.split(/\s+/);
              return fields.length === 5 && fields.every((field) => /^[0-9*,/-]+$/.test(field));
            }, 'Only the common five-field numeric cron syntax can transfer.')
            .transform((value) => value.split(/\s+/).join(' ')),
          tz: z.string().min(1).max(120),
        })
        .strict(),
    ]),
  })
  .strict();

function noOverrides(record: Record<string, unknown>, fields: string[]) {
  for (const key of fields)
    assert(
      record[key] === undefined ||
        record[key] === null ||
        record[key] === false ||
        (Array.isArray(record[key]) && record[key].length === 0),
      409,
      `This schedule uses native ${key}. Recreate that dependency through its native owner before moving it; Forge will not drop it.`,
    );
}
function only(record: Record<string, unknown>, fields: string[]) {
  assert(
    Object.keys(record).every((key) => fields.includes(key)),
    409,
    'This native schedule has additional execution settings. Review it through its native owner before moving it.',
  );
}
export function portableSchedule(
  source: NativeSource,
  evidence: ScheduleEvidence,
): PortableSchedule {
  assert(
    !evidence.noAgent && !evidence.script,
    409,
    'Script and command jobs need native dependency mapping before transfer.',
  );
  const row = JSON.parse(evidence.definition) as Record<string, any>;
  let schedule: PortableSchedule['schedule'];
  if (source.kind === 'hermes-schedules') {
    only(row, [
      'id',
      'name',
      'prompt',
      'skills',
      'skill',
      'model',
      'provider',
      'provider_snapshot',
      'model_snapshot',
      'base_url',
      'script',
      'no_agent',
      'context_from',
      'schedule',
      'schedule_display',
      'repeat',
      'enabled',
      'state',
      'paused_at',
      'paused_reason',
      'created_at',
      'next_run_at',
      'last_run_at',
      'last_status',
      'last_error',
      'last_delivery_error',
      'deliver',
      'origin',
      'enabled_toolsets',
      'workdir',
      'attach_to_session',
    ]);
    noOverrides(row, [
      'skills',
      'skill',
      'model',
      'provider',
      'base_url',
      'script',
      'context_from',
      'enabled_toolsets',
      'workdir',
      'attach_to_session',
      'origin',
    ]);
    assert(
      !row.deliver || row.deliver === 'local',
      409,
      'Move channel delivery through the native runtime before transferring this schedule.',
    );
    assert(
      !row.repeat?.times ||
        (row.schedule?.kind === 'once' && row.repeat.times === 1 && !row.repeat.completed),
      409,
      'Finite or partially completed repeat counts need native reconciliation before transfer.',
    );
    const rule = row.schedule;
    only(rule ?? {}, ['kind', 'minutes', 'run_at', 'expr', 'display']);
    if (rule?.kind === 'once') schedule = { kind: 'at', at: new Date(rule.run_at).toISOString() };
    else if (rule?.kind === 'interval') schedule = { kind: 'every', minutes: rule.minutes };
    else {
      // Hermes cron uses profile timezone; the reviewed helper attaches it without exposing config.
      assert(
        rule?.kind === 'cron' && evidence.timezone,
        409,
        'Read the native profile timezone before moving this cron expression.',
      );
      schedule = { kind: 'cron', expr: rule.expr, tz: evidence.timezone };
    }
  } else {
    assert(
      source.kind === 'openclaw-schedules',
      409,
      'This scheduler has no evaluated transfer provider.',
    );
    assert(
      row.payload?.kind === 'agentTurn' && row.sessionTarget === 'isolated',
      409,
      'Only independent native agent turns can move between these runtimes.',
    );
    only(row, [
      'id',
      'declarationKey',
      'agentId',
      'name',
      'description',
      'displayName',
      'enabled',
      'deleteAfterRun',
      'createdAtMs',
      'updatedAtMs',
      'schedule',
      'sessionTarget',
      'wakeMode',
      'payload',
      'delivery',
      'scheduledToolPolicy',
      'state',
      'configRevision',
      'nextRunAtMs',
      'lastRunAtMs',
      'lastRunStatus',
    ]);
    assert(
      !row.agentId || row.agentId === 'main',
      409,
      'Map a named native agent’s context before moving its schedule.',
    );
    const policy = row.scheduledToolPolicy;
    if (policy)
      assert(
        JSON.stringify(policy) === JSON.stringify({ version: 1, mode: 'trusted' }),
        409,
        'This schedule has a restricted native tool policy. Map its permissions through the native owner before transfer.',
      );
    only(row.payload, ['kind', 'message', 'toolsAllow']);
    assert(
      !row.payload.toolsAllow || JSON.stringify(row.payload.toolsAllow) === '["*"]',
      409,
      'This schedule restricts native tools. Map those permissions through the native owner before transfer.',
    );
    assert(
      row.delivery?.mode === 'none',
      409,
      'Move channel delivery through the native runtime before transferring this schedule.',
    );
    only(row.delivery, ['mode']);
    const rule = row.schedule;
    if (rule?.kind === 'at') {
      only(rule, ['kind', 'at']);
      schedule = { kind: 'at', at: new Date(rule.at).toISOString() };
    } else if (rule?.kind === 'every') {
      only(rule, ['kind', 'everyMs', 'anchorMs']);
      schedule = { kind: 'every', minutes: rule.everyMs / 60000 };
    } else {
      only(rule ?? {}, ['kind', 'expr', 'tz', 'staggerMs']);
      assert(
        rule?.kind === 'cron' && rule.tz && !rule.staggerMs,
        409,
        'A cron transfer needs an explicit timezone and zero native staggering.',
      );
      schedule = { kind: 'cron', expr: rule.expr, tz: rule.tz };
    }
    assert(
      row.deleteAfterRun !== false || schedule.kind !== 'at',
      409,
      'Retained one-shot jobs need native completion-policy mapping before transfer.',
    );
  }
  const portable = portableScheduleSchema.parse({
    title: evidence.title,
    prompt: evidence.prompt,
    schedule,
  });
  if (schedule.kind === 'at')
    assert(
      Date.parse(schedule.at) > Date.now() + 120000,
      409,
      'Move a one-shot at least two minutes before it is due.',
    );
  return portable;
}

export function openClawScheduleDraft(portable: PortableSchedule, marker: string) {
  const s = portable.schedule;
  return {
    name: portable.title,
    declarationKey: marker,
    enabled: false,
    deleteAfterRun: s.kind === 'at',
    agentId: 'main',
    sessionTarget: 'isolated',
    wakeMode: 'next-heartbeat',
    schedule:
      s.kind === 'every'
        ? { kind: 'every', everyMs: s.minutes * 60000 }
        : s.kind === 'cron'
          ? { kind: 'cron', expr: s.expr, tz: s.tz, staggerMs: 0 }
          : s,
    payload: { kind: 'agentTurn', message: portable.prompt },
    delivery: { mode: 'none' },
  };
}
