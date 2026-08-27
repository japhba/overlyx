import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  timeout: 90000,
  retries: 0,
  workers: 1,
  use: { baseURL: process.env.OVERLYX_E2E_BASE ?? 'http://localhost:5173', headless: true, viewport: { width: 1400, height: 900 } },
  reporter: [['list']],
});
