/**
 * Markdown documents (.md) in the document editor (client editor/markdown.ts, core md/): the file
 * renders as structure, markdown's own typing works (`**bold**`, "```" + Enter, `> `), the toolbars
 * offer what markdown can hold and nothing else, and every save writes ordinary markdown — unchanged
 * blocks byte for byte, comment threads as HTML comments.
 */
import { test, expect, type Browser } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, PROJECTS_DIR, collectErrors } from './helpers';

const PROJECT = 'admin/e2e-markdown';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const FILE = `${DIR}/notes.md`;
const TEXT = [
  '# Project notes', '',
  'Some **bold** text, a [link](https://overlyx.app) and $x^2$.', '',
  '* a star bullet', '* another', '',
  '| a | b |', '|---|---|', '| 1 | 2 |', '',
  'Last paragraph.', '',
].join('\n');

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, TEXT);
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function open(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page);
  await page.request.get('/api/projects');
  await page.goto('/#/' + PROJECT + '/notes.md');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length >= 4, null, { timeout: 30000 });
  return { ctx, page, errors };
}

const saved = (page: import('@playwright/test').Page) => expect(page.locator('.statusbar, .status-bar').first()).toContainText(/saved/i, { timeout: 15000 });

test('a markdown file opens in the editor, with markdown toolbars, and markdown typing is saved as markdown', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser);
  const ed = page.locator('.lyx-editor');
  await expect(ed.locator('.lyx-layout-section')).toHaveText('Project notes');
  await expect(ed.locator('.lyx-series-bold')).toHaveText('bold');
  await expect(ed.locator('.lyx-layout-itemize')).toHaveCount(2);
  await expect(ed.locator('table')).toHaveCount(1);
  // markdown's buttons, not LaTeX's
  for (const id of ['bold', 'emph', 'strike', 'code', 'md-h1', 'md-quote', 'md-codeblock', 'md-rule']) await expect(page.locator(`[data-tb="${id}"]`).first()).toBeVisible();
  for (const id of ['noun', 'textcolor', 'label', 'cite', 'marginal', 'float']) await expect(page.locator(`[data-tb="${id}"]`)).toHaveCount(0);
  // the source pane is markdown
  await expect(page.locator('[data-pane-chip="tex"]')).toContainText('Markdown');

  await ed.locator('.lyx-par', { hasText: 'Last paragraph.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed **strong** and `code` here.', { delay: 10 });
  await expect(ed.locator('.lyx-series-bold', { hasText: 'strong' })).toHaveCount(1);
  await expect(ed.locator('.lyx-family-typewriter', { hasText: 'code' })).toHaveCount(1);
  await page.keyboard.press('Enter');
  await page.keyboard.type('```python', { delay: 10 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('print(1)', { delay: 10 });
  await expect(ed.locator('.lyx-inset-listings')).toContainText('print(1)');
  await saved(page);
  await expect.poll(() => readFileSync(FILE, 'utf8'), { timeout: 15000 }).toContain('```python\nprint(1)\n```');
  const text = readFileSync(FILE, 'utf8');
  // what was there is untouched: the star bullets, the table as it was typed
  expect(text.startsWith(TEXT.replace(/\n$/, ''))).toBe(true);
  expect(text).toContain('Typed **strong** and `code` here.');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a comment thread on a markdown document is an HTML comment in the file', async ({ browser }) => {
  const { ctx, page } = await open(browser);
  const ed = page.locator('.lyx-editor');
  await ed.locator('.lyx-par', { hasText: 'Some' }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Alt+c');
  await page.keyboard.type('Needs a citation', { delay: 10 });
  await expect.poll(() => readFileSync(FILE, 'utf8'), { timeout: 20000 }).toMatch(/\$x\^\{?2\}?\$\.<!-- @comment\n {4}Admin \(\d{4}-\d\d-\d\d \d\d:\d\d\):\n {4}Needs a citation\n {4}-->/);
  await ctx.close();
});
