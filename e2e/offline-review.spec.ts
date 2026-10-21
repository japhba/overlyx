/**
 * Offline edits that met other edits (server offlinemerge.ts, editor/plugins/mergereview.ts): one
 * editor goes offline and rewrites a word a co-author rewrites meanwhile; on reconnect the live text
 * stays, the offline version lies over it as tracked changes by "<name> (offline)", and a card goes
 * through the place — Keep current / Keep theirs, and Combine when the account has an AI of its own
 * (the codex stub signed in: OVERLYX_E2E_AGENT_STUB=1, the server started with
 * OVERLYX_CODEX_BIN=scripts/codex-stub.mjs). Against the built client served by the server:
 *   OVERLYX_E2E_BASE=http://127.0.0.1:3001 npx playwright test e2e/offline-review.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, shareProject, userCredentials, browserName } from './helpers';

const PROJECT = 'admin/e2e-offline-review';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const BODY = 'The first sentence is here. The second sentence follows it.\n\nAnother paragraph stays.';
const SHOTS = process.env.OVERLYX_E2E_SHOTS;

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => { mkdirSync(DIR, { recursive: true }); });
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const saveState = (page: Page) => page.locator('.statusbar .save-state');
const firstPar = (page: Page) => page.locator('.lyx-editor > .lyx-par').first();
const offlineNoise = /favicon|ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError when attempting|Load failed|WebSocket|can’t establish a connection to the server at ws|connection to ws:\/\/\S+ was interrupted/;

/** the text of the first paragraph's tracked insertions / deletions, without remote cursors */
const changed = (page: Page, kind: 'inserted' | 'deleted') => page.evaluate(kind => Array.from(document.querySelectorAll(`.lyx-editor > .lyx-par:first-child .lyx-change-${kind}`)).map(el => {
  const c = el.cloneNode(true) as HTMLElement;
  c.querySelectorAll('.ProseMirror-yjs-cursor').forEach(x => x.remove());
  return c.textContent;
}).join(''), kind);
/** the first paragraph's text, without remote cursors */
const firstText = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('.lyx-editor > .lyx-par')!.cloneNode(true) as HTMLElement;
  c.querySelectorAll('.ProseMirror-yjs-cursor').forEach(x => x.remove());
  return (c.textContent ?? '').replace(/\s+/g, ' ').trim();
});

/** select `word` in the first paragraph and type `by` over it */
async function retype(page: Page, word: string, by: string) {
  await firstPar(page).click({ position: { x: 4, y: 4 } });
  await page.evaluate(word => {
    const par = document.querySelector('.lyx-editor > .lyx-par')!;
    const walker = document.createTreeWalker(par, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const i = n.data.indexOf(word);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + word.length);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
      return;
    }
    throw new Error('no ' + word);
  }, word);
  await page.keyboard.type(by, { delay: 30 });
}

/** both editors open the document; `page` goes offline, both rewrite "here", `page` comes back */
async function collide(page: Page, page2: Page, file: string) {
  writeFileSync(`${DIR}/${file}`, `\\documentclass{article}\n\\begin{document}\n${BODY}\n\\end{document}\n`);
  for (const p of [page, page2]) {
    await p.goto('/#/' + `${PROJECT}/${file}`);
    await p.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
    await expect(saveState(p)).toHaveText(/All changes saved/, { timeout: 15000 });
  }
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });
  await page.context().setOffline(true);
  await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });
  await retype(page2, 'here', 'there');
  await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });
  await retype(page, 'here', 'everywhere');
  await expect(saveState(page)).toHaveText(/kept on this device/, { timeout: 15000 });
  await page.context().setOffline(false);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 30000 });
}

test('the same word rewritten offline and online: the live text with the offline version as a suggestion, and a card to decide', async ({ page, browser }) => {
  test.skip(browserName(page) === 'webkit', 'Playwright WebKit opens WebSockets while emulated offline (offline.spec)');
  test.setTimeout(150000);
  await shareProject(browser, PROJECT, ['u1']);
  const errors = collectErrors(page);
  await login(page);
  const other = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page2 = await other.newPage();
  const errors2 = collectErrors(page2);
  await login(page2, userCredentials('u1'));
  try {
    await collide(page, page2, 'doc.tex');
    // both editors: the co-author's word, the offline one struck in as a suggestion, and the card
    for (const p of [page, page2]) {
      const card = p.locator('.merge-review');
      await expect(card).toBeVisible({ timeout: 15000 });
      await expect(card).toContainText('changed the same words in one place');
      await expect.poll(() => changed(p, 'deleted')).toBe('there.');
      await expect.poll(() => changed(p, 'inserted')).toBe('everywhere.');
    }
    await expect(page.locator('.merge-review')).toContainText('Your offline edits');
    await expect(page2.locator('.merge-review')).toContainText("Admin's offline edits");
    // no AI of the account's own linked: no Combine
    if (!process.env.OVERLYX_E2E_AGENT_STUB) await expect(page.locator('.merge-review .combine')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/offline-review.png` });
    // the co-author keeps the current text: the suggestion goes, the card too, in both editors
    await page2.locator('.merge-review .keep-current').click();
    for (const p of [page, page2]) {
      await expect(p.locator('.merge-review')).toHaveCount(0, { timeout: 15000 });
      await expect.poll(() => firstText(p)).toBe('The first sentence is there. The second sentence follows it.');
    }
    await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });
    await expect.poll(() => readFileSync(`${DIR}/doc.tex`, 'utf8'), { timeout: 15000 }).toContain('The first sentence is there. The second');
    expect(readFileSync(`${DIR}/doc.tex`, 'utf8')).not.toContain('\\lyxadded');
    expect(errors.filter(e => !offlineNoise.test(e))).toEqual([]);
    expect(errors2.filter(e => !/favicon/.test(e))).toEqual([]);
  } finally { await other.close(); }
});

test('Combine: the account\'s own AI proposes one version, put in on "Use this"', async ({ page, browser }) => {
  test.skip(!process.env.OVERLYX_E2E_AGENT_STUB, 'needs the codex stub (OVERLYX_CODEX_BIN=scripts/codex-stub.mjs)');
  test.skip(browserName(page) === 'webkit', 'Playwright WebKit opens WebSockets while emulated offline (offline.spec)');
  test.setTimeout(150000);
  await login(page);
  // sign the account's codex in (the stub writes its auth.json a moment after the login starts)
  await page.evaluate(async () => { await fetch('/api/agent/login', { method: 'POST' }); });
  await expect.poll(() => page.evaluate(async () => (await (await fetch('/api/ai/linked')).json()).via), { timeout: 15000 }).toBe('ChatGPT');
  const other = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page2 = await other.newPage();
  await login(page2, userCredentials('u1'));
  try {
    await collide(page, page2, 'combine.tex');
    const card = page.locator('.merge-review');
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.locator('.combine').click();
    await expect(card.locator('.merge-review-ai-text')).toContainText('STUBMERGED', { timeout: 30000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/offline-review-combine.png` });
    await card.locator('.use').click();
    await expect(page.locator('.merge-review')).toHaveCount(0, { timeout: 15000 });
    await expect.poll(() => firstText(page)).toContain('STUBMERGED');
    await expect(firstPar(page).locator('.lyx-change')).toHaveCount(0);
  } finally {
    await page.evaluate(async () => { await fetch('/api/agent/logout', { method: 'POST' }); });
    await other.close();
  }
});
