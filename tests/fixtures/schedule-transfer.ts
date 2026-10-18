import { createHash } from 'node:crypto';
import type { NativeSource } from '../../shared/types.js';
import type { PortableSchedule } from '../../shared/schedule-transfers.js';
import type { NativeControlBridge } from '../../server/native-controls.js';
import type { ScheduleTransferBridge } from '../../server/adapters/schedule-transfer.js';

export function scheduleTransferFixture() {
  const rows = new Map<string, Map<string, any>>();
  let counter = 0;
  const stats = {
    creates: 0,
    controls: 0,
    lostCreate: false,
    lostControl: false,
    rejectControl: false,
    changedDraft: false,
  };
  const jobs = (source: NativeSource) => {
    let items = rows.get(source.id);
    if (!items) rows.set(source.id, (items = new Map()));
    return items;
  };
  const digest = (source: NativeSource) =>
    createHash('sha256')
      .update(JSON.stringify([...jobs(source)]))
      .digest('hex');
  const definition = (p: PortableSchedule, id: string, enabled = false) => ({
    id,
    name: p.title,
    prompt: p.prompt,
    enabled,
    state: enabled ? 'scheduled' : 'paused',
    deliver: 'local',
    schedule:
      p.schedule.kind === 'every'
        ? { kind: 'interval', minutes: p.schedule.minutes }
        : p.schedule.kind === 'at'
          ? { kind: 'once', run_at: p.schedule.at }
          : { kind: 'cron', expr: p.schedule.expr },
  });
  const control: NativeControlBridge = async (source, request) => {
    const row = jobs(source).get(request.jobId);
    if (!row)
      return {
        state: 'absent',
        contract: 'hermes-builtin-native-flock/1',
        jobsDigest: digest(source),
        configDigest: null,
      };
    if (request.mode === 'preview')
      return {
        state: 'preview',
        contract: 'hermes-builtin-native-flock/1',
        jobsDigest: digest(source),
        configDigest: null,
        job: {
          id: row.id,
          title: row.name,
          prompt: row.prompt,
          rule: JSON.stringify(row.schedule),
          script: null,
          definition: JSON.stringify(row),
          state: row.state,
          enabled: row.enabled,
          noAgent: false,
          nextRunAt: null,
          timezone: 'UTC',
        },
      };
    if (request.jobsDigest !== digest(source) || stats.rejectControl)
      return { state: 'rejected', code: 'changed' };
    stats.controls++;
    row.enabled = request.action === 'resume';
    row.state = row.enabled ? 'scheduled' : 'paused';
    if (stats.lostControl) {
      stats.lostControl = false;
      throw new Error('PRIVATE owned acknowledgement failure');
    }
    return {
      state: 'applied',
      observed: {
        state: row.state,
        enabled: row.enabled,
        nextRunAt: null,
        jobsDigest: digest(source),
      },
    };
  };
  const transfer: ScheduleTransferBridge = {
    async draft(source, portable) {
      const row = definition(portable, `owned-target-${++counter}`);
      return {
        jobId: row.id,
        definition: JSON.stringify(row),
        jobsDigest: digest(source),
        configDigest: 'a'.repeat(64),
      };
    },
    async publish(source, draft) {
      if (stats.changedDraft || draft.jobsDigest !== digest(source))
        throw new Error('PRIVATE stale destination');
      stats.creates++;
      jobs(source).set(draft.jobId!, JSON.parse(draft.definition));
      if (stats.lostCreate) {
        stats.lostCreate = false;
        throw new Error('PRIVATE native create reply was lost');
      }
      return draft.jobId!;
    },
    async locate() {
      return null;
    },
  };
  return { rows, jobs, digest, definition, control, transfer, stats };
}
