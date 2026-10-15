/** Fresh accounts start with a usable interface and can choose the familiar one later. */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { collectErrors, login, PROJECTS_DIR, userCredentials } from './helpers';

const RUN = Date.now().toString(36);
const created: string[] = [];
function freshUser(browser: string, purpose: string) {
  const credentials = process.env.OVERLYX_E2E_CREDENTIALS;
  if (!credentials || !process.env.OVERLYX_PROJECTS_DIR || !process.env.OVERLYX_E2E_BASE) throw new Error('Onboarding checks need isolated data, projects and a base URL.');
  const username = `onboard-${purpose}-${browser}-${RUN}`;
  execFileSync(process.execPath, ['--import', 'tsx', 'packages/server/src/seed.ts', username, 'Taylor'], {
    env: { ...process.env, OVERLYX_DATA_DIR: dirname(credentials) }, stdio: 'pipe',
  });
  return userCredentials(username);
}
test.afterAll(() => { for (const project of created) rmSync(`${PROJECTS_DIR}/${project}`, { recursive: true, force: true }); });

test('fresh Modern account skips the optional tour, creates a document and keeps its work with phone drawers open', async ({ page, browserName }, info) => {
  const credentials = freshUser(browserName, 'write');
  const errors = collectErrors(page);
  await login(page, credentials, { ui: 'default', tour: true });
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'modern');
  const intro = page.locator('.tour[data-tour-step="intro"] .tour-card');
  await expect(intro).toBeVisible();
  await expect(intro.locator('details')).not.toHaveAttribute('open', '');
  await expect(intro.locator('[data-ui-choice]').first()).not.toBeVisible();
  await intro.getByRole('button', { name: 'Not now', exact: true }).click();
  await page.locator('[data-new-project]').click();
  const name = `e2e-first-document-${RUN}-${browserName}`;
  created.push(`${credentials.username}/${name}`);
  await page.locator('[data-new-kind="doc"]').click();
  await page.locator('[data-new-name]').fill(name);
  await page.locator('[data-new-create]').click();
  const paragraph = page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').first();
  await expect(paragraph).toBeVisible({ timeout: 30000 });
  await paragraph.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Our first community research note.');
  await expect(page.locator('.lyx-editor')).toContainText('Our first community research note.');
  await expect(page.locator('.menubar .save-state')).toHaveClass(/saved/, { timeout: 20000 });
  await page.reload();
  await expect(page.locator('.lyx-editor')).toContainText('Our first community research note.', { timeout: 30000 });
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'modern');
  await expect(page.locator('.tour')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sidebar.left')).toHaveCount(0, { timeout: 5000 });
  await page.locator('[data-rail="versions"]').click();
  const assertEditorFits = async () => {
    const bounds = (await page.locator('.editor-column').boundingBox())!;
    expect(bounds.width).toBeGreaterThan(340);
    expect(bounds.x).toBeGreaterThanOrEqual(-1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  };
  await expect(page.locator('.sidebar.right')).toBeVisible();
  await assertEditorFits();
  await page.locator('.sidebar.right button.hide').click();
  await page.locator('[data-rail="outline"]').click();
  await expect(page.locator('.sidebar.left')).toBeVisible();
  await assertEditorFits();
  await page.screenshot({ path: info.outputPath('modern-first-document-390.png') });
  await page.locator('.sidebar.left button.hide').click();
  await assertEditorFits();
  await expect(paragraph).toBeVisible();
  await paragraph.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Saved after closing the drawer.');
  await expect(page.locator('.menubar .save-state')).toHaveClass(/saved/, { timeout: 20000 });
  await page.reload();
  await expect(page.locator('.lyx-editor')).toContainText('Saved after closing the drawer.', { timeout: 30000 });
  expect(errors.filter(error => !/favicon|net::/.test(error))).toEqual([]);
});

test('optional Classic choice is saved to the account and adopted in a new browser context', async ({ page, browser, browserName }) => {
  const credentials = freshUser(browserName, 'choice');
  await login(page, credentials, { ui: 'default', tour: true });
  const intro = page.locator('.tour[data-tour-step="intro"] .tour-card');
  await expect(intro).toBeVisible();
  await intro.locator('summary').click();
  const saved = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'POST');
  await intro.locator('[data-ui-choice="classic"]').click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'classic');
  await intro.getByRole('button', { name: 'Not now', exact: true }).click();
  const context = await browser.newContext();
  try {
    const fresh = await context.newPage();
    await login(fresh, credentials, { ui: 'default' });
    await expect(fresh.locator('html')).toHaveAttribute('data-ui', 'classic');
  } finally { await context.close(); }
});
