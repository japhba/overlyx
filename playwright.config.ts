import { defineConfig, devices } from '@playwright/test';

/**
 * Browsers: Chromium by default; OVERLYX_E2E_BROWSERS=firefox, =webkit (Safari's engine), or a comma
 * list / "all" runs the suite in those (each as its own project, so failures name the browser).
 */
const browsers = (process.env.OVERLYX_E2E_BROWSERS ?? 'chromium').split(',').map(s => s.trim()).flatMap(s => s === 'all' ? ['chromium', 'firefox', 'webkit'] : [s]);
const device = { chromium: devices['Desktop Chrome'], firefox: devices['Desktop Firefox'], webkit: devices['Desktop Safari'] } as const;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90000,
  retries: 0,
  workers: 1,
  use: { baseURL: process.env.OVERLYX_E2E_BASE ?? 'http://localhost:5173', headless: true, viewport: { width: 1400, height: 900 } },
  projects: browsers.map(name => ({
    name,
    use: { ...device[name as keyof typeof device], viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 },
  })),
  reporter: [['list']],
});
