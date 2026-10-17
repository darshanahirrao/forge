import { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
import { Store } from '../../server/store.js';
import { WorkerSupervisions, type SupervisedChild } from '../../server/worker-supervision.js';
import { ExecutionController } from '../../server/execution.js';
import type { DriverContext, DriverSink, NativeDriver } from '../../server/adapters/driver.js';
import { supervisedContext } from './supervised-context.js';

const store = new Store(process.argv[2]);
const directory = dirname(process.argv[2]);
const { work } = supervisedContext(store, directory);
const supervision = new WorkerSupervisions(store, join(directory, 'worker-proofs'));
let native: SupervisedChild;
let ready: () => void;
const started = new Promise<void>((resolve) => {
  ready = resolve;
});
class FixtureDriver implements NativeDriver {
  readonly harness = 'codex';
  closed = false;
  async start(context: DriverContext, sink: DriverSink) {
    native = context.spawnNative!(
      process.execPath,
      [
        fileURLToPath(new URL('./supervised-native.mjs', import.meta.url)),
        join(directory, 'effect.txt'),
      ],
      {
        cwd: directory,
        env: { SYNTHETIC_PRIVATE_RECOVERY_KEY: 'do-not-persist-worker-configuration' },
      },
    );
    native.stdout.resume();
    native.stderr.resume();
    await sink.worker?.(native.pid!);
    if (!(await native.nativeStarted)) throw new Error('Synthetic native startup failed.');
    sink.session('supervised-native-session');
    sink.turn('supervised-native-turn');
    sink.approval({
      requestId: 'owned-fixture-request',
      method: 'owned/review',
      sessionId: 'supervised-native-session',
      turnId: 'supervised-native-turn',
      params: {},
      title: 'Owned pending approval',
      detail: 'Must never be replayed.',
      command: 'owned-fixture-review',
      cwd: directory,
      respond: () => {
        throw new Error('Approval was replayed.');
      },
    });
    ready();
  }
  async interrupt() {
    native?.kill('SIGTERM');
  }
  async close() {
    this.closed = true;
    if (native && native.exitCode === null && native.signalCode === null) {
      const ended = once(native, 'exit');
      native.kill('SIGTERM');
      await ended;
    }
  }
}
const controller = new ExecutionController(
  store,
  () => new FixtureDriver(),
  undefined,
  undefined,
  undefined,
  undefined,
  supervision,
);
const run = await controller.launch(work.id, true, false);
await started;
process.send?.({ type: 'ready', runId: run.id, guardianPid: native!.pid });
process.on('message', (message: string) => {
  if (message === 'kill-owned-guardian') {
    ChildProcess.prototype.kill.call(native, 'SIGKILL');
    process.send?.({ type: 'guardian-killed' });
  }
});
