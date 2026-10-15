import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const required = [
  'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS', 'OVERLYX_E2E_BASE',
  'OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256', 'OVERLYX_FORMULA_PROBE_RUN',
];
for (const key of required) if (!process.env[key]) throw new Error(`New-deck formula diagnostic requires explicit ${key}.`);
if (process.env.OVERLYX_PROJECTS_DIR !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/projects'
  || process.env.OVERLYX_E2E_CREDENTIALS !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/data/credentials.txt'
  || process.env.OVERLYX_E2E_BASE !== 'http://127.0.0.1:3017') {
  throw new Error('New-deck formula diagnostic is restricted to the isolated slide-audit project and private :3017 server.');
}

const run = process.env.OVERLYX_FORMULA_PROBE_RUN!;
const evidence = path.resolve(`scratch/slide-audit/evidence/new-deck-formula/${run}`);
export default defineConfig({
  testDir: 'e2e',
  testMatch: /diagnostic-new-deck-formula\.spec\.ts$/,
  timeout: 150_000,
  globalTimeout: 170_000,
  retries: 0,
  workers: 1,
  outputDir: path.join(evidence, 'playwright-results'),
  use: {
    baseURL: process.env.OVERLYX_E2E_BASE,
    ...devices['Desktop Chrome'],
    headless: true,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium-v15-formula-flow', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 } }],
  reporter: [['list'], ['json', { outputFile: path.join(evidence, 'report.json') }]],
});
