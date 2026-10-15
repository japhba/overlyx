import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// Deliberately opt-in: this asynchronous font-retry diagnostic is not part of release/browser gates.
for (const key of ['OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS', 'OVERLYX_E2E_BASE']) {
  if (!process.env[key]) throw new Error(`Math font retry diagnostic requires ${key}.`);
}

export default defineConfig({
  testDir: 'e2e',
  testMatch: /diagnostic-math-font-retry\.spec\.ts$/,
  timeout: 150_000,
  retries: 0,
  workers: 1,
  outputDir: path.resolve('scratch/slide-audit/math-font-retry-results'),
  use: {
    baseURL: process.env.OVERLYX_E2E_BASE,
    ...devices['Desktop Chrome'],
    headless: true,
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
