/**
 * Offline mode + autosave indicator. Runs against the *built* client served by the server (the
 * service worker only exists in production builds):
 *   OVERLYX_E2E_BASE=http://127.0.0.1:3001 npx playwright test e2e/offline.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { login, collectErrors, adminCredentials, PROJECTS_DIR, shareProject, userCredentials, browserName, acceptDialog } from './helpers';

const PROJECT = 'admin/e2e-offline';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const DOC = `${PROJECT}/doc.tex`;
const FILE = `${DIR}/doc.tex`;

const LYX = `\\documentclass{article}
\\begin{document}
First paragraph of the offline test.

Second paragraph of the offline test.
\\end{document}
`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, LYX); });
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const saveState = (page: Page) => page.locator('.statusbar .save-state');
/**
 * Playwright's WebKit keeps opening WebSockets while its context is emulated offline (Chromium and
 * Firefox refuse them, as a Safari without a network does): the editor's reconnect attempts every 5 s
 * sync the "offline" edits right away there (scratch/browsers/wsoffline.mts). The tests that keep a
 * page offline for longer than that cannot run in it.
 */
const OFFLINE_WS_LEAKS = 'Playwright WebKit opens WebSockets while emulated offline';
const offlineLeaks = (page: Page) => browserName(page) === 'webkit';

async function openDoc(page: Page) {
  await page.goto('/#/' + DOC);
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
}

/** put the caret at the end of the n-th paragraph and type */
async function typeInParagraph(page: Page, n: number, text: string) {
  const par = page.locator('.lyx-editor > .lyx-par').nth(n);
  await par.click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

test('autosave indicator: Saving… → All changes saved, and the file is written', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  // there is no Save button any more
  await expect(page.locator('.toolbar [title^="Save"]')).toHaveCount(0);
  await typeInParagraph(page, 0, ' ONLINE-MARK');
  await expect(saveState(page)).toHaveText(/Saving/);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  expect(readFileSync(FILE, 'utf8')).toContain('ONLINE-MARK');
  expect(errors).toEqual([]);
});

test('edits made offline are kept locally and saved once the connection is back', async ({ page, context }) => {
  await login(page);
  await openDoc(page);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  // the service worker must be in control before we cut the network (it serves the app shell offline)
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });

  await context.setOffline(true);
  await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });
  await typeInParagraph(page, 1, ' OFFLINE-MARK');
  await expect(saveState(page)).toHaveText(/kept on this device/, { timeout: 5000 });
  expect(readFileSync(FILE, 'utf8')).not.toContain('OFFLINE-MARK');

  // reloading while offline: app shell from the service worker, document from IndexedDB — not in Playwright's
  // WebKit, whose emulated offline network fails every navigation ("WebKit encountered an internal error")
  // before the service worker is asked (Chromium and Firefox reload from it; scratch/browsers/swoffline.mts)
  if (browserName(page) !== 'webkit') {
    await page.evaluate(() => { (window as any).__beforeOfflineReload = true; });
    await page.reload();
    await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
    expect(await page.evaluate(() => (window as any).__beforeOfflineReload)).toBeUndefined();
    await expect(page.locator('.lyx-editor')).toContainText('OFFLINE-MARK');
    await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });
  }
  await typeInParagraph(page, 1, ' OFFLINE-MARK-2');

  await context.setOffline(false);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 20000 });
  const text = readFileSync(FILE, 'utf8');
  expect(text).toContain('OFFLINE-MARK');
  expect(text).toContain('OFFLINE-MARK-2');
});

test('edits of another user made meanwhile merge with the offline edits', async ({ page, context, browser }) => {
  test.skip(offlineLeaks(page), OFFLINE_WS_LEAKS);
  await login(page);
  await openDoc(page);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });
  await context.setOffline(true);
  await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });
  await typeInParagraph(page, 0, ' MINE-WHILE-OFFLINE');

  const other = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page2 = await other.newPage();
  await login(page2);
  await openDoc(page2);
  await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });
  await typeInParagraph(page2, 1, ' THEIRS-MEANWHILE');
  await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });
  expect(readFileSync(FILE, 'utf8')).toContain('THEIRS-MEANWHILE');
  expect(readFileSync(FILE, 'utf8')).not.toContain('MINE-WHILE-OFFLINE');

  await context.setOffline(false);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 20000 });
  await expect(page.locator('.lyx-editor')).toContainText('THEIRS-MEANWHILE');
  await expect(page2.locator('.lyx-editor')).toContainText('MINE-WHILE-OFFLINE', { timeout: 10000 });
  const text = readFileSync(FILE, 'utf8');
  expect(text).toContain('MINE-WHILE-OFFLINE');
  expect(text).toContain('THEIRS-MEANWHILE');
  await other.close();
});

/**
 * Token accounting for a long offline stretch (CHAOS-2): one user offline for a minute, another online,
 * both typing tagged tokens into the SAME paragraph and list item — mostly right in front of the word
 * "queries", where a token's own "q" used to anchor the rest of the token to the existing text, so on
 * reconnect the two users' tokens were spliced into each other mid-token ("Zb Za1q0006Z q0000Z") — while
 * the online user also splits the list item with Enter. Every token must come out whole and exactly
 * once, in both editors and on disk, and the original text must be all there, once.
 */
const MERGE_FILE = `${DIR}/merge.tex`;
const MERGE_BODY = [
  'Shared paragraph: all of the keys $k_i$, values $v_i$ and queries come from the same place, the encoder $E$.',
  '\\begin{itemize}\n\\item keys, values and queries come from the previous decoder layer.\n\\item Second item stays.\n\\end{itemize}',
  'Last paragraph of the merge test.',
];
const TOKEN = /Z[a-z]+\d?q\d{4}Z/g;
/** the visible document text, without the remote-cursor labels */
const docText = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.lyx-editor > .lyx-par')].map(p => {
  const c = p.cloneNode(true) as HTMLElement;
  c.querySelectorAll('.ProseMirror-yjs-cursor').forEach(x => x.remove());
  return c.textContent ?? '';
}).join('\n'));
const withoutTokens = (t: string) => t.replace(TOKEN, ' ').replace(/\s+/g, ' ').trim();

/** caret right before `needle` (null: at the end) in the paragraph that contains `inPar` */
async function caretAt(page: Page, inPar: string, needle: string | null) {
  await page.locator('.lyx-editor .lyx-par', { hasText: inPar }).first().click({ position: { x: 4, y: 4 } });
  await page.evaluate(([inPar, needle]) => {
    const par = [...document.querySelectorAll('.lyx-editor .lyx-par')].find(p => (p.textContent ?? '').includes(inPar!));
    if (!par) throw new Error('no paragraph with ' + inPar);
    const walker = document.createTreeWalker(par, NodeFilter.SHOW_TEXT);
    let target: Text | null = null, offset = 0, last: Text | null = null;
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      if (n.parentElement?.closest('.ProseMirror-yjs-cursor')) continue;
      last = n;
      if (needle && !target && n.data.includes(needle)) { target = n; offset = n.data.indexOf(needle); }
    }
    if (!target) { target = last; offset = last?.data.length ?? 0; }   // no needle, or split off by now: the end
    document.getSelection()!.collapse(target!, offset);
  }, [inPar, needle] as const);
  await page.waitForTimeout(60);
}

test('a minute offline beside another writer in the same paragraph and list: every token once, everywhere', async ({ page, context, browser }) => {
  test.skip(offlineLeaks(page), OFFLINE_WS_LEAKS);
  test.setTimeout(240000);
  writeFileSync(MERGE_FILE, `\\documentclass{article}\n\\begin{document}\n${MERGE_BODY.join('\n\n')}\n\\end{document}\n`);
  let otherCreds = adminCredentials();
  try { otherCreds = userCredentials('u1'); await shareProject(browser, PROJECT, ['u1']); } catch { /* single-user seed: a second admin tab */ }
  const errors = collectErrors(page);
  await login(page);
  await page.goto('/#/' + `${PROJECT}/merge.tex`);
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });
  const original = withoutTokens(await docText(page));

  const other = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page2 = await other.newPage();
  const errors2 = collectErrors(page2);
  await login(page2, otherCreds);
  await page2.goto('/#/' + `${PROJECT}/merge.tex`);
  await page2.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });

  await context.setOffline(true);
  await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });
  const typed: string[] = [];
  const spots: [string, string | null][] = [
    ['Shared paragraph', 'queries'], ['previous decoder layer', 'queries'], ['Shared paragraph', 'queries'],
    ['previous decoder layer', 'queries'], ['Shared paragraph', null], ['previous decoder layer', null], ['Shared paragraph', 'the encoder'],
  ];
  const writer = async (p: Page, tag: string, until: number) => {
    for (let i = 0; Date.now() < until; i++) {
      const [inPar, needle] = spots[i % spots.length];
      await caretAt(p, inPar, needle);
      const token = `Z${tag}q${String(i).padStart(4, '0')}Z`;
      await p.keyboard.type(` ${token} `, { delay: 30 });
      typed.push(token);
      // the online side splits the list item: what the offline side typed into it meanwhile is moved after the
      // copy (the server's repair of paragraph moves, DOCS.md "Back online"; formulas and both sides splitting:
      // offline-splits.spec.ts)
      if (tag === 'zb' && inPar === 'previous decoder layer' && needle) await p.keyboard.press('Enter');
      await p.waitForTimeout(400 + Math.random() * 800);
    }
  };
  const until = Date.now() + 60000;
  await Promise.all([writer(page, 'za', until), writer(page2, 'zb', until)]);
  await expect(saveState(page)).toHaveText(/kept on this device/, { timeout: 15000 });
  await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });

  await context.setOffline(false);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 30000 });
  await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 30000 });
  await expect.poll(async () => (await docText(page)) === (await docText(page2)), { timeout: 20000 }).toBe(true);
  const tokensIn = (t: string) => [...(t.match(TOKEN) ?? [])].sort();
  const inEditor = tokensIn(await docText(page2));
  await expect.poll(() => tokensIn(readFileSync(MERGE_FILE, 'utf8')), { timeout: 20000 }).toEqual(inEditor);

  const expected = [...typed].sort();
  expect(typed.length).toBeGreaterThan(40);
  for (const [where, text] of [['offline editor', await docText(page)], ['online editor', await docText(page2)], ['file', readFileSync(MERGE_FILE, 'utf8')]] as const) {
    expect(tokensIn(text), `tokens in the ${where}`).toEqual(expected);
  }
  const merged = await docText(page);
  expect(withoutTokens(merged)).toBe(original);
  const mergedFile = readFileSync(MERGE_FILE, 'utf8');
  const noItems = (t: string) => withoutTokens(t.replace(/\\item\b/g, ' '));   // a split item is two \items
  for (const line of MERGE_BODY.flatMap(b => b.split('\n'))) expect(noItems(mergedFile), line).toContain(noItems(line));
  // what a browser without a network says: Chromium's, Firefox's and Safari's wording of a failed fetch or WebSocket
  expect(errors.filter(e => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError when attempting|Load failed|WebSocket|can’t establish a connection to the server at ws|connection to ws:\/\/\S+ was interrupted/.test(e))).toEqual([]);
  expect(errors2.filter(e => !/favicon/.test(e))).toEqual([]);
  await other.close();
});

test('an external save from desktop LyX keeps concurrent edits in other paragraphs', async ({ page }) => {
  await login(page);
  await openDoc(page);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  // simulate LyX writing the file: change the second paragraph on disk
  const text = readFileSync(FILE, 'utf8').replace('Second paragraph of the offline test.', 'Second paragraph, rewritten in LyX.');
  writeFileSync(FILE, text);
  await expect(page.locator('.lyx-editor')).toContainText('rewritten in LyX', { timeout: 15000 });
  // the first paragraph (untouched by LyX) is still editable and keeps its identity
  await typeInParagraph(page, 0, ' AFTER-EXTERNAL');
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  const now = readFileSync(FILE, 'utf8');
  expect(now).toContain('AFTER-EXTERNAL');
  expect(now).toContain('rewritten in LyX');
});

test('offline edits that cannot be merged (server history re-created) are kept as a version', async ({ page, context, browser }) => {
  test.skip(offlineLeaks(page), OFFLINE_WS_LEAKS);
  await login(page);
  await openDoc(page);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });
  await context.setOffline(true);
  await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });
  await typeInParagraph(page, 0, ' UNMERGEABLE-EDIT');
  await expect(saveState(page)).toHaveText(/kept on this device/, { timeout: 5000 });

  // meanwhile an admin resets the document's collaboration history on the server
  const admin = await browser.newContext();
  const base = process.env.OVERLYX_E2E_BASE ?? 'http://localhost:5173';
  expect((await admin.request.post(base + '/api/auth/login', { data: adminCredentials() })).ok()).toBe(true);
  expect((await admin.request.post(base + `/api/docs/${encodeURIComponent(DOC)}/reset`)).ok()).toBe(true);

  await context.setOffline(false);
  // the app's own alert dialog (not a native one): "Document Replaced"
  const replacedDlg = page.locator('.dialog-backdrop').last().locator('.dialog', { hasText: 'Document Replaced' });
  await replacedDlg.waitFor({ state: 'visible', timeout: 20000 });
  await expect(replacedDlg).toContainText('kept as the version');
  await acceptDialog(page);
  // the document reloads from the server (without the edit) and the edit is available as a version
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 20000 });
  await expect(page.locator('.lyx-editor')).not.toContainText('UNMERGEABLE-EDIT');
  const versions = await (await admin.request.get(base + `/api/docs/${encodeURIComponent(DOC)}/versions`)).json() as { versions: { name: string; kind: string; id: number }[] };
  const v = versions.versions.find(x => x.kind === 'offline');
  expect(v?.name).toContain('offline changes by');
  const content = await (await admin.request.get(base + `/api/docs/${encodeURIComponent(DOC)}/versions/${v!.id}`)).json() as { lyx: string };
  expect(content.lyx).toContain('UNMERGEABLE-EDIT');
  await admin.close();
});

test('the chosen math font is cached whole, so formulas keep their font offline', async ({ page, context }) => {
  await login(page);
  // Libertinus text with its matching math font (STIX Two), which is not part of the precached shell
  await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('ol.prefs') || '{}'); p.editorFont = 'libertinus'; p.editorMathFont = 'match'; localStorage.setItem('ol.prefs', JSON.stringify(p)); });
  await openDoc(page);
  await page.reload();   // the preferences are read at start
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller && document.documentElement.dataset.mathFont === 'stix2', null, { timeout: 20000 });
  const expected = await page.evaluate(async () => ((await (await fetch('/sw.js')).text()).match(/\/assets\/mathjax\/stix2\/[^"]+/g) ?? []).length);
  expect(expected).toBeGreaterThan(50);
  const cached = () => page.evaluate(async () => {
    let n = 0;
    for (const k of await caches.keys()) if (k.startsWith('overlyx-shell-')) n += (await (await caches.open(k)).keys()).filter(r => new URL(r.url).pathname.startsWith('/assets/mathjax/stix2/')).length;
    return n;
  });
  await expect.poll(cached, { timeout: 30000 }).toBe(expected);
  // the font's files, as the worker lists them (read online: /sw.js itself is not in the worker's cache)
  const fontFiles = await page.evaluate(async () => ((await (await fetch('/sw.js')).text()).match(/\/assets\/mathjax\/stix2\/[^"]+\.woff2/g) ?? []));
  expect(fontFiles.length).toBeGreaterThan(0);
  // offline, a formula in a style no formula had used (bold italic, script) still gets its font
  await context.setOffline(true);
  const failed: string[] = [];
  page.on('requestfailed', r => { if (r.url().includes('/assets/')) failed.push(r.url()); });
  if (browserName(page) !== 'webkit') {   // (Playwright's WebKit cannot navigate offline, see above)
    await page.reload();
    await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  }
  // (Playwright's WebKit fails requests while emulated offline before the service worker is asked — there the
  // cache itself is asked, as the worker would be)
  const ok = browserName(page) === 'webkit'
    ? await page.evaluate(async (files) => (await Promise.all(files.map(f => caches.match(f).then(r => !!r?.ok)))).every(Boolean), fontFiles)
    : await page.evaluate(async (files) => (await Promise.all(files.map(f => fetch(f).then(r => r.ok, () => false)))).every(Boolean), fontFiles);
  expect(ok).toBe(true);
  expect(await page.evaluate(() => document.documentElement.dataset.mathFont)).toBe('stix2');
  expect(failed).toEqual([]);
  await context.setOffline(false);
  await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('ol.prefs') || '{}'); delete p.editorFont; delete p.editorMathFont; localStorage.setItem('ol.prefs', JSON.stringify(p)); });
});
