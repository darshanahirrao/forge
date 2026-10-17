// Actual native Gateway, compiled ownership/SDK recovery, no agent/model input.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, realpath, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureProvider } from './provider.js';
import { readWorkerExit } from '../../server/worker-proof.mjs';

await mkdir('artifacts', { recursive: true });
const root = await realpath(
  await mkdtemp(join(process.cwd(), 'artifacts', 'forge-openclaw-cold-')),
);
const home = join(root, 'profile'),
  project = join(root, 'project');
await mkdir(home, { mode: 0o700 });
await mkdir(project, { mode: 0o700 });
const provider = await fixtureProvider('chat', () => {
  throw new Error('Cold recovery must not invoke inference.');
});
const config = JSON.stringify({
  gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'token' }, reload: { mode: 'off' } },
  agents: {
    defaults: {
      workspace: project,
      skipBootstrap: true,
      heartbeat: { every: '0m' },
      model: { primary: 'forge/proof' },
    },
  },
  cron: { enabled: false },
  tools: { exec: { host: 'gateway', mode: 'ask' }, fs: { workspaceOnly: true } },
  models: {
    providers: {
      forge: {
        baseUrl: `${provider.endpoint}/v1`,
        apiKey: 'synthetic-cold-recovery-only',
        api: 'openai-completions',
        models: [
          {
            id: 'proof',
            name: 'Inert cold recovery fixture',
            reasoning: false,
            input: ['text'],
            contextWindow: 32768,
            maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
});
await writeFile(join(home, 'openclaw.json'), config, { mode: 0o600 });
await writeFile(
  join(root, 'account.json'),
  JSON.stringify({
    id: randomUUID(),
    label: 'Owned cold recovery fixture',
    harness: 'openclaw',
    nativeHome: home,
    credentialEnv: '',
    billingMode: 'native',
    status: 'connected',
    model: '',
  }),
  { mode: 0o600 },
);
const helpers: ReturnType<typeof spawn>[] = [];
async function host() {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../fixtures/openclaw-recovery-host.mjs', import.meta.url)), root],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  helpers.push(child);
  child.stdout!.resume();
  child.stderr!.resume();
  const [message] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => {
      throw new Error('Native recovery helper exited before readiness.');
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Native recovery helper readiness timed out.')),
        45000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(message.type, 'ready');
  return child;
}
async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.send('stop');
  const [code, signal] = await ended;
  assert.equal(code, 0);
  assert.equal(signal, null);
}
const marker = () => readFile(join(home, '.forge-openclaw.json'), 'utf8').then(JSON.parse);
let passed = false;
try {
  const original = await host();
  const first = await marker();
  assert.equal(first.version, 2);
  assert.equal(first.cleanExit, false);
  assert(first.closure);
  const ended = once(original, 'exit');
  original.kill('SIGKILL');
  await ended;
  const until = Date.now() + 45000;
  let proof: ReturnType<typeof readWorkerExit> | undefined;
  while (Date.now() < until) {
    try {
      proof = readWorkerExit(first.closure.descriptor);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert(proof, 'Original native closure must be signed after parent loss.');
  assert.equal(proof.payload.reason, 'owner-disconnected');
  assert.equal(proof.payload.nativeClosed, true);
  assert.equal(proof.payload.stdioClosed, true);
  assert.equal((await marker()).cleanExit, false, 'The killed parent cannot clear its SDK marker.');
  const replacement = await host();
  const second = await marker();
  assert.equal(second.cleanExit, false);
  assert.equal(second.device.deviceId, first.device.deviceId);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.notEqual(second.closure.descriptor.id, first.closure.descriptor.id);
  assert.deepEqual(second.device, first.device);
  await stop(replacement);
  assert.equal((await marker()).cleanExit, true);
  const previousPath = process.argv
    .find((arg) => arg.startsWith('--previous-worker='))
    ?.slice('--previous-worker='.length);
  let previousReaderRefused: boolean | null = null;
  if (previousPath) {
    const previous = await import(pathToFileURL(previousPath).href);
    assert.equal(previous.newOpenClawIdentity().version, 1);
    const before = await readFile(join(home, '.forge-openclaw.json'), 'utf8');
    const account = JSON.parse(await readFile(join(root, 'account.json'), 'utf8'));
    let olderStarts = 0;
    await assert.rejects(
      previous.openClawWorker(account, project, undefined, () => {
        olderStarts++;
        throw new Error('The prior reader must refuse before native startup.');
      }),
      (error: unknown) =>
        Boolean(
          (error as { issues?: { path?: unknown[] }[] }).issues?.some(
            (issue) => issue.path?.[0] === 'version',
          ),
        ),
    );
    assert.equal(olderStarts, 0);
    assert.equal(await readFile(join(home, '.forge-openclaw.json'), 'utf8'), before);
    previousReaderRefused = true;
  }
  assert.equal(readWorkerExit(first.closure.descriptor).digest, proof.digest);
  assert.equal(await readFile(join(home, 'openclaw.json'), 'utf8'), config);
  assert.equal((await stat(join(home, '.forge-openclaw.json'))).mode & 0o777, 0o600);
  assert.equal(provider.requests(), 0);
  assert.equal(provider.failure(), null);
  passed = true;
  console.log(
    JSON.stringify({
      status: 'passed',
      actualNativeHarness: 'openclaw',
      nativeStarts: 2,
      killedOwnedHosts: 1,
      originalOwnerSignedClose: true,
      exactSdkMarkerRecovered: true,
      sameDeviceIdentity: true,
      oldProofRetained: true,
      nativeConfigurationUnchanged: true,
      previousReaderRefused,
      modelRequests: 0,
      paidModelCalls: 0,
      personalProfileChanged: false,
    }),
  );
} finally {
  for (const child of helpers) await stop(child);
  await provider.close();
  if (passed) await rm(root, { recursive: true, force: true });
}
