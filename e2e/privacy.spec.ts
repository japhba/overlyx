/**
 * The privacy notice (GET /privacy, server privacy.ts) and deleting an account (Settings ▸ Account ▸
 * Delete account, server accounts.ts): the notice is public and linked from the start page; a
 * throwaway account hands one shared project over with the Share dialog's "Make owner…", then
 * deletes itself — the dialog lists what goes, the confirmation needs the user name, the browser
 * ends on the start page signed out, the handed-over project lives on with its new owner.
 */
import { test, expect } from '@playwright/test';
import { login, apiLogin, collectErrors, userCredentials, BASE_URL, dialogLocator } from './helpers';

test('the privacy notice is public and linked from the start page', async ({ page }) => {
  await page.goto('/');
  const link = page.locator('.login .links a', { hasText: 'Privacy' });
  await expect(link).toHaveAttribute('href', '/privacy');
  // /privacy comes from the server (the dev server proxies it too)
  const res = await page.request.get(BASE_URL + '/privacy');
  expect(res.ok()).toBe(true);
  const html = await res.text();
  expect(html).toContain('Privacy notice');
  expect(html).toContain('Delete account');
  expect(html).toContain('days in the trash');
  expect(html).not.toMatch(/<script/i);
});

test('an account hands a project over and deletes itself', async ({ page, browser }) => {
  test.setTimeout(120000);
  const errors = collectErrors(page);
  // a throwaway account, created by the administrator
  const admin = await browser.newContext();
  await apiLogin(admin);
  const username = `leaver${Date.now().toString(36)}`;
  const made = await admin.request.post(BASE_URL + '/api/users', { data: { username, name: 'Lee Leaving' } });
  expect(made.ok()).toBe(true);
  const { password } = await made.json();
  await admin.close();

  // two projects: one shared with bob and handed to him, one shared with bob and left to go
  const lee = await browser.newContext();
  await apiLogin(lee, { username, password });
  for (const name of ['keepme', 'dropme']) {
    expect((await lee.request.post(BASE_URL + '/api/projects', { data: { name } })).ok()).toBe(true);
    expect((await lee.request.post(`${BASE_URL}/api/projects/${encodeURIComponent(`${username}/${name}`)}/share/members`, { data: { who: 'bob', role: 'edit' } })).ok()).toBe(true);
  }
  await lee.close();

  await login(page, { username, password });
  await page.waitForSelector('.home', { timeout: 20000 });
  // Share ▸ Make owner… on keepme
  await page.locator(`[data-share="${username}/keepme"]`).click();
  await expect(page.locator('.share-row[data-member="bob"]')).toBeVisible({ timeout: 15000 });
  await page.locator('.share-row[data-member="bob"] select[data-member-role]').selectOption('owner');
  await expect(dialogLocator(page)).toContainText('Make Bob');
  await dialogLocator(page).locator('button.primary', { hasText: 'Make owner' }).click();
  await expect(page.locator('.share-row')).toHaveCount(0, { timeout: 15000 });

  // the server side of the hand-over: bob owns it, lee edits it
  const bob = await browser.newContext();
  await apiLogin(bob, userCredentials('bob'));
  const bobs = (await (await bob.request.get(BASE_URL + '/api/projects')).json()).projects as { name: string; role: string }[];
  expect(bobs.find(p => p.name === 'bob/keepme')?.role).toBe('owner');

  // Settings ▸ Account ▸ Delete account
  await page.goto('/#/');
  await page.waitForSelector('.home', { timeout: 20000 });
  await page.locator('[data-user-menu]').dispatchEvent('mousedown');
  await page.locator('.menu-item', { hasText: 'Settings…' }).click();
  await page.locator('.settings-nav button', { hasText: 'Account' }).click();
  await page.locator('[data-delete-account]').click();
  const panel = page.locator('[data-delete-panel]');
  await expect(panel.locator('[data-delete-projects]')).toContainText('dropme');
  await expect(panel.locator('[data-delete-projects]')).toContainText('shared with 1 person');
  await expect(panel.locator('[data-delete-projects]')).not.toContainText('keepme');
  await expect(panel).toContainText('You leave 1 project');
  const go = panel.locator('[data-delete-go]');
  await expect(go).toBeDisabled();
  await panel.locator('[data-delete-confirm]').fill('not-my-name');
  await expect(go).toBeDisabled();
  await panel.locator('[data-delete-confirm]').fill(username);
  await go.click();
  await expect(dialogLocator(page)).toContainText('Account deleted', { timeout: 20000 });
  await dialogLocator(page).locator('button.primary').click();
  await page.waitForSelector('.login', { timeout: 20000 });

  // gone: the session, the sign-in, the dropped project; bob keeps keepme and loses dropme
  expect((await (await page.request.get(BASE_URL + '/api/auth/me')).json()).user).toBeNull();
  const again = await browser.newContext();
  expect((await again.request.post(BASE_URL + '/api/auth/login', { data: { username, password } })).ok()).toBe(false);
  await again.close();
  const after = (await (await bob.request.get(BASE_URL + '/api/projects')).json()).projects as { name: string; role: string }[];
  expect(after.find(p => p.name === 'bob/keepme')?.role).toBe('owner');
  expect(after.some(p => p.name === `${username}/dropme`)).toBe(false);
  await bob.close();
  expect(errors.filter(e => !/favicon|net::|status of 401/.test(e))).toEqual([]);
});
