import Fastify from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { ApprovalActor } from '../shared/types.js';
import { assert } from './errors.js';
import { workspaceHeaders } from './http-security.js';

export interface PhoneConfig {
  origin: string;
  users: string[];
  port: number;
}
export interface PhoneBridge {
  origin: string;
  proof: string;
}
const proofHeader = 'x-forge-bridge-proof';
const identityHeader = 'x-forge-bridge-identity';
const loginPattern = /^[A-Za-z0-9][A-Za-z0-9._@+\-]{0,253}$/;
const loopback = (address: string) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

export function phoneConfig(env: NodeJS.ProcessEnv, localPort: number): PhoneConfig | null {
  if (!env.FORGE_PHONE_ORIGIN && !env.FORGE_PHONE_USERS && !env.FORGE_PHONE_PORT) return null;
  assert(
    env.FORGE_PHONE_ORIGIN && URL.canParse(env.FORGE_PHONE_ORIGIN),
    400,
    'FORGE_PHONE_ORIGIN must be your exact HTTPS Tailscale Serve origin.',
  );
  const url = new URL(env.FORGE_PHONE_ORIGIN);
  assert(
    url.protocol === 'https:' &&
      url.hostname.endsWith('.ts.net') &&
      url.pathname === '/' &&
      (!url.port || (Number(url.port) >= 1024 && Number(url.port) <= 65535)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    400,
    'FORGE_PHONE_ORIGIN must be your exact HTTPS Tailscale Serve origin, without a path; an explicit HTTPS port such as 8443 is supported.',
  );
  const users = [
    ...new Set(
      (env.FORGE_PHONE_USERS || '')
        .split(',')
        .map((user) => user.trim())
        .filter(Boolean),
    ),
  ];
  assert(
    users.length > 0 && users.length <= 20 && users.every((user) => loginPattern.test(user)),
    400,
    'Set FORGE_PHONE_USERS to the exact approved Tailscale login names, separated by commas.',
  );
  const port = Number(env.FORGE_PHONE_PORT || 4712);
  assert(
    Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== localPort,
    400,
    'FORGE_PHONE_PORT must be a separate port between 1024 and 65535.',
  );
  return { origin: url.origin, users, port };
}

/** Only the co-owned gateway can attest a remote identity to the local API. */
export function bridgeActor(headers: IncomingHttpHeaders, bridge?: PhoneBridge): ApprovalActor {
  const proof = headers[proofHeader];
  const identity = headers[identityHeader];
  const forwarded = Object.keys(headers).some((key) => key.startsWith('tailscale-'));
  if (proof === undefined && identity === undefined && !forwarded) return { kind: 'local' };
  assert(
    bridge &&
      typeof proof === 'string' &&
      Buffer.byteLength(proof) === Buffer.byteLength(bridge.proof) &&
      timingSafeEqual(Buffer.from(proof), Buffer.from(bridge.proof)) &&
      typeof identity === 'string' &&
      loginPattern.test(identity) &&
      !forwarded,
    403,
    'This request did not come through the private Forge gateway.',
  );
  assert(headers.origin === bridge.origin, 403, 'The private gateway origin did not match.');
  return { kind: 'tailscale', identity };
}

/** Reuse native Serve identity and the maintained Fastify proxy; no public tunnel or login service. */
export async function createPhoneGateway(
  config: PhoneConfig,
  upstream: string,
  bridge: PhoneBridge,
) {
  const target = new URL(upstream);
  assert(
    target.protocol === 'http:' &&
      target.hostname === '127.0.0.1' &&
      target.pathname === '/' &&
      !target.search &&
      !target.hash &&
      !target.username &&
      !target.password,
    400,
    'The phone gateway can only reach the owned local Forge service.',
  );
  assert(
    config.origin === bridge.origin && new URL(config.origin).protocol === 'https:',
    400,
    'The gateway and local service must use the same HTTPS origin.',
  );
  const gateway = Fastify({ logger: false, bodyLimit: 512 * 1024, requestTimeout: 35000 });
  const host = new URL(config.origin).host;
  const allowedHosts = new Set([host, `127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const users = new Set(config.users);
  gateway.addHook('onRequest', async (request, reply) => {
    const localPort = request.raw.socket.localPort;
    const nativeHost =
      localPort &&
      [`127.0.0.1:${localPort}`, `localhost:${localPort}`].includes(request.headers.host || '');
    if (!loopback(request.ip) || (!allowedHosts.has(request.headers.host || '') && !nativeHost))
      return reply.code(403).send({ error: 'Use the configured private Forge address.' });
    const login = request.headers['tailscale-user-login'];
    if (typeof login !== 'string' || !users.has(login))
      return reply.code(401).send({
        error:
          'Private Forge access requires an approved Tailscale identity. Connect through Tailscale Serve.',
      });
    const origin = request.headers.origin;
    const navigation =
      ['GET', 'HEAD'].includes(request.method) &&
      request.headers['sec-fetch-mode'] === 'navigate' &&
      request.headers['sec-fetch-dest'] === 'document';
    if (
      (origin && origin !== config.origin) ||
      (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin !== config.origin) ||
      (request.headers['sec-fetch-site'] === 'cross-site' && !navigation)
    )
      return reply.code(403).send({
        error: 'Open Forge at its configured private HTTPS address before changing anything.',
      });
  });
  gateway.addHook('onSend', async (_request, reply) => {
    workspaceHeaders(reply);
  });
  gateway.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    reply.code(status === 413 ? 413 : 502).send({
      error:
        status === 413
          ? 'This request is too large.'
          : 'The local Forge service could not be reached. Refresh and review the current state before retrying.',
    });
  });
  const { default: proxy } = await import('@fastify/http-proxy');
  await gateway.register(proxy, {
    upstream: target.origin,
    websocket: false,
    retryMethods: [],
    maxRetriesOn503: 0,
    disableRequestLogging: true,
    replyOptions: {
      retriesCount: 0,
      retryDelay: () => null,
      timeout: 35000,
      rewriteRequestHeaders: (request, headers) => {
        const forwarded: IncomingHttpHeaders = {};
        for (const key of [
          'accept',
          'accept-encoding',
          'content-type',
          'content-length',
          'user-agent',
          'range',
          'if-range',
          'x-forge-csrf',
          'x-forge-workspace',
        ])
          if (headers[key] !== undefined) forwarded[key] = headers[key];
        forwarded.host = target.host;
        forwarded.origin = config.origin;
        forwarded[proofHeader] = bridge.proof;
        forwarded[identityHeader] = request.headers['tailscale-user-login'];
        return forwarded;
      },
    },
  });
  return gateway;
}
