import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Approval, Run } from '../shared/types.js';
import type {
  NotificationConfig,
  NotificationReceipt,
  NotificationSnapshot,
} from '../shared/notifications.js';
import { Store, id, now } from './store.js';
import { assert } from './errors.js';
import { readPrivateJson, writePrivateJson } from './private-json.js';
import type { CompanionRuntimeLaunch, CompanionRuntime } from '../shared/companion-runtime.js';

export const notificationOrigin = z
  .string()
  .trim()
  .max(2000)
  .transform((text, context) => {
    try {
      const url = new URL(text);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        !(
          url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        )
      )
        throw new Error();
      return url.origin;
    } catch {
      context.addIssue({
        code: 'custom',
        message:
          'Use an HTTPS server origin, or HTTP on loopback, without a topic, credentials or query.',
      });
      return z.NEVER;
    }
  });
export const notificationSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    serverOrigin: notificationOrigin,
    topic: z.string().regex(/^[A-Za-z0-9_-]{8,120}$/),
    token: z
      .string()
      .trim()
      .max(16384)
      .regex(/^[\x21-\x7e]*$/)
      .default(''),
    kinds: z
      .array(z.enum(['approval', 'completed', 'failed', 'interrupted']))
      .min(1)
      .max(4),
  })
  .strict();
const secretSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    serverOrigin: notificationOrigin,
    topic: z.string().regex(/^[A-Za-z0-9_-]{8,120}$/),
    token: z.string().max(16384),
  })
  .strict();
type Secret = z.infer<typeof secretSchema>;
const messages = {
  approval: [
    'Forge approval needed',
    'A native agent needs your decision. Open Forge to review the exact current request.',
  ],
  completed: [
    'Forge attempt completed',
    'A native attempt completed. Review its output against your acceptance criteria in Forge.',
  ],
  failed: [
    'Forge attempt needs review',
    'A native attempt failed. Review its output and external effects before continuing.',
  ],
  interrupted: [
    'Forge native ownership needs review',
    'A native connection ended or was interrupted. Review its exact owner and outcome before continuing.',
  ],
  test: [
    'Forge notification test',
    'This is your Forge notification test. Open the workspace to review current activity.',
  ],
} as const;

/** Durable observational outbox over ntfy. Delivery never carries native approval authority. */
export class Notifications {
  private secrets = new Map<string, Secret>();
  private unsubscribe: () => void;
  private flushing: Promise<void> | null = null;
  private scheduled = false;
  private dirty = false;
  private closing = false;
  private configuring = false;
  constructor(
    private store: Store,
    private directory: string | undefined,
    readonly reviewOrigin: string,
    private options: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {
    // A process may have died after sending but before recording the acknowledgement.
    for (const row of this.rows("json_extract(data,'$.state')='sending'"))
      this.save({
        ...row,
        state: 'uncertain',
        detail: 'Delivery acknowledgement was lost. Nothing was resent.',
      });
    this.unsubscribe = store.onChange((collections) => {
      if (
        (collections.has('approvals') ||
          collections.has('runs') ||
          collections.has('companion_launches') ||
          collections.has('companion_runtimes')) &&
        this.config()?.enabled
      )
        this.wake();
    });
    this.wake();
  }
  config() {
    return this.store.get<NotificationConfig>('config', 'notifications');
  }
  private filename(key: string) {
    assert(this.directory, 500, 'A persistent private reference directory is required.');
    return join(this.directory, `.forge-notify-${key}.json`);
  }
  private async secret(config: NotificationConfig) {
    const value = secretSchema.parse(
      this.directory
        ? await readPrivateJson(this.filename(config.id))
        : this.secrets.get(config.id),
    );
    assert(
      value.id === config.id && value.serverOrigin === config.serverOrigin,
      409,
      'Notification destination identity changed. Reconnect it.',
    );
    return value;
  }
  private rows(where = '1', limit = 100, attentionFirst = false) {
    return this.store.db
      .prepare(
        `SELECT data FROM records WHERE collection='notifications' AND ${where} ORDER BY ${attentionFirst ? "(json_extract(data,'$.state') IN ('uncertain','failed') AND json_type(data,'$.acknowledgedAt') IS NULL) DESC," : ''}rowid DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => JSON.parse(String(row.data)) as NotificationReceipt);
  }
  private save(row: NotificationReceipt) {
    return this.store.put('notifications', row.id, { ...row, updatedAt: now() });
  }
  snapshot(): NotificationSnapshot {
    const needs = this.store.db
      .prepare(
        "SELECT COUNT(*) AS total FROM records WHERE collection='notifications' AND json_extract(data,'$.state') IN ('uncertain','failed') AND json_type(data,'$.acknowledgedAt') IS NULL",
      )
      .get() as { total: number };
    return {
      config: this.config(),
      receipts: this.rows('1', 100, true),
      needsReview: needs.total,
      reviewOrigin: this.reviewOrigin,
    };
  }
  async configure(value: unknown) {
    const input = notificationSchema.parse(value),
      previous = this.config();
    assert(
      !this.closing && !this.configuring,
      409,
      'Wait for the current notification setup to finish.',
    );
    assert(
      (previous?.revision ?? 0) === input.expectedRevision,
      409,
      'Notification setup changed. Reload before replacing it.',
    );
    assert(
      new Set(input.kinds).size === input.kinds.length,
      400,
      'Choose distinct notification categories.',
    );
    this.configuring = true;
    const key = id();
    let activated = false;
    try {
      const secret: Secret = {
        version: 1,
        id: key,
        serverOrigin: input.serverOrigin,
        topic: input.topic,
        token: input.token,
      };
      if (this.directory) await writePrivateJson(this.filename(key), secret);
      else this.secrets.set(key, secret);
      assert(
        (this.config()?.revision ?? 0) === input.expectedRevision && !this.closing,
        409,
        'Notification setup changed before activation. Reconnect it.',
      );
      const config: NotificationConfig = {
        id: key,
        revision: (previous?.revision ?? 0) + 1,
        enabled: true,
        serverOrigin: input.serverOrigin,
        kinds: input.kinds,
        enabledAt: now(),
      };
      this.store.put('config', 'notifications', config);
      activated = true;
      if (previous) {
        this.secrets.delete(previous.id);
        if (this.directory) await unlink(this.filename(previous.id)).catch(() => {});
      }
      this.wake();
      return this.snapshot();
    } catch (error) {
      if (!activated) {
        this.secrets.delete(key);
        if (this.directory) await unlink(this.filename(key)).catch(() => {});
      }
      throw error;
    } finally {
      this.configuring = false;
    }
  }
  async disconnect(expectedRevision: number) {
    const config = this.config();
    assert(
      config && config.revision === expectedRevision && !this.configuring,
      409,
      'Notification setup changed. Reload before disconnecting.',
    );
    this.store.put('config', 'notifications', {
      ...config,
      enabled: false,
      revision: config.revision + 1,
    });
    this.secrets.delete(config.id);
    if (this.directory) await unlink(this.filename(config.id)).catch(() => {});
    this.wake();
    return this.snapshot();
  }
  test() {
    const config = this.config();
    assert(config?.enabled, 409, 'Connect your notification destination first.');
    const row = this.enqueue(config, 'test', id(), null);
    this.wake();
    return row;
  }
  acknowledge(key: string) {
    const row = this.store.get<NotificationReceipt>('notifications', key);
    assert(
      row && ['uncertain', 'failed'].includes(row.state),
      409,
      'Only a failed or uncertain delivery needs acknowledgement.',
    );
    return row.acknowledgedAt ? row : this.save({ ...row, acknowledgedAt: now() });
  }
  private enqueue(
    config: NotificationConfig,
    kind: NotificationReceipt['kind'],
    referenceId: string,
    workId: string | null,
  ) {
    const key = `${config.id}:${kind}:${referenceId}`;
    const existing = this.store.get<NotificationReceipt>('notifications', key);
    if (existing) return existing;
    return this.save({
      id: key,
      configId: config.id,
      kind,
      referenceId,
      workId,
      state: 'queued',
      createdAt: now(),
      updatedAt: now(),
      detail: 'Waiting for delivery.',
    });
  }
  private collect(config: NotificationConfig) {
    if (config.kinds.includes('failed')) {
      const rows = this.store.db
        .prepare(
          `SELECT l.data FROM records AS l JOIN records AS r
        ON r.collection='companion_runtimes' AND r.id=json_extract(l.data,'$.runtimeId')
        WHERE l.collection='companion_launches' AND json_extract(l.data,'$.state') IN ('unknown','failed')
        AND json_type(r.data,'$.retiredAt') IS NULL AND json_extract(r.data,'$.currentLaunchId')=l.id
        AND COALESCE(json_extract(l.data,'$.endedAt'),json_extract(l.data,'$.updatedAt'),json_extract(l.data,'$.createdAt'))>=?
        AND NOT EXISTS(SELECT 1 FROM records AS n WHERE n.collection='notifications' AND n.id=?||':failed:companion:'||l.id) LIMIT 20`,
        )
        .all(config.enabledAt, config.id);
      for (const row of rows) {
        const launch = JSON.parse(String(row.data)) as CompanionRuntimeLaunch;
        this.enqueue(config, 'failed', `companion:${launch.id}`, null);
      }
    }
    if (config.kinds.includes('approval')) {
      const rows = this.store.db
        .prepare(
          `SELECT data FROM records AS a WHERE collection='approvals'
        AND json_extract(data,'$.status')='pending' AND json_extract(data,'$.expiresAt')>?
        AND NOT EXISTS (SELECT 1 FROM records AS n WHERE n.collection='notifications' AND n.id=?||':approval:'||a.id) LIMIT 20`,
        )
        .all(now(), config.id);
      for (const row of rows) {
        const approval = JSON.parse(String(row.data)) as Approval;
        this.enqueue(config, 'approval', approval.id, approval.workId);
      }
    }
    for (const kind of config.kinds.filter((kind) => kind !== 'approval')) {
      const rows = this.store.db
        .prepare(
          `SELECT data FROM records AS r WHERE collection='runs'
        AND json_extract(data,'$.status')=? AND json_extract(data,'$.endedAt')>=?
        AND NOT EXISTS (SELECT 1 FROM records AS n WHERE n.collection='notifications' AND n.id=?||':'||?||':'||r.id) LIMIT 20`,
        )
        .all(kind, config.enabledAt, config.id, kind);
      for (const row of rows) {
        const run = JSON.parse(String(row.data)) as Run;
        this.enqueue(config, kind, run.id, run.workId);
      }
    }
  }
  private current(row: NotificationReceipt, config: NotificationConfig | null) {
    if (!config?.enabled || row.configId !== config.id) return false;
    if (row.kind === 'test') return true;
    if (!config.kinds.includes(row.kind)) return false;
    if (row.referenceId.startsWith('companion:')) {
      const launch = this.store.get<CompanionRuntimeLaunch>(
          'companion_launches',
          row.referenceId.slice('companion:'.length),
        ),
        runtime = launch
          ? this.store.get<CompanionRuntime>('companion_runtimes', launch.runtimeId)
          : null;
      return Boolean(
        row.kind === 'failed' &&
        launch &&
        ['failed', 'unknown'].includes(launch.state) &&
        runtime &&
        !runtime.retiredAt &&
        runtime.currentLaunchId === launch.id,
      );
    }
    if (row.kind === 'approval') {
      const approval = this.store.get<Approval>('approvals', row.referenceId);
      const work = approval
        ? this.store.get<{ activeRunId: string | null; generation: number }>(
            'work',
            approval.workId,
          )
        : null;
      return Boolean(
        approval?.status === 'pending' &&
        approval.expiresAt > now() &&
        work?.activeRunId === approval.runId &&
        work.generation === approval.generation,
      );
    }
    const run = this.store.get<Run>('runs', row.referenceId);
    return Boolean(run?.endedAt && run.status === row.kind);
  }
  private wake() {
    this.dirty = true;
    if (this.closing || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.flushing && !this.closing) {
        this.flushing = this.flush()
          .catch(() => {})
          .finally(() => {
            this.flushing = null;
            if (this.dirty && !this.closing) this.wake();
          });
      }
    });
  }
  private async flush() {
    for (;;) {
      if (this.closing) return;
      this.dirty = false;
      const config = this.config();
      if (config?.enabled) this.collect(config);
      const saved = this.store.db
        .prepare(
          "SELECT data FROM records WHERE collection='notifications' AND json_extract(data,'$.state')='queued' ORDER BY (json_extract(data,'$.kind')='approval') DESC,rowid ASC LIMIT 1",
        )
        .get();
      const row = saved ? (JSON.parse(String(saved.data)) as NotificationReceipt) : null;
      if (!row) return;
      if (!this.current(row, config)) {
        this.save({
          ...row,
          state: 'withdrawn',
          detail: 'This attention state or destination is no longer current.',
        });
        continue;
      }
      let attempted = false;
      this.save({
        ...row,
        state: 'sending',
        detail: 'Submitting to the configured native notification service.',
      });
      try {
        const secret = await this.secret(config!);
        if (!this.current(row, this.config())) {
          this.save({
            ...row,
            state: 'withdrawn',
            detail: 'The request or destination changed before delivery.',
          });
          continue;
        }
        const [title, body] = row.referenceId.startsWith('companion:')
          ? [
              'Forge native companion needs review',
              'A managed native gateway stopped or lost its owner. Open Forge to review its current lifecycle.',
            ]
          : messages[row.kind];
        attempted = true;
        const response = await (this.options.fetch ?? fetch)(
          `${secret.serverOrigin}/${encodeURIComponent(secret.topic)}`,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              Title: title,
              Priority: row.kind === 'approval' ? 'high' : 'default',
              Click: `${this.reviewOrigin}/#${row.kind === 'approval' ? 'approvals' : 'work'}`,
              ...(secret.token ? { Authorization: `Bearer ${secret.token}` } : {}),
            },
            body,
          },
        );
        await response.body?.cancel();
        this.save({
          ...row,
          state: response.ok ? 'accepted' : 'uncertain',
          detail: response.ok
            ? 'Accepted by ntfy. Delivery to a device is not confirmed.'
            : `Notification service returned HTTP ${response.status}. Nothing was retried.`,
        });
      } catch {
        this.save({
          ...row,
          state: attempted ? 'uncertain' : 'failed',
          detail: attempted
            ? 'Delivery acknowledgement is unavailable. Nothing was retried.'
            : 'Private notification reference is unavailable. Reconnect the destination.',
        });
      }
    }
  }
  async idle() {
    do {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await this.flushing;
    } while (!this.closing && (this.scheduled || this.flushing || this.dirty));
  }
  async close() {
    this.closing = true;
    this.unsubscribe();
    await this.flushing;
    this.secrets.clear();
  }
}
