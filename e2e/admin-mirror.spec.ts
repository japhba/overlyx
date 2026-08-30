/**
 * Administrators do not see other people's projects: the start screen lists them under
 * "Administration", opening one is an explicit one-hour grant that the owner sees in the project's
 * activity log (Share dialog). The Git dialog shows the off-site mirror's state (the isolated e2e
 * server mirrors into bare repositories on disk, OVERLYX_MIRROR_URL).
 */
import { test, expect } from '@playwright/test';
import { writeFileSync, rmSync } from 'node:fs';
import { login, apiLogin, userCredentials, texDoc, PROJECTS_DIR, BASE_URL } from './helpers';

const PROJECT = 'e2e-bobs-paper';

test.afterAll(() => { rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }); });

test('administrator access is an explicit, logged grant; the owner sees it; the Git dialog shows the mirror', async ({ browser, page }) => {
  test.setTimeout(120000);
  // bob creates a project of his own
  const bobCtx = await browser.newContext();
  await apiLogin(bobCtx, userCredentials('bob'));
  await bobCtx.request.delete(BASE_URL + `/api/projects/${PROJECT}`);       // a leftover of an earlier run (its grant and log go with it)
  rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true });
  const created = await bobCtx.request.post(BASE_URL + '/api/projects', { data: { name: PROJECT } });
  expect(created.ok()).toBe(true);
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/main.tex`, texDoc('Bob writes here.'));

  // the administrator: no card for it, an entry under Administration, and the API refuses
  await login(page);
  const docId = encodeURIComponent(`${PROJECT}/main.tex`);
  await expect(page.locator(`[data-admin-project="${PROJECT}"]`)).toBeVisible({ timeout: 15000 });
  await expect(page.locator(`.home-card[data-project="${PROJECT}"]`)).toHaveCount(0);
  expect((await page.request.get(`/api/docs/${docId}/meta`)).status()).toBe(403);

  // open as administrator: confirmed, then the card appears with the admin badge and the API lets the administrator in
  page.once('dialog', d => void d.accept());
  await page.locator(`[data-admin-project="${PROJECT}"] button`).click();
  const card = page.locator(`.home-card[data-project="${PROJECT}"]`);
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator('.badge')).toHaveText('admin');
  expect((await page.request.get(`/api/docs/${docId}/meta`)).ok()).toBe(true);

  // bob sees the grant in his project's activity log
  const bob = await bobCtx.newPage();
  await bob.goto('/');
  await bob.waitForSelector('.menubar', { timeout: 20000 });
  await bob.locator(`[data-share="${PROJECT}"]`).click();
  const activity = bob.locator('[data-share-activity]');
  await expect(activity).toContainText('opened the project as administrator', { timeout: 15000 });
  await expect(activity.locator('.git-token.admin .name')).toHaveText('Admin');
  await bob.keyboard.press('Escape');

  // the Git dialog reports the mirror; "Mirror now" pushes and the state becomes up to date
  await bob.locator(`[data-git="${PROJECT}"]`).click();
  const mirror = bob.locator('[data-git-mirror]');
  await expect(mirror).toContainText('Mirrored to', { timeout: 15000 });
  await mirror.locator('button', { hasText: 'Mirror now' }).click();
  await expect(mirror).toContainText('up to date', { timeout: 30000 });
  await expect(mirror).toContainText('last push just now');
  await bobCtx.close();
});
