/**
 * The centralized Settings panel: opened from the avatar menu (on the start screen too), sections
 * switch, the theme choice applies immediately, the Account section shows the signed-in user, the
 * fine-grained access switch for new sign-ins and the token re-copy state, and — for administrators —
 * Administration has the per-account switches (flipping one's own is reflected in the state line).
 */
import { test, expect } from '@playwright/test';
import { login } from './helpers';

test('avatar menu ▸ Settings: sections, theme, account (admin switches token re-copy)', async ({ page }) => {
  await login(page);
  await page.click('[data-user-menu]');
  await page.click('.menu-item:has-text("Settings")');
  const dlg = page.locator('.dialog');
  await expect(dlg.locator('[data-pref="spellcheck"]')).toBeVisible();     // the Editor section comes first
  await dlg.locator('.settings-nav button', { hasText: 'AI assistance' }).click();
  await expect(dlg.locator('[data-pref="aiRewrite"]')).toBeVisible();
  await dlg.locator('.settings-nav button', { hasText: 'Appearance' }).click();
  await dlg.locator('[data-theme-pref="dark"]').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await dlg.locator('[data-theme-pref="light"]').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await dlg.locator('[data-theme-pref="system"]').check();
  await dlg.locator('.settings-nav button', { hasText: 'Account' }).click();
  await expect(dlg.locator('[data-setting="whoami"]')).toContainText('admin');
  await expect(dlg.locator('[data-setting="recopy"]')).toContainText('Disabled');   // the test instance has no owner e-mail
  // an administrator switches it per account in Administration
  const own = dlg.locator('.settings-users label', { hasText: '(admin' });
  await dlg.locator('.settings-nav button', { hasText: 'Administration' }).click();
  await own.locator('input').check();
  await dlg.locator('.settings-nav button', { hasText: 'Account' }).click();
  await expect(dlg.locator('[data-setting="recopy"]')).toContainText('Enabled');
  await dlg.locator('.settings-nav button', { hasText: 'Administration' }).click();
  await own.locator('input').uncheck();
  await dlg.locator('.settings-nav button', { hasText: 'Account' }).click();
  await expect(dlg.locator('[data-setting="recopy"]')).toContainText('Disabled');
  // fine-grained access for new sign-ins: the user's own switch, off by default, kept on the server
  const fine = dlg.locator('[data-setting="fine-grained"]');
  await expect(fine).not.toBeChecked();
  await fine.check();
  await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.fineGrainedAccess).toBe(true);
  await fine.uncheck();
  await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.fineGrainedAccess).toBe(false);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});
