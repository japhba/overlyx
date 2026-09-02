import { defineConfig } from '@playwright/test';

/**
 * Config for the landing-page demo recorder (record-demos.spec.ts) — not part of the e2e suite.
 * Run from the repo root against an isolated instance (see record-demos.spec.ts):
 *   OVERLYX_E2E_BASE=http://localhost:5175 ... npx playwright test -c scripts/recording
 */
export default defineConfig({
  testDir: '.',
  timeout: 600000,
  retries: 0,
  workers: 1,
  use: { baseURL: process.env.OVERLYX_E2E_BASE ?? 'http://localhost:5175', headless: true },
  reporter: [['list']],
});
