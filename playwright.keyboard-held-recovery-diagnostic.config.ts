import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { assertPrivateDiagnosticFixture } from './e2e/private-diagnostic-fixture';

const required = [
  'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS', 'OVERLYX_E2E_BASE',
  'OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256', 'OVERLYX_EXPECTED_KEYBOARD_SHA256',
  'OVERLYX_KEYBOARD_HELD_RUN', 'OVERLYX_KEYBOARD_TEXT_FALLBACK_BOUND_MS',
];
for (const key of required) if (!process.env[key]) throw new Error(`Keyboard held-recovery diagnostic requires explicit ${key}.`);
assertPrivateDiagnosticFixture({ baseURL: process.env.OVERLYX_E2E_BASE!, projectsDir: process.env.OVERLYX_PROJECTS_DIR! });
if (!/^[A-Za-z0-9_-]+$/.test(process.env.OVERLYX_KEYBOARD_HELD_RUN ?? '')
  || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_APP_SHA256 ?? '')
  || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256 ?? '')
  || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_KEYBOARD_SHA256 ?? '')
  || !/^\d+$/.test(process.env.OVERLYX_KEYBOARD_TEXT_FALLBACK_BOUND_MS ?? '')
  || Number(process.env.OVERLYX_KEYBOARD_TEXT_FALLBACK_BOUND_MS) < 100
  || Number(process.env.OVERLYX_KEYBOARD_TEXT_FALLBACK_BOUND_MS) > 4000) {
  throw new Error('Keyboard held-recovery diagnostic requires valid immutable hashes and a 100–4000 ms bound.');
}

const evidence = path.resolve(`scratch/slide-audit/evidence/keyboard-held-recovery/${process.env.OVERLYX_KEYBOARD_HELD_RUN}`);
export default defineConfig({
  testDir: 'e2e',
  testMatch: /diagnostic-keyboard-chunk-held-recovery\.spec\.ts$/,
  timeout: 150_000,
  globalTimeout: 170_000,
  retries: 0,
  workers: 1,
  outputDir: path.join(evidence, 'playwright-results'),
  use: {
    baseURL: process.env.OVERLYX_E2E_BASE,
    ...devices['Desktop Chrome'],
    headless: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    trace: 'off',
    screenshot: 'off',
  },
  projects: [{
    name: 'chromium-v17-keyboard-held-recovery',
    use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  }],
  reporter: [['list'], ['json', { outputFile: path.join(evidence, 'report.json') }]],
});
