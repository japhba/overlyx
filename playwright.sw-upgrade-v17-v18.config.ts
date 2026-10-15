import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const base = process.env.OVERLYX_E2E_BASE;
const run = process.env.OVERLYX_SW_UPGRADE_RUN;
const evidence = path.resolve('scratch/slide-audit/evidence/sw-v17-v18-upgrade');
const required = [
  'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS', 'OVERLYX_E2E_BASE', 'OVERLYX_SW_UPGRADE_RUN',
  'OVERLYX_SW_UPGRADE_EVIDENCE_DIR', 'OVERLYX_SW_OLD_DIST', 'OVERLYX_SW_NEW_DIST',
  'OVERLYX_EXPECTED_OLD_APP_SHA256', 'OVERLYX_EXPECTED_NEW_APP_SHA256',
];
for (const name of required) if (!process.env[name]) throw new Error(`V17→V18 upgrade diagnostic requires explicit ${name}.`);
if (process.env.OVERLYX_PROJECTS_DIR !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/projects'
  || process.env.OVERLYX_E2E_CREDENTIALS !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/data/credentials.txt'
  || base !== 'http://127.0.0.1:3017'
  || process.env.OVERLYX_SW_UPGRADE_EVIDENCE_DIR !== evidence
  || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(run!)
  || process.env.OVERLYX_SW_OLD_DIST !== '/tmp/overlyx-slide-candidate-v17-7eaed73e/dist'
  || process.env.OVERLYX_SW_NEW_DIST !== '/tmp/overlyx-slide-candidate-v18-PTYGoZnq/dist'
  || process.env.OVERLYX_EXPECTED_OLD_APP_SHA256 !== 'c2e5e2af519c36f02cc4a2d998992159af07add4dda3e7ba72656f3fbcd6f263'
  || process.env.OVERLYX_EXPECTED_NEW_APP_SHA256 !== '3fcea11cb83ef00b6b41bfa42559ea1ebc680ce49106bf4f260f77ebe19f05bc') {
  throw new Error('V17→V18 diagnostic requires the isolated project, exact immutable V17/V18 builds and private :3017 server.');
}

export default defineConfig({
  testDir: 'e2e',
  testMatch: /diagnostic-sw-upgrade-mathkbd\.spec\.ts$/,
  timeout: 350_000,
  globalTimeout: 370_000,
  retries: 0,
  workers: 1,
  outputDir: path.join(evidence, `playwright-results-${run}`),
  use: { baseURL: base, headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{
    name: 'chromium-touch-v17-v18-upgrade',
    use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  }],
  reporter: [['list'], ['json', { outputFile: path.join(evidence, `report-${run}.json`) }]],
});
