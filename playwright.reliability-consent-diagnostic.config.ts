import { defineConfig, devices } from '@playwright/test';

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

if (!process.env.OVERLYX_PROJECTS_DIR || !process.env.OVERLYX_E2E_CREDENTIALS || !process.env.OVERLYX_E2E_BASE
  || !process.env.OVERLYX_EXPECTED_APP_SHA256 || !process.env.OVERLYX_EXPECTED_RUNTIME_SHA256) {
  throw new Error('Reliability consent diagnostic requires isolated project/credential/base variables and immutable candidate hashes.');
}

export default defineConfig({
  testDir: 'e2e',
  testMatch: /diagnostic-reliability-consent\.spec\.ts$/,
  timeout: 100_000,
  retries: 0,
  workers: 1,
  outputDir: process.env.OVERLYX_RELIABILITY_DIAG_OUTPUT_DIR ?? `scratch/slide-audit/evidence/reliability-consent/${RUN}/playwright-results`,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.OVERLYX_E2E_BASE,
    headless: true,
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
    hasTouch: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], hasTouch: true, viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 } }],
  reporter: [['list'], ['json', { outputFile: process.env.OVERLYX_RELIABILITY_DIAG_REPORT ?? `scratch/slide-audit/evidence/reliability-consent/${RUN}/report.json` }]],
});
