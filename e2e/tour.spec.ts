/**
 * The interactive tour (app/Tour.tsx): offered once per browser, opens the user's example document
 * and notices when the user has done what a step asks; every step can be skipped and the tour left;
 * restartable from Help ▸ Take the tour and the start screen.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, collectErrors } from './helpers';

const step = (page: Page, id: string) => page.locator(`.tour[data-tour-step="${id}"] .tour-card`);
const done = (page: Page) => page.locator('.tour[data-tour-done="1"]');
const next = (page: Page) => page.locator('.tour-card button', { hasText: /^Next$/ });

test('offered on the first visit; each step notices what the user did; remembered when finished', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, undefined, { tour: true });
  await expect(step(page, 'intro')).toBeVisible();
  await page.locator('.tour-card button', { hasText: 'Take the tour' }).click();

  // 1. the example document opens; typing completes the step
  await expect(step(page, 'type')).toBeVisible();
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await expect(page.locator('.tour-task')).toContainText('Try it', { timeout: 20000 });
  await expect(done(page)).toHaveCount(0);
  // type in a Standard paragraph (Enter inside a heading would split it into two headings — LyX behaviour —
  // and count as "made a Section" before the next step is even tried)
  await page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Hello from the tour.');
  await expect(done(page)).toHaveCount(1);
  await next(page).click();

  // 2. a new paragraph made a Section
  await expect(step(page, 'layout')).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('A heading');
  await expect(done(page)).toHaveCount(0);
  await page.locator('.toolbar-standard select').selectOption('Section');
  await expect(done(page)).toHaveCount(1);
  await next(page).click();

  // 3. a formula
  await expect(step(page, 'math')).toBeVisible();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+m');
  await page.keyboard.type('\\alpha');
  await expect(done(page)).toHaveCount(1);
  await next(page).click();
  await page.keyboard.press('Escape');

  // 4. autosave confirmed by the server
  await expect(step(page, 'save')).toBeVisible();
  await expect(done(page)).toHaveCount(1, { timeout: 20000 });
  await next(page).click();

  // 5. a comment thread on a selection
  await expect(step(page, 'comment')).toBeVisible();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Control+Alt+c');
  await expect(done(page)).toHaveCount(1);
  await page.keyboard.type('Looks good.');
  await next(page).click();

  // 6. a PDF build (started — that is what the step waits for)
  await expect(step(page, 'pdf')).toBeVisible();
  await expect(page.locator('.sidebar.right')).toBeVisible();
  await page.locator('[data-tb="pdf"]').click();
  await expect(done(page)).toHaveCount(1, { timeout: 20000 });
  await next(page).click();

  // 7. the Versions tab
  await expect(step(page, 'versions')).toBeVisible();
  await page.locator('[data-tab="versions"]').click();
  await expect(done(page)).toHaveCount(1);
  await next(page).click();

  // 8. the sharing dialog (skippable: try "Skip step" first, then come back and do it)
  await expect(step(page, 'share')).toBeVisible();
  await page.locator('.tour-card button', { hasText: 'Skip step' }).click();
  await expect(step(page, 'git')).toBeVisible();
  await page.locator('.tour-card button', { hasText: 'Back' }).click();
  await expect(step(page, 'share')).toBeVisible();
  await page.locator('.filetree [data-share]').first().click();
  await expect(page.locator('.dialog')).toBeVisible();
  await expect(done(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await next(page).click();

  // 9. + 10. informational steps
  await expect(step(page, 'git')).toBeVisible();
  await next(page).click();
  await expect(step(page, 'end')).toBeVisible();
  await page.locator('.tour-card button', { hasText: 'Finish' }).click();
  await expect(page.locator('.tour')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ol.tour'))).toBe('finished');

  // not offered again; restartable from the Help menu; "Not now" is remembered too
  await page.reload();
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await page.waitForTimeout(500);
  await expect(page.locator('.tour')).toHaveCount(0);
  await page.locator('.menubar .menu button', { hasText: 'Help' }).click();
  await page.locator('.menu-item', { hasText: 'Take the tour' }).click();
  await expect(step(page, 'intro')).toBeVisible();
  await page.locator('.tour-card button', { hasText: 'Not now' }).click();
  await expect(page.locator('.tour')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ol.tour'))).toBe('declined');

  expect(errors.filter(e => !/favicon|ERR_INTERNET|net::/.test(e))).toEqual([]);
});

test('the start screen starts the tour directly; ✕ leaves it; the tour is not shown to specs by default', async ({ page }) => {
  await login(page);       // the helper marks the tour as seen
  await page.waitForSelector('.home', { timeout: 20000 });
  await page.waitForTimeout(500);
  await expect(page.locator('.tour')).toHaveCount(0);
  await page.locator('.home-card.example [data-start-tour]').click();
  await expect(step(page, 'type')).toBeVisible();
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await page.locator('.tour-close').click();
  await expect(page.locator('.tour')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ol.tour'))).toBe('left');
});
