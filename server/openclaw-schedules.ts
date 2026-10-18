import { createHash, sign } from 'node:crypto';
import { lstat, mkdir, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { GatewayClient, GatewayClientOptions, DeviceIdentity } from '@openclaw/gateway-client';
import { z } from 'zod';
import type { NativeSource, NativeSchedule } from '../shared/types.js';
import type { NativeControlBridge } from './native-controls.js';
import { newOpenClawIdentity, rawPublicKey } from './adapters/openclaw-identity.js';
import { openClawVersion } from './adapters/openclaw-worker.js';
import { loopbackEndpoint } from './adapters/sources.js';
import { assert, ForgeError } from './errors.js';
import { readPrivateJson, writePrivateJson } from './private-json.js';
import { now } from './store.js';
import { version } from '../shared/version.js';

const allowedScopes = ['operator.read', 'operator.admin'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = (source: NativeSource) =>
  hash([source.id, source.kind, source.endpoint, source.tokenEnv ?? null]);
const privateSchema = z.object({
  version: z.literal(1),
  binding: z.string().length(64),
  pairedRevision: z.number().int().min(0).max(1000000000).optional(),
  sharedCredential: z.boolean().optional(),
  blockedRevision: z.number().int().min(0).max(1000000000).optional(),
  device: z.object({
    deviceId: z.string().regex(/^[a-f0-9]{64}$/),
    publicKeyPem: z.string().max(2048),
    privateKeyPem: z.string().max(4096),
  }),
  auth: z
    .object({ token: z.string().min(1).max(8192), scopes: z.array(z.string().max(80)).max(10) })
    .optional(),
});
type PrivateGrant = z.infer<typeof privateSchema>;
type Client = Pick<GatewayClient, 'start' | 'stopAndWait' | 'request'>;
export type OpenClawScheduleClientFactory = (options: GatewayClientOptions) => Client;
type Method = 'cron.list' | 'cron.get' | 'cron.update';
type Request = (method: Method, params: unknown) => Promise<unknown>;
const jobSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    name: z.string().max(160).optional(),
    enabled: z.boolean(),
    configRevision: z.string().min(1).max(256),
    schedule: z.record(z.string(), z.unknown()),
    payload: z.record(z.string(), z.unknown()),
    nextRunAtMs: z.number().nullable().optional(),
    lastRunAtMs: z.number().nullable().optional(),
    lastRunStatus: z.string().max(160).nullable().optional(),
  })
  .passthrough();
const date = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 8.64e15
    ? new Date(value).toISOString()
    : null;
const state = (job: { enabled: boolean; state?: unknown; runningAtMs?: unknown }) => {
  const running =
    job.runningAtMs ?? (job.state as { runningAtMs?: unknown } | undefined)?.runningAtMs;
  return typeof running === 'number' && Number.isFinite(running) && running > 0
    ? job.enabled
      ? 'running; future enabled'
      : 'running; future paused'
    : job.enabled
      ? 'enabled'
      : 'paused';
};
function bounded(value: unknown, max: number, label: string) {
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  assert(
    typeof encoded === 'string' && Buffer.byteLength(encoded) <= max,
    409,
    `The native ${label} exceeds its review limit. Open it in OpenClaw.`,
  );
  return encoded;
}
function jobReview(value: unknown) {
  bounded(value, 65536, 'job record');
  const job = jobSchema.parse(value),
    payload = job.payload;
  return {
    job,
    fields: {
      id: job.id,
      title: job.name || job.id,
      enabled: job.enabled,
      state: state(job),
      nextRunAt: date(job.nextRunAtMs),
      prompt: bounded(payload.message ?? payload.text ?? '', 20000, 'instructions'),
      script: typeof payload.script === 'string' ? bounded(payload.script, 2000, 'script') : null,
      rule: bounded(job.schedule, 2000, 'schedule'),
      definition: bounded(JSON.stringify(value, null, 2), 65536, 'job record'),
      noAgent: payload.kind === 'command' || payload.kind === 'script',
    },
  };
}

/** Finite, separately paired operator sessions. No native agent, scheduler or auth-store parsing. */
export class OpenClawSchedules {
  private closing = false;
  private clients = new Set<Client>();
  private pending = new Set<Promise<unknown>>();
  private busy = new Set<string>();
  private nativeResponseError?: typeof import('@openclaw/gateway-client').isGatewayProtocolResponseError;
  constructor(
    private directory?: string,
    private factory?: OpenClawScheduleClientFactory,
  ) {}
  private nativeError(error: unknown): error is Error & { details?: unknown } {
    return Boolean(this.nativeResponseError?.(error));
  }
  private path(source: NativeSource) {
    assert(
      this.directory,
      409,
      'OpenClaw schedule pairing requires a persistent private workspace.',
    );
    return join(
      this.directory,
      `.forge-openclaw-source-${z.string().uuid().parse(source.id)}.json`,
    );
  }
  private async saveGrant(source: NativeSource, grant: PrivateGrant) {
    await writePrivateJson(this.path(source), grant);
    if (process.platform !== 'win32') {
      const directory = await open(this.directory!, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
  private async grant(source: NativeSource, reviewedReplacement = false) {
    const path = this.path(source);
    const existing = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    let grant: PrivateGrant;
    if (existing) grant = privateSchema.parse(await readPrivateJson(path));
    else {
      assert(
        !source.checkedAt || reviewedReplacement,
        409,
        'The private scheduler identity is missing. Review scheduler access on the local Forge host before replacing its native pairing.',
      );
      await mkdir(this.directory!, { recursive: true, mode: 0o700 });
      grant = { version: 1, binding: binding(source), device: newOpenClawIdentity().device };
      if (reviewedReplacement)
        grant.pairedRevision = Math.max(source.revision ?? 0, grant.pairedRevision ?? 0);
      await this.saveGrant(source, grant);
    }
    assert(
      grant.binding === binding(source),
      409,
      'The OpenClaw schedule connection changed. Reconnect it before reading native jobs.',
    );
    const raw = rawPublicKey(grant.device.publicKeyPem);
    assert(
      raw === rawPublicKey(grant.device.privateKeyPem) &&
        createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('hex') ===
          grant.device.deviceId,
      409,
      'The private OpenClaw schedule identity is invalid. Keep its file for review.',
    );
    return grant;
  }
  private async connected<T>(
    source: NativeSource,
    body: (request: Request, digest: string) => Promise<T>,
  ): Promise<T> {
    assert(
      !this.closing && source.kind === 'openclaw-schedules',
      409,
      'The native schedule connection is unavailable.',
    );
    const endpoint = loopbackEndpoint.parse(source.endpoint),
      grant = await this.grant(source);
    assert(
      (source.revision ?? 0) >= (grant.pairedRevision ?? 0),
      409,
      'This scheduler access predates its private pairing receipt. Review access locally before reconnecting.',
    );
    const scopes = source.scheduleControls ? [...allowedScopes] : ['operator.read'];
    assert(!this.closing, 409, 'The workspace is closing. No native control was submitted.');
    const reviewedPairing =
      grant.pairedRevision === undefined || (source.revision ?? 0) > grant.pairedRevision;
    assert(
      grant.blockedRevision === undefined || (source.revision ?? 0) > grant.blockedRevision,
      409,
      'The native grant was withdrawn. Review scheduler access on the local Forge host before reconnecting.',
    );
    const bootstrap =
      reviewedPairing || grant.sharedCredential
        ? grant.auth?.token && scopes.every((scope) => grant.auth?.scopes.includes(scope))
          ? undefined
          : source.tokenEnv
            ? process.env[source.tokenEnv]
            : undefined
        : undefined;
    assert(
      grant.auth?.token || bootstrap,
      409,
      grant.pairedRevision === undefined
        ? 'Set the named Gateway bootstrap token outside Forge, then refresh and approve its scheduler device in OpenClaw.'
        : 'The native device grant changed. Review scheduler access on the local Forge host before reconnecting.',
    );
    assert(
      !bootstrap || bootstrap.length <= 8192,
      409,
      'The native Gateway bootstrap reference exceeds its supported size.',
    );
    const sdk = await import('@openclaw/gateway-client');
    this.nativeResponseError = sdk.isGatewayProtocolResponseError;
    let client!: Client,
      active = true,
      authenticated = false;
    let fail!: (error: Error) => void, ready!: () => void;
    let writes = Promise.resolve();
    const hello = new Promise<void>((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    const current = () => {
      assert(
        active && !this.closing,
        409,
        'The native schedule connection closed. Read its current state before retrying.',
      );
    };
    const reject = (error?: Error) =>
      fail(
        new ForgeError(
          409,
          /pairing required/i.test(error?.message ?? '')
            ? `Approve Forge schedules device ${grant.device.deviceId} through native OpenClaw pairing, then refresh. No native control was submitted.`
            : 'The OpenClaw scheduler connection or authorization is unavailable. Check the native Gateway and its approved Forge schedules device, then refresh.',
        ),
      );
    const save = (operation: () => void, revocation = false) => {
      writes = writes.then(async () => {
        if (!revocation) current();
        operation();
        await this.saveGrant(source, grant);
      });
      return writes;
    };
    client = (this.factory ?? ((options) => new sdk.GatewayClient(options)))({
      url: endpoint.replace(/^http/, 'ws'),
      token: bootstrap,
      preferBootstrapToken: Boolean(bootstrap),
      minProtocol: 4,
      maxProtocol: 4,
      clientName: 'gateway-client',
      mode: 'backend',
      clientDisplayName: 'Forge schedules',
      clientVersion: version,
      role: 'operator',
      scopes: [...scopes],
      deviceIdentity: grant.device as DeviceIdentity,
      requestTimeoutMs: 8000,
      hostDeps: {
        signDevicePayload: (pem, payload) =>
          sign(null, Buffer.from(payload), pem).toString('base64url'),
        publicKeyRawBase64UrlFromPem: rawPublicKey,
        loadDeviceAuthToken: ({ deviceId, role }) =>
          deviceId === grant.device.deviceId && role === 'operator' ? (grant.auth ?? null) : null,
        storeDeviceAuthToken: (operation) =>
          save(() => {
            operation.assertCurrent?.();
            assert(
              operation.deviceId === grant.device.deviceId &&
                operation.role === 'operator' &&
                operation.scopes.every((scope) => allowedScopes.includes(scope)),
              409,
              'OpenClaw returned a different operator scope. Review native pairing.',
            );
            grant.auth = { token: operation.token, scopes: operation.scopes };
          }),
        clearDeviceAuthToken: (operation) =>
          save(() => {
            operation.assertCurrent?.();
            assert(
              operation.deviceId === grant.device.deviceId && operation.role === 'operator',
              409,
              'The native device scope changed. Keep the private grant for review.',
            );
            if (!operation.expectedToken || grant.auth?.token === operation.expectedToken) {
              delete grant.auth;
              if (
                grant.pairedRevision !== undefined &&
                (source.revision ?? 0) <= grant.pairedRevision
              )
                grant.blockedRevision = source.revision ?? 0;
            }
          }, true),
      },
      onHelloOk: (peer) => {
        try {
          current();
          assert(
            !authenticated &&
              peer.protocol === 4 &&
              peer.server.version === openClawVersion &&
              scopes.every((scope) => peer.auth?.scopes?.includes(scope)) &&
              ['cron.list', 'cron.get', 'cron.update'].every((method) =>
                peer.features.methods.includes(method),
              ),
            409,
            'The Gateway did not confirm the evaluated native scheduler version, methods and operator scopes.',
          );
          authenticated = true;
          void save(() => {
            grant.pairedRevision = Math.max(source.revision ?? 0, grant.pairedRevision ?? 0);
            grant.sharedCredential = Boolean(bootstrap) && !peer.auth?.deviceToken;
            if (grant.sharedCredential) delete grant.auth;
            delete grant.blockedRevision;
          }).then(ready, fail);
        } catch (error) {
          fail(error as Error);
        }
      },
      onConnectError: (error) => {
        const code =
          this.nativeError(error) && typeof error.details === 'object' && error.details !== null
            ? (error.details as { code?: unknown }).code
            : undefined;
        if (
          typeof code === 'string' &&
          /^(AUTH_|PAIRING_REQUIRED$|DEVICE_)/.test(code) &&
          !code.includes('RATE_LIMIT') &&
          grant.pairedRevision !== undefined &&
          (source.revision ?? 0) <= grant.pairedRevision
        ) {
          void save(() => {
            grant.blockedRevision = source.revision ?? 0;
            delete grant.auth;
          }, true).then(
            () => reject(error),
            () => reject(error),
          );
        } else reject(error);
      },
      onClose: () => {
        if (!authenticated) reject();
        active = false;
      },
      onGap: () => {
        active = false;
      },
      onEvent: (event) => {
        if (event.event === 'shutdown') active = false;
      },
    });
    this.clients.add(client);
    const timeout = setTimeout(() => reject(), 8000);
    try {
      client.start();
      await hello;
      clearTimeout(timeout);
      await writes;
      current();
      const request = async (method: Method, params: unknown) => {
        current();
        const result = await client.request(method, params, { timeoutMs: 8000 });
        current();
        bounded(result, 512 * 1024, 'response');
        return result;
      };
      return await body(
        request,
        hash([
          binding(source),
          grant.device.deviceId,
          scopes,
          source.revision ?? 0,
          openClawVersion,
        ]),
      );
    } finally {
      clearTimeout(timeout);
      active = false;
      await client.stopAndWait().catch(() => {});
      await writes.catch(() => {});
      this.clients.delete(client);
    }
  }
  private run<T>(
    source: NativeSource,
    body: (request: Request, digest: string) => Promise<T>,
  ): Promise<T> {
    assert(
      !this.closing && !this.busy.has(source.id),
      409,
      'Wait for this native scheduler operation before another read or review.',
    );
    this.busy.add(source.id);
    const promise = this.connected(source, body);
    this.pending.add(promise);
    void promise.then(
      () => {
        this.pending.delete(promise);
        this.busy.delete(source.id);
      },
      () => {
        this.pending.delete(promise);
        this.busy.delete(source.id);
      },
    );
    return promise;
  }
  async read(source: NativeSource) {
    return this.run(source, async (request) => {
      const response = z
        .object({
          jobs: z.array(z.unknown()).max(100),
          hasMore: z.boolean().optional(),
          nextOffset: z.number().nullable().optional(),
        })
        .parse(
          await request('cron.list', {
            includeDisabled: true,
            compact: true,
            limit: 100,
            offset: 0,
          }),
        );
      const observedAt = now();
      const schedules: NativeSchedule[] = response.jobs.map((value) => {
        const job = z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
            name: z.string().max(2000).optional(),
            enabled: z.boolean(),
            scheduleKind: z.string().max(80),
            schedule: z.record(z.string(), z.unknown()).optional(),
            runningAtMs: z.number().nullable().optional(),
            nextRunAtMs: z.number().nullable().optional(),
            lastRunAtMs: z.number().nullable().optional(),
            lastRunStatus: z.string().max(160).nullable().optional(),
          })
          .parse(value);
        const rule = JSON.stringify(job.schedule ?? { kind: job.scheduleKind });
        return {
          id: job.id,
          sourceId: source.id,
          title: job.name?.slice(0, 160) || job.id,
          owner: 'openclaw',
          kind: 'OpenClaw native automation',
          state: state(job),
          rule:
            Buffer.byteLength(rule) <= 2000
              ? rule
              : `Native ${job.scheduleKind}; open its definition for details`,
          nextRunAt: date(job.nextRunAtMs),
          lastRunAt: date(job.lastRunAtMs),
          lastOutcome: job.lastRunStatus ?? null,
          observedAt,
        };
      });
      return {
        inventory: {
          sessions: [],
          schedules,
          moreAvailable:
            response.hasMore === true ||
            (response.nextOffset !== undefined && response.nextOffset !== null),
          checkedAt: observedAt,
        },
        capabilities: [
          'OpenClaw Gateway protocol 4; separate signed operator device',
          source.scheduleControls
            ? 'Native administrator access; each schedule change needs human review'
            : 'Read-only operator scope; native schedule changes are disabled',
        ],
      };
    });
  }
  readonly control: NativeControlBridge = async (source, input) => {
    let submitted = false;
    try {
      return await this.run(source, async (request, digest) => {
        assert(
          input.mode === 'preview' || source.scheduleControls,
          409,
          'Enable reviewed scheduler controls from this source on the local Forge host, then approve native administrator pairing.',
        );
        let value: unknown;
        try {
          value = await request('cron.get', { id: input.jobId });
        } catch (error) {
          if (
            this.nativeError(error) &&
            z
              .object({ code: z.literal('CRON_JOB_NOT_FOUND'), jobId: z.literal(input.jobId) })
              .safeParse(error.details).success
          ) {
            return input.mode === 'preview'
              ? {
                  state: 'not-visible',
                  contract: 'openclaw-native-revision/1',
                  jobsDigest: hash(['not-visible-or-absent', input.jobId, digest]),
                  configDigest: digest,
                }
              : { state: 'rejected', code: 'changed' };
          }
          throw error;
        }
        const { job, fields } = jobReview(value);
        if (input.mode === 'preview')
          return {
            state: 'preview',
            contract: 'openclaw-native-revision/1',
            jobsDigest: hash(job.configRevision),
            configDigest: digest,
            job: fields,
          };
        if (
          input.jobsDigest !== hash(job.configRevision) ||
          input.configDigest !== digest ||
          Date.now() > (input.deadline ?? 0)
        )
          return { state: 'rejected', code: 'changed' };
        const desired = input.action === 'resume';
        if (job.enabled === desired)
          return {
            state: 'applied',
            observed: {
              enabled: job.enabled,
              state: state(job),
              nextRunAt: date(job.nextRunAtMs),
              jobsDigest: hash(job.configRevision),
            },
          };
        let response: unknown;
        try {
          submitted = true;
          response = await request('cron.update', {
            id: input.jobId,
            patch: { enabled: desired },
            expectedConfigRevision: job.configRevision,
          });
        } catch (error) {
          if (
            this.nativeError(error) &&
            z.object({ code: z.literal('CRON_JOB_CHANGED') }).safeParse(error.details).success
          )
            return { state: 'rejected', code: 'changed' };
          throw error;
        }
        const updated = jobReview(response).job;
        assert(
          updated.id === job.id && updated.enabled === desired,
          409,
          'Native scheduling acknowledgement changed. Review the current job.',
        );
        return {
          state: 'applied',
          observed: {
            enabled: updated.enabled,
            state: state(updated),
            nextRunAt: date(updated.nextRunAtMs),
            jobsDigest: hash(updated.configRevision),
          },
        };
      });
    } catch (error) {
      if (input.mode === 'apply' && !submitted) return { state: 'rejected', code: 'unavailable' };
      throw error;
    }
  };
  async forget(source: NativeSource) {
    assert(
      !this.busy.has(source.id),
      409,
      'Wait for the native scheduler operation before forgetting this connection.',
    );
    await unlink(this.path(source)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  async nextAccessRevision(source: NativeSource) {
    assert(
      !this.closing && !this.busy.has(source.id),
      409,
      'Wait for the native scheduler before changing its access.',
    );
    const grant = await this.grant(source, true);
    return Math.max(source.revision ?? 0, grant.pairedRevision ?? 0) + 1;
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.clients].map((client) => client.stopAndWait()));
    await Promise.allSettled([...this.pending]);
  }
}
