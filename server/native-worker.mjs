// A finite native-child owner, not an agent runtime. No HTTP listener, polling or
// provider SDK. The original owner alone can commit input or request native stop.
import { spawn } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { writeWorkerExit, armWorkerProfile } from './worker-proof.mjs';

let configuration,
  descriptor,
  key,
  child,
  releaseProfile,
  stopping = false,
  finished = false;
let reason = 'normal',
  createdAt = new Date().toISOString(),
  timer;
const bootTimer = setTimeout(() => {
  if (!child) {
    if (configuration) stop();
    else process.exit(1);
  }
}, 15000);
process.on('error', () => stop('SIGTERM', true));
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
function complete(code, signal, error = false) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  clearTimeout(bootTimer);
  try {
    if (!descriptor || !key) {
      process.exitCode = 1;
      return;
    }
    writeWorkerExit(
      descriptor,
      {
        contract: 'forge.worker-exit/1',
        id: descriptor.id,
        scopeHash: descriptor.scopeHash,
        guardianPid: process.pid,
        nativePid: child?.pid ?? null,
        started: Boolean(child?.pid),
        code: child?.pid ? (code ?? null) : null,
        signal: signal ?? null,
        nativeClosed: true,
        stdioClosed: true,
        reason: error ? 'spawn-error' : reason,
        createdAt,
        closedAt: new Date().toISOString(),
      },
      key,
    );
    releaseProfile?.();
    process.exitCode = code === 0 && !signal ? 0 : 1;
  } catch {
    // No unsigned success or replacement receipt. The durable fence stays armed.
    process.exitCode = 1;
  } finally {
    configuration = null;
    key = null;
    process.stdin.destroy();
    if (process.connected) process.disconnect();
  }
}
function stop(signal = 'SIGTERM', lost = false) {
  if (finished) return;
  if (lost) {
    reason = 'owner-disconnected';
    process.stdin.unpipe();
    child?.stdout?.unpipe(process.stdout);
    child?.stdout?.resume();
    child?.stderr?.unpipe(process.stderr);
    child?.stderr?.resume();
  } else if (reason === 'normal') reason = 'requested';
  stopping = true;
  if (!child) {
    if (configuration) complete(null, null);
    return;
  }
  child.stdin?.end();
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  if (!timer)
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, configuration.graceMs);
}
process.on('disconnect', () => stop('SIGTERM', true));
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
process.on('message', (message) => {
  try {
    if (message?.type === 'bootstrap' && !configuration && !finished) {
      configuration = message.configuration;
      descriptor = message.descriptor;
      if (
        !configuration ||
        descriptor.guardianPid !== process.pid ||
        !Number.isInteger(configuration.graceMs) ||
        configuration.graceMs < 1 ||
        configuration.graceMs > 360000
      )
        throw new Error();
      key = createPrivateKey({
        key: Buffer.from(message.privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
      message.privateKey = null;
      if (stopping || !process.connected) {
        reason = 'bootstrap-aborted';
        complete(null, null);
        return;
      }
      releaseProfile = armWorkerProfile(configuration.profileRoot, descriptor);
      process.send({ type: 'ready', id: descriptor.id });
    } else if (
      message?.type === 'launch' &&
      configuration &&
      !child &&
      !finished &&
      !stopping &&
      message.id === descriptor.id
    ) {
      clearTimeout(bootTimer);
      child = spawn(configuration.command, configuration.args, {
        cwd: configuration.cwd,
        env: configuration.env,
        stdio: [configuration.input === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      configuration.env = null;
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      child.stdin?.on('error', () => {});
      if (child.stdin) process.stdin.pipe(child.stdin);
      child.once('error', () => {});
      // close, rather than exit, also waits for inherited native stdio to close.
      child.once('close', (code, signal) => complete(code, signal, !child.pid));
      process.send({ type: 'started', id: descriptor.id, nativePid: child.pid ?? null });
    } else if (
      message?.type === 'stop' &&
      ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(message.signal)
    ) {
      stop(message.signal);
    }
  } catch {
    stop();
    if (!child) complete(null, null, true);
  }
});
