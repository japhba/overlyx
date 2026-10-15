import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// The release runner supplies a new temporary instance. Never fall back to production data.
for (const key of ['OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS', 'OVERLYX_E2E_BASE', 'OVERLYX_BETA_REPORT_DIR']) {
  if (!process.env[key]) throw new Error(`Release browser checks require ${key}. Use npm run test:beta.`);
}
const report = path.resolve(process.env.OVERLYX_BETA_REPORT_DIR!);
const browsers = [...new Set((process.env.OVERLYX_E2E_BROWSERS ?? 'chromium').split(',')
  .flatMap(s => s.trim() === 'all' ? ['chromium', 'firefox', 'webkit'] : [s.trim()]))];
const presets = { chromium: devices['Desktop Chrome'], firefox: devices['Desktop Firefox'], webkit: devices['Desktop Safari'] };
for (const browser of browsers) if (!(browser in presets)) throw new Error(`Unknown browser: ${browser}`);

export default defineConfig({
  testDir: 'e2e',
  testMatch: /(?:^|\/)(?:dashboard|reliability|sharing|tour|offline(?:-splits)?|deliverables|deck-[\w-]+|touch-recovery|beta-[\w-]+|layout-margins|source-refresh-recovery)\.spec\.ts$/,
  timeout: 120_000, retries: 0, workers: 1,
  outputDir: path.join(report, 'artifacts'),
  use: { baseURL: process.env.OVERLYX_E2E_BASE, headless: true, viewport: { width: 1400, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  // Headless-shell reports the scaled opaque canvas iframe's geometry accurately.
  projects: browsers.map(name => ({ name, use: { ...presets[name as keyof typeof presets], viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 } })),
  reporter: [['list'], ['json', { outputFile: path.join(report, 'browser-results.json') }]],
});
