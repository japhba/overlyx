import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { assertPrivateDiagnosticFixture } from './e2e/private-diagnostic-fixture';

const required = [
  'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS', 'OVERLYX_E2E_BASE',
  'OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256', 'OVERLYX_KEYBOARD_FALLBACK_RUN',
];
for (const key of required) if (!process.env[key]) throw new Error(`Keyboard fallback diagnostic requires explicit ${key}.`);
assertPrivateDiagnosticFixture({ baseURL: process.env.OVERLYX_E2E_BASE!, projectsDir: process.env.OVERLYX_PROJECTS_DIR! });
if (!/^[A-Za-z0-9_-]+$/.test(process.env.OVERLYX_KEYBOARD_FALLBACK_RUN ?? '')) {
  throw new Error('Keyboard fallback diagnostic requires a unique run identifier.');
}
for (const key of ['OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256']) {
  if (!/^[a-f0-9]{64}$/.test(process.env[key] ?? '')) throw new Error(`Keyboard fallback diagnostic requires a valid immutable ${key}.`);
}

const evidence = path.resolve(`scratch/slide-audit/evidence/keyboard-fallback/${process.env.OVERLYX_KEYBOARD_FALLBACK_RUN}`);
export default defineConfig({
  testDir: 'e2e',
  testMatch: /diagnostic-keyboard-chunk-fallback\.spec\.ts$/,
  timeout: 150_000,
  globalTimeout: 170_000,
  retries: 0,
  workers: 1,
  outputDir: path.join(evidence, 'playwright-results'),
  use: {
    baseURL: process.env.OVERLYX_E2E_BASE,
    headless: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    trace: 'off',
    screenshot: 'off',
  },
  projects: [{
    name: 'chromium-v16-keyboard-fallback',
    use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  }],
  reporter: [['list'], ['json', { outputFile: path.join(evidence, 'report.json') }]],
});
