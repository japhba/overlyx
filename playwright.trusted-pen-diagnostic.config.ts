import { defineConfig, devices } from '@playwright/test';

if (!process.env.OVERLYX_PROJECTS_DIR || !process.env.OVERLYX_E2E_CREDENTIALS || !process.env.OVERLYX_E2E_BASE) {
  throw new Error('Trusted pen diagnostic requires explicit isolated projects, credentials and base URL.');
}

export default defineConfig({
  testDir: 'e2e',
  testMatch: /diagnostic-deck-trusted-pen-recovery\.spec\.ts$/,
  timeout: 150000,
  retries: 0,
  workers: 1,
  outputDir: process.env.OVERLYX_PEN_DIAG_RESULTS ?? 'scratch/slide-audit/evidence/trusted-pen/playwright-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.OVERLYX_E2E_BASE,
    headless: true,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    hasTouch: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list'], ['json', { outputFile: process.env.OVERLYX_PEN_DIAG_REPORT ?? 'scratch/slide-audit/evidence/trusted-pen/report.json' }]],
});
