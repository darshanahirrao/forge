#!/usr/bin/env node
import { launchInstalledService } from '../dist/server/background-service.js';
try {
  await launchInstalledService(process.argv[2], process.argv[3], process.argv[4], process.argv[5]);
} catch {
  console.error(
    'Forge background startup failed. Review service status and the private installation before restarting.',
  );
  process.exitCode = 1;
}
