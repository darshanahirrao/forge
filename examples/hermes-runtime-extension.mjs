// Load explicitly after building: forge start --extension ./examples/hermes-runtime-extension.mjs
// This is an example alias of the existing native adapter, not another agent implementation.
import { defineExtension, hermesCompanion } from '@forge-workspace/forge/sdk';

export default defineExtension({
  format: 'forge.extension',
  version: 1,
  id: 'example.hermes-runtime',
  name: 'Example native runtime',
  release: '1.0.0',
  companions: [
    {
      id: 'ext.example.hermes',
      name: 'Hermes through extension',
      contract: 1,
      nativeVersion: '0.17.0',
      profileFiles: ['config.yaml', '.env', 'cron/jobs.json'],
      connect: hermesCompanion,
    },
  ],
});
