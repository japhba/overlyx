import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { assertPrivateDiagnosticFixture, readFinalDiagnosticCandidateProof } from './e2e/private-diagnostic-fixture';

const required = ['OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS', 'OVERLYX_E2E_BASE',
  'OVERLYX_SW_UPGRADE_RUN', 'OVERLYX_SW_UPGRADE_EVIDENCE_DIR', 'OVERLYX_SW_OLD_DIST',
  'OVERLYX_SW_NEW_DIST', 'OVERLYX_EXPECTED_OLD_APP_SHA256', 'OVERLYX_EXPECTED_NEW_APP_SHA256'];
for (const key of required) if (!process.env[key]) throw new Error('Final upgrade diagnostic requires all explicit private inputs.');
assertPrivateDiagnosticFixture({ baseURL: process.env.OVERLYX_E2E_BASE!, projectsDir: process.env.OVERLYX_PROJECTS_DIR! });
const proof = readFinalDiagnosticCandidateProof();
const run = process.env.OVERLYX_SW_UPGRADE_RUN!;
const evidence = path.resolve(process.env.OVERLYX_SW_UPGRADE_EVIDENCE_DIR!);
if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(run) ||
  path.dirname(evidence) !== path.resolve('scratch/slide-audit/evidence/sw-v18-final-upgrade') ||
  path.basename(evidence) !== run ||
  process.env.OVERLYX_SW_OLD_DIST !== '/tmp/overlyx-slide-candidate-v18-PTYGoZnq/dist' ||
  process.env.OVERLYX_EXPECTED_OLD_APP_SHA256 !== '3fcea11cb83ef00b6b41bfa42559ea1ebc680ce49106bf4f260f77ebe19f05bc' ||
  process.env.OVERLYX_SW_NEW_DIST !== proof.dist || process.env.OVERLYX_EXPECTED_NEW_APP_SHA256 !== proof.appSha256) {
  throw new Error('Final upgrade diagnostic requires exact preserved V18 and approved final candidate bytes.');
}
export default defineConfig({
  testDir: 'e2e', testMatch: /diagnostic-sw-upgrade-mathkbd\.spec\.ts$/,
  timeout: 350_000, globalTimeout: 370_000, retries: 0, workers: 1,
  outputDir: path.join(evidence, `playwright-results-${run}`),
  use: { baseURL: process.env.OVERLYX_E2E_BASE, headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium-touch-v18-final-upgrade', use: { ...devices['Desktop Chrome'],
    viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } }],
  reporter: [['list'], ['json', { outputFile: path.join(evidence, `report-${run}.json`) }]],
});
