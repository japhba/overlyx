import { test } from '@playwright/test';
import { login } from './helpers';
test('screenshots', async ({ page }) => {
  await login(page);
  await page.goto('/#/recurrent_feature/main.lyx');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.locator('.panel-tabs button:has-text("✕")').first().click(); // close file browser for space
  await page.locator('.tb-btn[title^="Show notes"]').click();
  await page.waitForTimeout(800);
  await page.evaluate(() => { const el = document.querySelector('.lyx-layout-abstract'); el?.scrollIntoView({ block: 'start' }); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/claude-0/-root-lyx/9250d901-48e6-4b48-98b5-a211e39f6f1d/scratchpad/shot3.png' });
});
