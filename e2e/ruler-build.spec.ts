/**
 * The ruler (text width) and background PDF builds (start, progress, cancel).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { login, openDoc, PROJECTS_DIR, FIXTURES_DIR } from './helpers';

// the whole paper (children, class files, figures): its build takes long enough to be cancelled
const SRC = `${FIXTURES_DIR}/recurrent_feature`;
const DIR = `${PROJECTS_DIR}/e2e-build`;
const DOC = 'e2e-build/main.tex';
test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(`${DIR}/figures`, { recursive: true });
  for (const f of ['main.tex', 'appendix.tex', 'lyxmacros.tex', 'macros.tex', 'preamble.tex', 'latexmkrc', 'bib.bib', 'icml2026.sty', 'icml2026.bst', 'icml.layout', 'fancyhdr.sty', 'algorithm.sty', 'algorithmic.sty']) if (existsSync(`${SRC}/${f}`)) copyFileSync(`${SRC}/${f}`, `${DIR}/${f}`);
  for (const m of readFileSync(`${SRC}/main.tex`, 'utf8').matchAll(/\\includegraphics(?:\[[^\]]*\])?\{figures\/([^}]+)\}/g)) if (existsSync(`${SRC}/figures/${m[1]}`)) copyFileSync(`${SRC}/figures/${m[1]}`, `${DIR}/figures/${m[1]}`);
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

test('the ruler resizes the text column; double-click resets it', async ({ page }) => {
  await login(page);
  await openDoc(page, DOC);
  await page.evaluate(() => localStorage.setItem('ol.textWidth', '720'));
  await expect(page.locator('.ruler .handle.right')).toBeVisible();
  const handle = page.locator('.ruler .handle.right');
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - 60, hb.y + 4, { steps: 6 });
  await expect(page.locator('.ruler .readout')).toContainText('cm');
  await page.mouse.up();
  const w = Number(await page.evaluate(() => localStorage.getItem('ol.textWidth')));
  expect(w).toBeLessThan(720);
  expect(w).toBeGreaterThanOrEqual(400);
  await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('.lyx-editor')!.getBoundingClientRect().width))).toBe(w);
  await page.dblclick('.ruler-band', { position: { x: 120, y: 12 } });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ol.textWidth'))).toBe('720');
  // View ▸ Ruler hides it
  await page.locator('.menubar button', { hasText: 'View' }).click();
  await page.locator('.menu-item, .ctx-item', { hasText: /^Ruler$/ }).first().click();
  await expect(page.locator('.ruler')).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('ol.ruler', '1'));
});

test('PDF builds run in the background and can be cancelled', async ({ page, request }) => {
  await login(page);
  await openDoc(page, DOC);
  await page.locator('.tb-btn[title^="View PDF"]').click();
  await expect(page.locator('.pdf-panel .build-progress')).toBeVisible({ timeout: 15000 });
  // editing keeps working while the build runs
  const par = page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').first();
  await par.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' WHILE-BUILDING');
  await expect(par).toContainText('WHILE-BUILDING');
  await page.locator('.pdf-panel .bar button', { hasText: 'Cancel' }).click();
  await expect(page.locator('.pdf-panel .bar button', { hasText: 'View PDF' })).toBeEnabled({ timeout: 30000 });
  const base = process.env.OVERLYX_E2E_BASE ?? 'http://localhost:5173';
  const st = await (await page.request.get(base + `/api/docs/${encodeURIComponent(DOC)}/build`)).json() as { job: { status: string } | null };
  expect(st.job?.status).toBe('cancelled');
});
