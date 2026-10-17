import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureProvider } from './provider.js';
import type { Approval, Snapshot, Work } from '../../shared/types.js';

await mkdir('artifacts', { recursive: true });
const root = await realpath(
  await mkdtemp(join(process.cwd(), 'artifacts', 'forge-native-recovery-')),
);
const home = join(root, 'codex'),
  project = join(root, 'project'),
  filename = join(root, 'workspace.sqlite');
await mkdir(home);
await mkdir(project);
let tools = 0;
const provider = await fixtureProvider('responses', (body) => {
  assert(body.tools?.some((tool: { name: string }) => tool.name === 'exec_command'));
  const artifact = ++tools === 1 ? 'approved.txt' : 'never-approved.txt';
  return {
    tool: 'exec_command',
    id: `owned-crash-tool-${tools}`,
    input: {
      cmd: `printf 'owned native effect\\n' > ${artifact}`,
      workdir: project,
      max_output_tokens: 1000,
    },
  };
});
await writeFile(
  join(home, 'config.toml'),
  `model = "forge-conformance"\nmodel_provider = "fixture"\ncli_auth_credentials_store = "file"\n[model_providers.fixture]\nname = "Owned recovery fixture"\nbase_url = "${provider.endpoint}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
);
async function host() {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../fixtures/native-recovery-host.mjs', import.meta.url)), filename],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  child.stdout!.resume();
  child.stderr!.resume();
  const [message] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => {
      throw new Error('Owned compiled host exited before ready.');
    }),
  ]);
  const endpoint = message.endpoint as string;
  const call = async <T>(path: string, payload?: unknown): Promise<T> => {
    const response = await fetch(endpoint + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { 'x-forge-csrf': 'owned-native-recovery', 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    assert(response.ok, `${response.status}: ${JSON.stringify(body)}`);
    return body as T;
  };
  const close = async (signal: 'SIGTERM' | 'SIGKILL') => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill(signal);
      await ended;
    }
  };
  return { child, call, close, endpoint };
}
async function until<T>(read: () => Promise<T | undefined>, label: string) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
let original: Awaited<ReturnType<typeof host>> | undefined, replacement: typeof original;
let passed = false;
try {
  original = await host();
  const account = await original.call<{ id: string }>('/api/accounts', {
    label: 'Owned native recovery',
    harness: 'codex',
    nativeHome: home,
    billingMode: 'native',
  });
  const work = await original.call<Work>('/api/work', {
    title: 'Native crash around an external effect',
    project: 'Owned recovery',
    cwd: project,
    goal: 'Perform only the approved synthetic command.',
    harness: 'codex',
    accountId: account.id,
  });
  const run = await original.call<{ id: string }>(`/api/work/${work.id}/launch`, {
    expectedRevision: work.revision,
    allowMetered: true,
  });
  const pending = () =>
    original!
      .call<Snapshot>('/api/snapshot')
      .then((s) => s.approvals.find((a) => a.status === 'pending'));
  const first = await until<Approval>(pending, 'first native review');
  assert(first.command.includes('approved.txt'));
  await original.call(`/api/approvals/${first.id}/decision`, {
    digest: first.digest,
    decision: 'accept',
  });
  const held = await until<Approval>(pending, 'second native review');
  assert.notEqual(held.id, first.id);
  assert(held.command.includes('never-approved.txt'));
  assert.equal(await readFile(join(project, 'approved.txt'), 'utf8'), 'owned native effect\n');
  const requests = provider.requests();
  await original.close('SIGKILL');
  replacement = await host();
  const row = await until(
    async () =>
      (await replacement!.call<Snapshot>('/api/snapshot')).recovery?.rows.find(
        (r) => r.runId === run.id && r.state === 'ready',
      ),
    'signed actual native closure',
  );
  assert.equal(row.method, 'signed-native-close');
  assert.equal(row.native?.reason, 'owner-disconnected');
  const recovered = await replacement.call<Snapshot>('/api/snapshot');
  assert.equal(recovered.approvals.find((a) => a.id === held.id)?.status, 'invalidated');
  const stale = await fetch(replacement.endpoint + `/api/approvals/${held.id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forge-csrf': recovered.csrf },
    body: JSON.stringify({ digest: held.digest, decision: 'accept' }),
  });
  assert.equal(stale.status, 409);
  await stale.body?.cancel();
  await replacement.call(`/api/recovery/${run.id}/reconcile`, {
    expectedRevision: row.revision,
    digest: row.digest,
  });
  assert.equal((await replacement.call<Snapshot>('/api/snapshot')).recovery?.needsReview, 0);
  assert.equal(provider.requests(), requests);
  assert.equal(provider.failure(), null);
  await assert.rejects(access(join(project, 'never-approved.txt')));
  assert.equal(await readFile(join(project, 'approved.txt'), 'utf8'), 'owned native effect\n');
  passed = true;
  console.log(
    JSON.stringify({
      status: 'passed',
      actualNativeHarness: 'codex',
      approvedArtifacts: 1,
      pendingApprovalInvalidated: true,
      originalOwnerSignedClose: true,
      exactReconciliation: true,
      duplicateRequests: 0,
      unapprovedArtifacts: 0,
      paidModelCalls: 0,
    }),
  );
} finally {
  await original?.close('SIGTERM');
  await replacement?.close('SIGTERM');
  await provider.close();
  // Uncertain native state stays available for inspection after a failed gate.
  if (passed) await rm(root, { recursive: true, force: true });
}
