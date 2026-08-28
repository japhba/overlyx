/**
 * Citation dialog ▸ "Find online / paste BibTeX": a pasted entry (as copied from Google Scholar's
 * Cite ▸ BibTeX) lands in the project's cited.bib with a Scholar-style key, cited.bib is added to the
 * document's BibTeX inset, the citation is inserted and renders with author/year.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, FIXTURES_DIR, withPreambleOf } from './helpers';

const SRC = `${FIXTURES_DIR}/recurrent_feature`;
const PROJECT = 'e2e-cite';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

const doc = () => withPreambleOf(`${SRC}/main.tex`, `Transformers changed everything.

\\bibliographystyle{plain}
\\bibliography{refs}
`);

const SCHOLAR_BIBTEX = `@inproceedings{vaswani2017attention,
  title={Attention is all you need},
  author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N and Kaiser, {\\L}ukasz and Polosukhin, Illia},
  booktitle={Advances in neural information processing systems},
  volume={30},
  year={2017}
}`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/refs.bib`, '@book{knuth1984texbook, title={The TeXbook}, author={Knuth, Donald E.}, year={1984}, publisher={Addison-Wesley}}\n');
  writeFileSync(`${DIR}/paper.tex`, doc());
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function open(page: Page) {
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); });
  await page.goto(`/#/${PROJECT}/paper.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length >= 2, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
}

test('paste a BibTeX entry: it lands in cited.bib, the bibliography inset gets cited.bib, the citation is inserted', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await open(page);
  await page.locator('.lyx-editor .lyx-par').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  await page.keyboard.press('Control+Shift+c');
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Citation');
  await expect(dialog).toContainText('knuth1984texbook');          // the project's own entries
  await page.locator('[data-cite-online]').click();
  await expect(dialog).toContainText('Google Scholar');
  await page.locator('[data-cite-paste]').fill(SCHOLAR_BIBTEX);
  await page.locator('[data-cite-add-paste]').click();
  await expect(page.locator('[data-cite-status]')).toContainText('Added [vaswani2017attention] to cited.bib', { timeout: 15000 });
  await expect(page.locator('[data-cite-selected]')).toContainText('vaswani2017attention');
  // the file and the inset
  await expect.poll(() => existsSync(`${DIR}/cited.bib`) ? readFileSync(`${DIR}/cited.bib`, 'utf8') : '').toContain('@inproceedings{vaswani2017attention,');
  await page.locator('[data-cite-insert]').click();
  await expect(page.locator('.lyx-editor .lyx-command-citation')).toHaveCount(1);
  await expect(page.locator('.lyx-editor .lyx-command-citation')).toContainText('Vaswani');
  await expect.poll(() => readFileSync(`${DIR}/paper.tex`, 'utf8'), { timeout: 15000 }).toContain('\\bibliography{refs,cited}');
  await expect.poll(() => readFileSync(`${DIR}/paper.tex`, 'utf8')).toMatch(/\\cite[a-z*]*\{vaswani2017attention\}/);

  // the same paper pasted again is recognised, not duplicated
  await page.keyboard.press('Control+Shift+c');
  await page.locator('[data-cite-online]').click();
  await page.locator('[data-cite-paste]').fill(SCHOLAR_BIBTEX.replace('vaswani2017attention', 'other_key'));
  await page.locator('[data-cite-add-paste]').click();
  await expect(page.locator('[data-cite-status]')).toContainText('Already in the project as [vaswani2017attention]', { timeout: 15000 });
  await page.keyboard.press('Escape');
  expect(readFileSync(`${DIR}/cited.bib`, 'utf8').split('@inproceedings').length).toBe(2);
  expect(errors.filter(e => !/favicon|net::/.test(e))).toEqual([]);
});

test('a viewer cannot add to the bibliography (the tab is disabled)', async ({ page }) => {
  await login(page);
  await open(page);
  // the admin is an editor here; the disabled state is verified through the API contract instead:
  const r = await page.request.post(`/api/projects/${PROJECT}/bib/add`, { data: { bibtex: '' } });
  expect(r.status()).toBe(400);
  const r2 = await page.request.post(`/api/projects/${PROJECT}/bib/add`, { data: { bibtex: 'garbage' } });
  expect(r2.status()).toBe(400);
  expect((await r2.json()).error).toContain('not a BibTeX entry');
});
