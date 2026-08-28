/**
 * Help ▸ Report a problem (app/Feedback.tsx). The test server has no GitHub token, so the dialog
 * falls back to opening GitHub's pre-filled "new issue" form in a new tab and says so.
 */
import { test, expect } from '@playwright/test';
import { login, collectErrors } from './helpers';

test('the feedback dialog sends a report; without a GitHub token it opens the pre-filled issue form', async ({ page }) => {
  const errors = collectErrors(page);
  // the popup must keep the URL the app asked for (github.com would redirect an anonymous visitor to its login page)
  await page.context().route('https://github.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }));
  await login(page);
  await page.waitForSelector('.home', { timeout: 20000 });
  await page.locator('.menubar .menu button', { hasText: 'Help' }).click();
  await page.locator('.menu-item', { hasText: 'Report a problem' }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('public');
  await expect(dialog).toContainText('never the content of your documents');
  // nothing written → refused in the dialog
  await page.locator('[data-feedback-send]').click();
  await expect(dialog).toContainText('Please write something first.');
  await page.locator('[data-feedback-kind]').selectOption('idea');
  await page.locator('[data-feedback-title]').fill('Dark mode');
  await page.locator('[data-feedback-body]').fill('It is late and the page is very white.');
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('[data-feedback-send]').click()]);
  expect(popup.url()).toContain('github.com/');
  expect(popup.url()).toContain('/issues/new?title=Dark+mode&body=');
  const body = new URL(popup.url()).searchParams.get('body') ?? '';
  expect(body).toContain('It is late and the page is very white.');
  expect(body).toContain('**Idea** reported by Admin (`admin`)');
  await popup.close();
  await expect(page.locator('[data-feedback-done]')).toContainText('not connected to GitHub');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog')).toHaveCount(0);
  expect(errors.filter(e => !/favicon|net::|github|status of 503/.test(e))).toEqual([]);   // 503 = the expected "no token" answer
});
