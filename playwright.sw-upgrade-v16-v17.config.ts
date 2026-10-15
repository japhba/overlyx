import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const base = process.env.OVERLYX_E2E_BASE;
const run = process.env.OVERLYX_SW_UPGRADE_RUN;
const evidence = path.resolve('scratch/slide-audit/evidence/sw-v16-v17-upgrade');
const required = [
  'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS', 'OVERLYX_E2E_BASE', 'OVERLYX_SW_UPGRADE_RUN',
  'OVERLYX_SW_UPGRADE_EVIDENCE_DIR', 'OVERLYX_SW_OLD_DIST', 'OVERLYX_SW_NEW_DIST',
  'OVERLYX_EXPECTED_OLD_APP_SHA256', 'OVERLYX_EXPECTED_NEW_APP_SHA256',
];
for (const name of required) if (!process.env[name]) throw new Error(`V16→V17 upgrade diagnostic requires explicit ${name}.`);
if (process.env.OVERLYX_PROJECTS_DIR !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/projects'
  || process.env.OVERLYX_E2E_CREDENTIALS !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/data/credentials.txt'
  || base !== 'http://127.0.0.1:3017'
  || process.env.OVERLYX_SW_UPGRADE_EVIDENCE_DIR !== evidence
  || process.env.OVERLYX_SW_OLD_DIST !== '/tmp/overlyx-slide-candidate-v16-bdc6acfd/dist'
  || !process.env.OVERLYX_SW_NEW_DIST!.startsWith('/tmp/overlyx-slide-candidate-v17-')
  || !process.env.OVERLYX_SW_NEW_DIST!.endsWith('/dist')
  || process.env.OVERLYX_EXPECTED_OLD_APP_SHA256 !== 'ee4050aa48967cc4f79a1e42c28efc04215756647bc869ab2c696b1a7d42eef8') {
  throw new Error('V16→V17 diagnostic requires the isolated project, V16 old build, explicit V17 candidate and private :3017 server.');
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
    name: 'chromium-touch-v16-v17-upgrade',
    use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  }],
  reporter: [['list'], ['json', { outputFile: path.join(evidence, `report-${run}.json`) }]],
});
