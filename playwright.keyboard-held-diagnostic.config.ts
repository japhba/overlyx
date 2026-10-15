import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const required = [
  'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS', 'OVERLYX_E2E_BASE',
  'OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256', 'OVERLYX_KEYBOARD_HELD_RUN',
];
for (const key of required) if (!process.env[key]) throw new Error(`Keyboard held-request diagnostic requires explicit ${key}.`);
if (process.env.OVERLYX_PROJECTS_DIR !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/projects'
  || process.env.OVERLYX_E2E_CREDENTIALS !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/data/credentials.txt'
  || process.env.OVERLYX_E2E_BASE !== 'http://127.0.0.1:3017'
  || !/^[A-Za-z0-9_-]+$/.test(process.env.OVERLYX_KEYBOARD_HELD_RUN ?? '')) {
  throw new Error('Keyboard held-request diagnostic is restricted to the isolated slide-audit project and private :3017 server.');
}
for (const key of ['OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256']) {
  if (!/^[a-f0-9]{64}$/.test(process.env[key] ?? '')) throw new Error(`Keyboard held-request diagnostic requires a valid immutable ${key}.`);
}

const evidence = path.resolve(`scratch/slide-audit/evidence/keyboard-held/${process.env.OVERLYX_KEYBOARD_HELD_RUN}`);
export default defineConfig({
  testDir: 'e2e',
  testMatch: /diagnostic-keyboard-chunk-held\.spec\.ts$/,
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
    name: 'chromium-v16-keyboard-held',
    use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  }],
  reporter: [['list'], ['json', { outputFile: path.join(evidence, 'report.json') }]],
});
