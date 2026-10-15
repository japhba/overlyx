import { defineConfig, devices } from '@playwright/test';

// A release gate must never create/delete fixtures in the default production project tree.
if (!process.env.OVERLYX_PROJECTS_DIR || !process.env.OVERLYX_E2E_CREDENTIALS || !process.env.OVERLYX_E2E_BASE) {
  throw new Error('Beta checks require explicit isolated projects, credentials and base URL.');
}
const names = (process.env.OVERLYX_E2E_BROWSERS ?? 'chromium,firefox,webkit').split(',');
const presets = { chromium: devices['Desktop Chrome'], firefox: devices['Desktop Firefox'], webkit: devices['Desktop Safari'] };

export default defineConfig({
  testDir: 'e2e',
  testMatch: /(?:deliverables|deck-[\w-]+|touch-recovery|layout-margins|beta-(?:authoring-recovery|deck-gui|poster-gui|onboarding|nudge-gui))\.spec\.ts$/,
  timeout: 120000, retries: 0, workers: 1,
  outputDir: process.env.OVERLYX_BETA_OUTPUT_DIR ?? 'scratch/slide-audit/beta-browser-results',
  use: { baseURL: process.env.OVERLYX_E2E_BASE, headless: true, viewport: { width: 1400, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: names.map(name => ({ name, use: { ...presets[name as keyof typeof presets], viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 } })),
  reporter: [['list'], ['json', { outputFile: process.env.OVERLYX_BETA_REPORT ?? 'scratch/slide-audit/beta-browser-report.json' }]],
});
