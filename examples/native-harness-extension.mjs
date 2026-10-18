// Explicit installed native driver reuse. Loading/linking starts no native worker.
import { defineExtension, CodexDriver, HermesDriver } from '@forge-workspace/forge/sdk';

export default defineExtension({
  format: 'forge.extension',
  version: 1,
  id: 'example.native-harnesses',
  name: 'Example native harnesses',
  release: '1.0.0',
  harnesses: [
    {
      id: 'ext.example.codex',
      name: 'Codex through extension',
      contract: 1,
      nativeVersion: 'Codex app-server',
      profileFiles: ['config.toml'],
      accountReader: 'codex',
      create: () => new CodexDriver(),
    },
    {
      id: 'ext.example.hermes-acp',
      name: 'Hermes through extension',
      contract: 1,
      nativeVersion: 'Hermes ACP 0.17',
      profileFiles: ['config.yaml', '.env'],
      accountReader: 'hermes',
      create: () => new HermesDriver(),
    },
  ],
});
