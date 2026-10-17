// Installed Hermes, owned isolated profile, native public pause/resume. No tick/model/delivery.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBinary } from '../../server/adapters/discovery.js';
import { hermesPython } from '../../server/adapters/hermes-install.js';
import { hermesEnvironment } from '../../server/adapters/hermes-driver.js';
import type { NativeControlBridge } from '../../server/native-controls.js';

const { nativeControlBridge, NativeControls } = (await import(
  new URL('../../dist/server/native-controls.js', import.meta.url).href
)) as typeof import('../../server/native-controls.js');
const { NativeSources } = (await import(
  new URL('../../dist/server/native-sources.js', import.meta.url).href
)) as typeof import('../../server/native-sources.js');
const { Store } = (await import(
  new URL('../../dist/server/store.js', import.meta.url).href
)) as typeof import('../../server/store.js');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'forge-native-controls-')));
const binary = await findBinary('hermes');
assert.ok(binary, 'Install Hermes to run this explicit conformance check.');
const python = await hermesPython(binary);
const env = { ...hermesEnvironment({ nativeHome: directory }), PYTHONDONTWRITEBYTECODE: '1' };
const exec = promisify(execFile);
async function native(code: string) {
  return (await exec(python, ['-c', code], { env, cwd: directory, timeout: 8000 })).stdout.trim();
}
const helper = fileURLToPath(
  new URL('../../dist/server/adapters/hermes-control.py', import.meta.url),
);
const store = new Store(join(directory, 'owned-workspace.sqlite'));
const sources = new NativeSources(store);
const source = sources.add({
  kind: 'hermes-schedules',
  label: 'Owned native conformance',
  home: directory,
  endpoint: '',
});
let killed = false;
let killObserved = false;
let unexpectedExit = '';
const bridge: NativeControlBridge = async (selected, request) => {
  if (!killed || request.mode !== 'apply') return nativeControlBridge(selected, request);
  // Kill only this owned helper after the native write and before acknowledgement.
  const wrapper = `import os, signal, runpy, cron.jobs as jobs\noriginal = jobs.pause_job\ndef lost(*a, **k):\n result = original(*a, **k)\n os.kill(os.getpid(), signal.SIGKILL)\n return result\njobs.pause_job = lost\nrunpy.run_path(${JSON.stringify(helper)}, run_name='__main__')`;
  await new Promise<void>((_resolve, reject) => {
    const child = execFile(
      python,
      ['-c', wrapper],
      { cwd: directory, env, timeout: 8000 },
      (error, stdout, stderr) => {
        if (error?.signal === 'SIGKILL') {
          killObserved = true;
          reject(new Error('Owned helper acknowledgement lost.'));
        } else {
          unexpectedExit = `Owned helper did not reach SIGKILL: ${stdout} ${stderr}`;
          reject(new Error(unexpectedExit));
        }
      },
    );
    child.stdin?.end(JSON.stringify(request));
  });
  throw new Error('Expected an interrupted owned native helper.');
};
const controls = new NativeControls(store, sources, bridge);
try {
  await writeFile(join(directory, 'config.yaml'), 'cron:\n  provider: builtin\n');
  const jobId = await native(
    `import contextlib, io, json\nwith contextlib.redirect_stdout(io.StringIO()):\n import cron.jobs as jobs\n with jobs._jobs_lock():\n  job = jobs.create_job(prompt='Owned never-executed conformance fixture', schedule='every 30m', name='Owned native control', script='never-executed-owned-fixture.py', no_agent=True, deliver='local')\n  jobs.pause_job(job['id'])\nprint(job['id'])`,
  );
  assert.match(jobId, /^[a-f0-9]{12}$/);
  const input = { sourceId: source.id, jobId, action: 'resume' };
  const definitions = join(directory, 'cron', 'jobs.json');
  const before = await readFile(definitions, 'utf8');
  const preview = await controls.prepare(input);
  assert.equal(await readFile(definitions, 'utf8'), before, 'Preview rewrote native definitions.');
  assert.ok(preview.definition.includes('never-executed-owned-fixture.py'));
  await native(
    `import cron.jobs as jobs\njobs.update_job(${JSON.stringify(jobId)}, {'name':'Changed by native owner'})`,
  );
  assert.equal((await controls.apply(preview.id, { kind: 'local' })).state, 'rejected');
  const resumed = await controls.apply((await controls.prepare(input)).id, { kind: 'local' });
  assert.equal(resumed.state, 'applied');
  assert.equal(resumed.observed?.enabled, true);
  const once = await readFile(definitions, 'utf8');
  await controls.apply(resumed.id, { kind: 'local' });
  assert.equal(
    await readFile(definitions, 'utf8'),
    once,
    'Receipt retry repeated a native operation.',
  );
  const configPlan = await controls.prepare({ ...input, action: 'pause' });
  await writeFile(
    join(directory, 'config.yaml'),
    'cron:\n  provider: builtin\n# native configuration changed\n',
  );
  assert.equal((await controls.apply(configPlan.id, { kind: 'local' })).state, 'rejected');
  killed = true;
  const lost = await controls.apply((await controls.prepare({ ...input, action: 'pause' })).id, {
    kind: 'local',
  });
  assert.equal(lost.state, 'uncertain');
  assert.equal(killObserved, true, unexpectedExit);
  assert.equal(JSON.parse(await readFile(definitions, 'utf8')).jobs[0].enabled, false);
  const afterKill = await readFile(definitions, 'utf8');
  await controls.apply(lost.id, { kind: 'local' });
  assert.equal(await readFile(definitions, 'utf8'), afterKill);
  await assert.rejects(
    controls.apply((await controls.prepare(input)).id, { kind: 'local' }),
    /prior uncertain/,
  );
  await native(`import cron.jobs as jobs\njobs.remove_job(${JSON.stringify(jobId)})`);
  const afterRemoval = await readFile(definitions, 'utf8');
  const reviewed = await controls.review(
    lost.id,
    { kind: 'local' },
    'Verified the owned paused job was removed through its native owner; no tick or delivery was started.',
  );
  assert.equal(reviewed.state, 'uncertain');
  assert.equal(reviewed.review?.observed.enabled, false);
  assert.equal(reviewed.review?.observed.state, 'not-found');
  const lockless = await new Promise<string>((resolve, reject) => {
    const code = `import runpy, cron.jobs as jobs\njobs.fcntl = None\nrunpy.run_path(${JSON.stringify(helper)}, run_name='__main__')`;
    const child = execFile(
      python,
      ['-c', code],
      { env, cwd: directory, timeout: 8000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end(JSON.stringify({ mode: 'preview', action: 'pause', jobId }));
  });
  assert.equal(JSON.parse(lockless).state, 'rejected');
  await writeFile(join(directory, 'config.yaml'), 'cron:\n  provider: fixture-external\n');
  await assert.rejects(controls.prepare(input), /builtin provider/);
  assert.equal(await readFile(definitions, 'utf8'), afterRemoval);
  console.log(
    JSON.stringify({
      status: 'passed',
      contract: preview.contract,
      nativePauseResume: true,
      previewDefinitionsUnchanged: true,
      staleDefinitionAndConfigRejected: true,
      helperSigkillAfterNativeWrite: true,
      uncertainReceiptNotReplayed: true,
      unavailableLockRejected: true,
      nativeRemovalReview: true,
      ticksStarted: 0,
      modelCalls: 0,
      deliveries: 0,
    }),
  );
} finally {
  store.close();
  await rm(directory, { recursive: true, force: true });
}
