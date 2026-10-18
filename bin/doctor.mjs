import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const requiredFiles = [
  'dist/package.json',
  'dist/server/index.js',
  'dist/server/store.js',
  'dist/server/native-worker.mjs',
  'dist/server/worker-proof.mjs',
  'dist/server/extension-sdk.js',
  'dist/server/extension-sdk.d.ts',
  'dist/server/adapters/hermes-native.py',
  'dist/server/adapters/hermes-scheduler.py',
  'dist/server/adapters/hermes-control.py',
  'dist/server/adapters/hermes-gateway.py',
  'dist/server/adapters/hermes-schedule-transfer.py',
  'dist/client/index.html',
  'bin/service-runner.mjs',
  'bin/service-activate.mjs',
];
async function regularFile(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch {
    return false;
  }
}
async function availableOnPath(name) {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  // Deliberately do not execute a discovered command, inspect profiles or print its path.
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const filename = join(directory, name + suffix);
      try {
        if (!(await regularFile(filename))) continue;
        await access(filename, constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

export async function runDoctor() {
  const checks = [];
  const nodeReady = Number(process.versions.node.split('.')[0]) >= 24;
  checks.push({
    id: 'node',
    status: nodeReady ? 'pass' : 'fail',
    detail: nodeReady ? 'Node.js 24 or newer is available.' : 'Install Node.js 24 or newer.',
  });
  checks.push({
    id: 'platform',
    status: ['darwin', 'linux'].includes(process.platform) ? 'pass' : 'warn',
    detail: ['darwin', 'linux'].includes(process.platform)
      ? 'This platform is in the macOS/Linux alpha support matrix.'
      : 'This platform is outside alpha acceptance. Original-worker execution and OS controls may be unavailable.',
  });
  let sqlite = false;
  try {
    sqlite = typeof (await import('node:sqlite')).DatabaseSync === 'function';
  } catch {}
  checks.push({
    id: 'sqlite',
    status: sqlite ? 'pass' : 'fail',
    detail: sqlite
      ? 'The built-in SQLite interface is available; no database was opened.'
      : 'Use an official Node.js 24+ build with node:sqlite enabled.',
  });
  const missing = [];
  for (const filename of requiredFiles)
    if (!(await regularFile(join(root, filename)))) missing.push(filename);
  try {
    const compiled = JSON.parse(await readFile(join(root, 'dist/package.json'), 'utf8'));
    if (compiled.version !== manifest.version || compiled.name !== manifest.name)
      missing.push('matching compiled version');
  } catch {
    missing.push('compiled version');
  }
  try {
    const html = await readFile(join(root, 'dist/client/index.html'), 'utf8');
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[a-zA-Z0-9_.\/-]+)"/g)];
    if (!assets.length) missing.push('compiled web assets');
    for (const [, asset] of assets)
      if (asset.includes('..') || !(await regularFile(join(root, 'dist/client', asset.slice(1)))))
        missing.push('compiled web asset');
  } catch {}
  checks.push({
    id: 'build',
    status: missing.length ? 'fail' : 'pass',
    detail: missing.length
      ? 'The compiled app is incomplete. Source checkout: npm ci && npm run build. Release install: reinstall the complete archive.'
      : 'The compiled server, web assets, native helpers and public SDK are present.',
  });
  const missingDependencies = [];
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    try {
      const entry = name === '@modelcontextprotocol/sdk' ? name + '/server/mcp.js' : name;
      if (!(await regularFile(fileURLToPath(import.meta.resolve(entry)))))
        missingDependencies.push(name);
    } catch {
      missingDependencies.push(name);
    }
  }
  checks.push({
    id: 'dependencies',
    status: missingDependencies.length ? 'fail' : 'pass',
    detail: missingDependencies.length
      ? 'Production dependencies are incomplete. Run npm ci in a source checkout, or reinstall the release archive.'
      : 'Production dependency entry points resolve without importing their code.',
  });
  const optionalTools = [];
  for (const name of ['codex', 'claude', 'opencode', 'hermes', 'openclaw', 'tailscale'])
    optionalTools.push({ name, availableOnPath: await availableOnPath(name) });
  return {
    format: 'forge.doctor',
    schemaVersion: 1,
    version: manifest.version,
    status: checks.some((check) => check.status === 'fail')
      ? 'incomplete'
      : checks.some((check) => check.status === 'warn')
        ? 'limited'
        : 'ready',
    checks,
    optionalTools,
    scope:
      'Installation and PATH presence only. No workspace, credential, login, native protocol, account limit, provider or device was checked.',
  };
}

export function printDoctor(report, json) {
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Forge ${report.version} installation: ${report.status}\n`);
    for (const check of report.checks)
      console.log(`${check.status.toUpperCase()} ${check.id}: ${check.detail}`);
    console.log('\nOptional commands on PATH:');
    for (const tool of report.optionalTools)
      console.log(`${tool.name}: ${tool.availableOnPath ? 'found' : 'not found'}`);
    console.log('\nMissing optional commands do not prevent opening Forge.');
    console.log('Sign in, configure and check each native account separately in its harness.');
    console.log(report.scope);
  }
}
