import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };
import { runDoctor } from './doctor.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoots = [
  'package.json',
  '.npmignore',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'BUILD_LOG.md',
  'HANDOFF.md',
  'docs',
  'examples',
  'dist',
  'bin/forge.mjs',
  'bin/doctor.mjs',
  'bin/service-runner.mjs',
  'bin/service-activate.mjs',
];

export async function packRelease(destination = join(root, 'artifacts/releases')) {
  const doctor = await runDoctor();
  if (doctor.status === 'incomplete')
    throw new Error('Build and install Forge before packaging: npm ci && npm run build.');
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version)
    throw new Error('The manifest and dependency lock must have the same release version.');
  const stage = await mkdtemp(join(tmpdir(), 'forge-public-package-'));
  const output = resolve(destination);
  await mkdir(output, { recursive: true });
  try {
    for (const entry of publicRoots) {
      await mkdir(dirname(join(stage, entry)), { recursive: true });
      await cp(join(root, entry), join(stage, entry), { recursive: true });
    }
    // npm honors shrinkwrap inside an installed archive. Do not mutate the source lock.
    await writeFile(join(stage, 'npm-shrinkwrap.json'), JSON.stringify(lock, null, 2) + '\n');
    const args = ['pack', '--json', '--ignore-scripts', '--pack-destination', output];
    const { stdout } = process.env.npm_execpath
      ? await exec(process.execPath, [process.env.npm_execpath, ...args], {
          cwd: stage,
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
        })
      : await exec(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
          cwd: stage,
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
        });
    const [packed] = JSON.parse(stdout);
    const artifact = join(output, packed.filename);
    const unsafe = packed.files.some(
      ({ path }) =>
        /(^|\/)(node_modules|artifacts|runtime|worker-proofs|\.git)(\/|$)/.test(path) ||
        /(^|\/)\.env($|\.)/.test(path) ||
        /\.(map|sqlite(?:-.*)?|db(?:-.*)?|log|key|pem)$/.test(path),
    );
    if (unsafe) {
      await rm(artifact, { force: true });
      throw new Error('A private or development file entered the public archive.');
    }
    const sha256 = createHash('sha256')
      .update(await readFile(artifact))
      .digest('hex');
    await writeFile(join(output, 'SHA256SUMS'), `${sha256}  ${packed.filename}\n`);
    return {
      version: manifest.version,
      artifact,
      sha256,
      integrity: packed.integrity,
      files: packed.files.map((file) => file.path),
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await packRelease();
    console.log(
      JSON.stringify({
        version: result.version,
        artifact: result.artifact,
        sha256: result.sha256,
        files: result.files.length,
      }),
    );
  } catch {
    console.error(
      'Forge packaging failed. Check the build, manifest/lock version and public release files.',
    );
    process.exitCode = 1;
  }
}
