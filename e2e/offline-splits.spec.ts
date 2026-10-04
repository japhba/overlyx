/**
 * A paragraph split on both sides while one of them is offline: each presses Enter in the same
 * paragraph (at different places), types into both halves — also behind formulas, in the half the
 * other side moved into a new paragraph — and deletes words there; on reconnect every word is there
 * once, where its author put it, the deleted ones are gone, both splits hold, in both editors and in
 * the saved file (core/moves.ts, server/moves.ts). Runs against the built client served by the server
 * (the service worker keeps the offline page alive):
 *   OVERLYX_E2E_BASE=http://127.0.0.1:3001 npx playwright test e2e/offline-splits.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { login, collectErrors, adminCredentials, PROJECTS_DIR, shareProject, userCredentials, browserName } from './helpers';

const PROJECT = 'admin/e2e-offline-splits';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const FILE = `${DIR}/doc.tex`;
const PARAGRAPH = 'Alpha beta gamma: the encoder $E$ maps keys $k_i$ and values $v_i$ into one space, where every query $q$ meets them before the softmax.';

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, `\\documentclass{article}\n\\begin{document}\n${PARAGRAPH}\n\nClosing paragraph stays.\n\\end{document}\n`);
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const saveState = (page: Page) => page.locator('.statusbar .save-state');
/** the paragraphs' text, formulas as their LaTeX, without remote cursors */
const paragraphs = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('.lyx-editor > .lyx-par')).map(p => {
  const c = p.cloneNode(true) as HTMLElement;
  c.querySelectorAll('.ProseMirror-yjs-cursor').forEach(x => x.remove());
  c.querySelectorAll('.lyx-math-inline').forEach(m => m.replaceWith(` $${m.getAttribute('data-latex') ?? ''}$ `));
  return (c.textContent ?? '').replace(/\s+/g, ' ').trim();
}).filter(Boolean));

/** caret right before `needle` in the paragraph that contains `inPar` */
async function caretBefore(page: Page, inPar: string, needle: string) {
  await page.locator('.lyx-editor .lyx-par', { hasText: inPar }).first().click({ position: { x: 4, y: 4 } });
  await page.evaluate(([inPar, needle]) => {
    const par = Array.from(document.querySelectorAll('.lyx-editor .lyx-par')).find(p => (p.textContent ?? '').includes(inPar!));
    if (!par) throw new Error('no paragraph with ' + inPar);
    const walker = document.createTreeWalker(par, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      if (n.parentElement?.closest('.ProseMirror-yjs-cursor, .lyx-math-inline')) continue;
      const i = n.data.indexOf(needle!);
      if (i >= 0) { document.getSelection()!.collapse(n, i); return; }
    }
    throw new Error(`no "${needle}" in "${par.textContent}"`);
  }, [inPar, needle] as const);
  await page.waitForTimeout(80);
}
/** select `word` (and the space after it) and delete it */
async function deleteWords(page: Page, inPar: string, words: string) {
  await caretBefore(page, inPar, words);
  for (let i = 0; i < words.length; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(80);
}

test('both press Enter in one paragraph, one of them offline, and type in both halves: every word once, both splits hold', async ({ page, context, browser }) => {
  test.skip(browserName(page) === 'webkit', 'Playwright WebKit opens WebSockets while emulated offline (offline.spec)');
  test.setTimeout(180000);
  let otherCreds = adminCredentials();
  try { otherCreds = userCredentials('u1'); await shareProject(browser, PROJECT, ['u1']); } catch { /* single-user seed: a second admin tab */ }
  const errors = collectErrors(page);
  await login(page);
  await page.goto('/#/' + `${PROJECT}/doc.tex`);
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });

  const other = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page2 = await other.newPage();
  const errors2 = collectErrors(page2);
  await login(page2, otherCreds);
  await page2.goto('/#/' + `${PROJECT}/doc.tex`);
  await page2.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });

  await context.setOffline(true);
  await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });

  // online: Enter before "where every" (the shorter second half moves into a new paragraph), then type
  await caretBefore(page2, 'Alpha beta', 'where every');
  await page2.keyboard.press('Enter');
  await page2.keyboard.type('ONLINEONE ', { delay: 30 });
  await caretBefore(page2, 'Alpha beta', 'values');
  await page2.keyboard.type('ONLINETWO ', { delay: 30 });
  await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });

  // offline, not knowing it: type behind the formula q in what moved, delete words there, type in the
  // first half, then press Enter before "values" (the shorter first half moves) and type there
  await caretBefore(page, 'Alpha beta', 'meets them');
  await page.keyboard.type('OFFAAA ', { delay: 30 });
  await deleteWords(page, 'Alpha beta', 'before the ');
  await caretBefore(page, 'Alpha beta', 'into one space');
  await page.keyboard.type('OFFBBB ', { delay: 30 });
  await caretBefore(page, 'Alpha beta', 'values');
  await page.keyboard.press('Enter');
  await page.keyboard.type('OFFCCC ', { delay: 30 });
  await expect(saveState(page)).toHaveText(/kept on this device/, { timeout: 15000 });

  await context.setOffline(false);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 30000 });
  await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 30000 });
  await expect.poll(async () => JSON.stringify(await paragraphs(page)) === JSON.stringify(await paragraphs(page2)), { timeout: 20000 }).toBe(true);

  const pars = await paragraphs(page);
  const all = pars.join(' | ');
  const count = (t: string, s: string) => t.split(s).length - 1;
  for (const s of ['ONLINEONE', 'ONLINETWO', 'OFFAAA', 'OFFBBB', 'OFFCCC', 'Alpha beta gamma', 'encoder', 'maps keys', 'values', 'into one space', 'where every', 'query', 'meets them', 'softmax', 'Closing paragraph']) {
    expect(count(all, s), `"${s}" in ${JSON.stringify(pars)}`).toBe(1);
  }
  expect(all).not.toContain('before the');
  // both splits hold: four paragraphs, in the order of the text
  expect(pars.length, JSON.stringify(pars)).toBe(4);
  const order = ['Alpha beta gamma', 'maps keys', 'values', 'OFFBBB', 'into one space', 'ONLINEONE', 'where every', 'query', 'OFFAAA', 'meets them', 'softmax', 'Closing'];
  for (let i = 1; i < order.length; i++) expect(all.indexOf(order[i - 1]), `${order[i - 1]} before ${order[i]} in ${all}`).toBeLessThan(all.indexOf(order[i]));
  expect(pars[0]).toMatch(/^Alpha beta gamma/);
  expect(pars[1]).toMatch(/values/);
  expect(pars[2]).toMatch(/^ONLINEONE where every/);
  expect(pars[3]).toBe('Closing paragraph stays.');

  // the saved file: the same words once, the deleted ones gone
  await expect.poll(() => { const f = readFileSync(FILE, 'utf8'); return ['ONLINEONE', 'ONLINETWO', 'OFFAAA', 'OFFBBB', 'OFFCCC'].every(s => count(f, s) === 1) && !f.includes('before the'); }, { timeout: 20000 }).toBe(true);
  const file = readFileSync(FILE, 'utf8');
  for (const s of ['Alpha beta gamma', 'into one space', 'where every', 'meets them', 'softmax', 'Closing paragraph']) expect(count(file, s), `"${s}" in the file`).toBe(1);
  expect(errors.filter(e => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError when attempting|Load failed|WebSocket|can’t establish a connection to the server at ws|connection to ws:\/\/\S+ was interrupted/.test(e))).toEqual([]);
  expect(errors2.filter(e => !/favicon/.test(e))).toEqual([]);
  await other.close();
});
