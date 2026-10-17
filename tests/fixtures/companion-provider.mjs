/** Inert original child for lifecycle UI checks. No model, native service or personal home. */
export const companionProviderFixture = {
  contract: 1,
  nativeVersion: 'fixture-native',
  profileFiles: ['config.yaml'],
  connect: async (_account, root, _credentials, spawn) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready\\n');setInterval(()=>{},1000);",
      ],
      { cwd: root, env: { PATH: process.env.PATH } },
      { input: 'ignore', graceMs: 2000 },
    );
    const lost = new AbortController();
    const exit = new Promise((resolve) =>
      child.once('close', (code, signal) => {
        lost.abort();
        resolve({ clean: code === 0 && signal === null });
      }),
    );
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('close', () => reject(Error('Fixture closed before readiness.')));
    });
    const pid = await child.nativeStarted;
    if (!pid) throw Error('Owned fixture did not start.');
    return {
      pid,
      version: 'fixture-native',
      signal: lost.signal,
      stop: () => {
        child.kill('SIGTERM');
        return exit;
      },
    };
  },
};
