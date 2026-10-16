import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4711',
    trace: 'retain-on-failure',
    launchOptions: process.env.CI ? {} : { channel: 'chrome' },
  },
  webServer: {
    command: 'node tests/e2e-server.mjs',
    url: 'http://127.0.0.1:4711/api/health',
    timeout: 20000,
    reuseExistingServer: false,
  },
});
