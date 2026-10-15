/** New users must reach a usable canvas, including the shared template margins. */
import { test, expect } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { login, PROJECTS_DIR } from './helpers';

const created: string[] = [];
test.afterAll(() => { for (const key of created) rmSync(`${PROJECTS_DIR}/${key}`, { recursive: true, force: true }); });

for (const kind of ['deck', 'poster'] as const) test(`GUI + New ${kind} opens, edits, saves and reopens without a stuck Loading state`, async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page, undefined, { ui: 'default' });
  const name = `e2e-new-${kind}-${Date.now().toString(36)}-${info.project.name}`;
  const project = `admin/${name}`;
  created.push(project);
  await page.locator('[data-new-project]').click();
  await page.locator(`[data-new-kind="${kind}"]`).click();
  await page.locator('[data-new-name]').fill(name);
  await page.locator('[data-new-create]').click();
  const heading = page.frameLocator('.dl-frame').locator('section.slide h1').first();
  await expect(heading).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 15000 });
  const dir = kind === 'deck' ? 'slides' : 'poster';
  const source = () => readFileSync(`${PROJECTS_DIR}/${project}/${dir}/index.html`, 'utf8');
  expect(source()).toContain(`data-ol-layout-margins="${kind === 'deck' ? '72px 96px' : '40mm'}"`);
  await heading.dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('A usable starting canvas');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 15000 });
  await expect.poll(source).toContain('A usable starting canvas');
  await page.reload();
  await expect(heading).toHaveText('A usable starting canvas', { timeout: 30000 });
  expect(errors).toEqual([]);
});
