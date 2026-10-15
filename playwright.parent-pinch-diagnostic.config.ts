import { defineConfig, devices } from '@playwright/test';
import releaseConfig from './playwright.release.config';

/** Explicitly opt-in, one-file Chromium calibration; never part of the normal release match. */
export default defineConfig({
  ...releaseConfig,
  testMatch: /(?:^|\/)diagnostic-parent-pinch\.spec\.ts$/,
  retries: 0,
  workers: 1,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 } }],
});
