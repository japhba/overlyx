import { defineConfig, devices } from '@playwright/test';

const base = process.env.OVERLYX_E2E_BASE;
const run = process.env.OVERLYX_SW_UPGRADE_RUN ?? 'r1';
if (process.env.OVERLYX_PROJECTS_DIR !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/projects'
  || process.env.OVERLYX_E2E_CREDENTIALS !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/data/credentials.txt'
  || base !== 'http://127.0.0.1:3017') {
  throw new Error('SW-upgrade diagnostic requires the explicit private slide-audit project, credential and :3017 server paths.');
}

export default defineConfig({
  testDir: 'e2e',
  testMatch: /diagnostic-sw-upgrade-mathkbd\.spec\.ts$/,
  timeout: 350_000,
  globalTimeout: 370_000,
  retries: 0,
  workers: 1,
  outputDir: process.env.OVERLYX_SW_UPGRADE_OUTPUT_DIR ?? `scratch/slide-audit/evidence/sw-v14-v15-upgrade/results-${run}`,
  use: {
    baseURL: base,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'chromium-touch-upgrade-diagnostic',
    use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  }],
  reporter: [['list'], ['json', { outputFile: process.env.OVERLYX_SW_UPGRADE_REPORT ?? `scratch/slide-audit/evidence/sw-v14-v15-upgrade/report-${run}.json` }]],
});
