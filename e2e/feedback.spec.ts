/**
 * Help ▸ Report a problem (app/Feedback.tsx): the report is kept on the server (feedback.ts) — the
 * dialog says it is not published, sends nothing to GitHub and confirms with the report's number.
 */
import { test, expect } from '@playwright/test';
import { login, collectErrors } from './helpers';

test('the feedback dialog keeps a report on the server and says it is not published', async ({ page }) => {
  const errors = collectErrors(page);
  const github: string[] = [];
  page.on('request', r => { if (/github\.com/.test(r.url())) github.push(r.url()); });
  page.on('popup', p => github.push('popup ' + p.url()));
  await login(page);
  await page.waitForSelector('.home', { timeout: 20000 });
  await page.locator('.menubar .menu button', { hasText: 'Help' }).click();
  await page.locator('.menu-item', { hasText: 'Report a problem' }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('not published');
  await expect(dialog).toContainText('never the content of your documents');
  await expect(dialog.locator('a[href="/privacy"]')).toBeVisible();
  // nothing written → refused in the dialog
  await page.locator('[data-feedback-send]').click();
  await expect(dialog).toContainText('Please write something first.');
  await page.locator('[data-feedback-kind]').selectOption('idea');
  await page.locator('[data-feedback-title]').fill('Dark mode');
  await page.locator('[data-feedback-body]').fill('It is late and the page is very white.');
  const [res] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/feedback')), page.locator('[data-feedback-send]').click()]);
  expect(res.status()).toBe(200);
  const { id } = await res.json();
  await expect(page.locator('[data-feedback-done]')).toContainText(`#${id}`);
  await expect(page.locator('[data-feedback-done]')).toContainText('reached the people who run OverLyX');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog')).toHaveCount(0);
  expect(github).toEqual([]);
  expect(errors.filter(e => !/favicon|net::/.test(e))).toEqual([]);
});
