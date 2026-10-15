/** Saving means a server-confirmed write, not merely a local contenteditable change. */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, PROJECTS_DIR } from './helpers';

const projects: string[] = [];
test.afterAll(() => { for (const key of projects) rmSync(`${PROJECTS_DIR}/${key}`, { recursive: true, force: true }); });

test('offline changes show local durability and return to Saved only after reconnect and disk write', async ({ page }, info) => {
  test.skip(info.project.name === 'webkit', 'WebKit offline emulation leaves existing WebSockets connected; physical Safari remains a release gate.');
  const key = `admin/e2e-save-feedback-${Date.now().toString(36)}-${info.project.name}`;
  projects.push(key);
  const file = `${PROJECTS_DIR}/${key}/slides/index.html`;
  mkdirSync(`${PROJECTS_DIR}/${key}/slides`, { recursive: true });
  writeFileSync(file, '<!doctype html><html><head><meta name="overlyx" content="deck"><style>body{margin:0}.slide{width:1280px;height:720px;position:relative}p{position:absolute;left:100px;top:120px;font:32px sans-serif}</style></head><body><section class="slide"><p>Saved baseline.</p></section></body></html>');
  await login(page);
  await page.request.get('/api/projects');
  await page.goto(`/#/${key}/slides/index.html`);
  const text = page.frameLocator('.dl-frame').locator('section.slide p');
  const status = page.locator('.dl-status');
  await expect(text).toHaveText('Saved baseline.', { timeout: 30000 });
  await expect(status).toHaveText('Saved');
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await text.dblclick();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Kept until reconnect.');
  await page.keyboard.press('Escape');
  await expect(status).toHaveText('Offline — saved in this browser');
  expect(readFileSync(file, 'utf8')).not.toContain('Kept until reconnect.');
  const warned = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(warned, 'a completed browser-storage write permits leaving safely').toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(status).toBeVisible();
  const bounds = (await status.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  await page.context().setOffline(false);
  await expect(status).toHaveText('Saved', { timeout: 25000 });
  expect(readFileSync(file, 'utf8')).toContain('Kept until reconnect.');
  expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })).toBe(false);
  await page.reload();
  await expect(text).toHaveText('Saved baseline. Kept until reconnect.');
});
