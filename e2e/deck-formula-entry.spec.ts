/** A visible Formula tool must create one formula, not an empty one beside it. */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, PROJECTS_DIR } from './helpers';

const created: string[] = [];
test.afterAll(() => { for (const key of created) rmSync(`${PROJECTS_DIR}/${key}`, { recursive: true, force: true }); });

test('drawing, typing, reopening and emptying a Formula never duplicates its placeholder or traps the editor', async ({ page }, info) => {
  const key = `admin/e2e-formula-entry-${Date.now().toString(36)}-${info.project.name}`;
  created.push(key);
  const file = `${PROJECTS_DIR}/${key}/slides/index.html`;
  mkdirSync(`${PROJECTS_DIR}/${key}/slides`, { recursive: true });
  writeFileSync(file, '<!doctype html><html><head><meta name="overlyx" content="deck"><style>body{margin:0}.slide{width:1280px;height:720px;background:white;position:relative;font:32px sans-serif}</style></head><body data-ol-layout-margins="72px 96px"><section class="slide"></section></body></html>');
  const source = () => readFileSync(file, 'utf8');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page, undefined, { ui: 'default' });
  await page.request.get('/api/projects');
  await page.goto(`/#/${key}/slides/index.html`);
  const slide = page.frameLocator('.dl-frame').locator('section.slide');
  await expect(slide).toBeVisible({ timeout: 30000 });
  await page.locator('[data-tb="dk-formula"]').click();
  const bounds = (await slide.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.55);
  const field = page.locator('[data-dl-mathedit] .lm-field');
  await expect(field).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(250); // The recorded realistic GUI reproduction began typing here.
  await page.keyboard.type('E=\\sum_{i=1}^{n}H_i t_i', { delay: 20 });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 20000 });
  await page.keyboard.press('Escape');
  await expect.poll(source, { timeout: 15000 }).toContain('H_{i}');
  expect(source().match(/\\\[/g)).toHaveLength(1);
  expect(source()).not.toMatch(/\\\[\s*\\\]/);
  const math = slide.locator('mjx-container');
  await expect(math).toHaveCount(1);
  await page.reload();
  await expect(math).toHaveCount(1, { timeout: 30000 });
  await expect(math).toBeVisible();
  const m = (await math.boundingBox())!;
  await page.mouse.dblclick(m.x + m.width / 2, m.y + m.height / 2);
  await expect(field).toBeVisible({ timeout: 15000 });
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 20000 });
  await expect.poll(source, { timeout: 15000 }).not.toContain('H_{i}');
  await expect(math).toHaveCount(0);
  await expect(slide.locator('[contenteditable="true"]')).toHaveCount(0);
  // A successful next action is part of recovery, not just the absence of a modal.
  await page.locator('[data-tb="dk-text"]').click();
  const next = (await slide.boundingBox())!;
  await page.mouse.click(next.x + next.width * 0.3, next.y + next.height * 0.3);
  await expect(slide.locator('[contenteditable="true"]')).toBeVisible();
  await page.keyboard.type('Continue after clearing math', { delay: 20 });
  await page.keyboard.press('Escape');
  await expect.poll(source).toContain('Continue after clearing math');
  expect(errors).toEqual([]);
});
