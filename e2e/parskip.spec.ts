/**
 * Paragraph separation "Vertical space": the editor draws such a document's paragraphs flush left
 * with a gap (editor/paragraphsep.ts), an indented document keeps its first-line indents, and
 * Settings ▸ Account ▸ New documents ▸ "No paragraph indentation" makes the documents the account
 * creates start that way (userSettings paragraphSkip, texdoc.ts withDocumentSettings).
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR } from './helpers';

const DIR = `${PROJECTS_DIR}/admin/e2e-parskip`;
const body = 'First paragraph with enough words to make a line of text in the editor.\n\nSecond paragraph, which LaTeX indents unless the document says otherwise.\n\nThird paragraph.\n';

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/indented.tex`, `\\documentclass{article}\n\\begin{document}\n${body}\\end{document}\n`);
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function openDoc(page: Page, file: string) {
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.combined', '0'); });
  await page.goto(`/#/admin/e2e-parskip/${file}`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor > .lyx-par').length >= 3, null, { timeout: 60000 });
}
/** text-indent and margin-top of the second paragraph, in px */
const second = (page: Page) => page.evaluate(() => {
  const p = document.querySelectorAll('.lyx-editor > .lyx-par')[1] as HTMLElement;
  const s = getComputedStyle(p);
  return { indent: parseFloat(s.textIndent), gap: parseFloat(s.marginTop) };
});

test('no paragraph indentation: an account setting for new documents, drawn flush left in the editor', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  // an indented document: first lines indented, no gap
  await openDoc(page, 'indented.tex');
  expect((await second(page)).indent).toBeGreaterThan(5);
  expect((await second(page)).gap).toBe(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-par-sep', /.*/);

  // Settings ▸ Account ▸ New documents
  await page.click('[data-user-menu]');
  await page.click('.menu-item:has-text("Settings")');
  const dlg = page.locator('.dialog');
  await dlg.locator('.settings-nav button', { hasText: 'Account' }).click();
  const skip = dlg.locator('[data-setting="paragraph-skip"]');
  await expect(skip).not.toBeChecked();
  await skip.check();
  await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.paragraphSkip).toBe(true);
  await page.keyboard.press('Escape');

  try {
    // a new document starts with vertical space between paragraphs, in the file and in the editor
    const r = await page.request.post('/api/projects/admin/e2e-parskip/new', { data: { path: 'notes.tex' } });
    expect(r.ok()).toBe(true);
    const created = readFileSync(`${DIR}/notes.tex`, 'utf8');
    expect(created).toContain('\\setlength{\\parskip}{\\medskipamount}\\setlength{\\parindent}{0pt}');
    writeFileSync(`${DIR}/notes.tex`, created.replace('\\begin{document}\n', `\\begin{document}\n${body}`));
    await openDoc(page, 'notes.tex');
    await expect(page.locator('html')).toHaveAttribute('data-par-sep', 'medskip');
    expect((await second(page)).indent).toBe(0);
    expect((await second(page)).gap).toBeGreaterThan(3);
    // back to the indented document: indents again
    await openDoc(page, 'indented.tex');
    await expect(page.locator('html')).not.toHaveAttribute('data-par-sep', /.*/);
    expect((await second(page)).indent).toBeGreaterThan(5);
  } finally {
    await page.request.post('/api/settings', { data: { paragraphSkip: false } });
  }
  expect((await (await page.request.get('/api/settings')).json()).settings.paragraphSkip).toBe(false);
  expect(errors).toEqual([]);
});
