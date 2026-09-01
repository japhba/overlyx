/**
 * The centralized Settings panel: opened from the avatar menu (works on the start screen, which
 * has no Tools menu), sections switch, the theme choice applies immediately, and the Account
 * section shows the signed-in user, the token re-copy state, and — for administrators — the
 * per-account switches (flipping one's own is reflected in the state line).
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
  const own = dlg.locator('.settings-users label', { hasText: '(admin' });
  await own.locator('input').check();
  await expect(dlg.locator('[data-setting="recopy"]')).toContainText('Enabled');
  await own.locator('input').uncheck();
  await expect(dlg.locator('[data-setting="recopy"]')).toContainText('Disabled');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});
