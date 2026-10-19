/**
 * A paragraph split on both sides while one of them is offline: each presses Enter in the same
 * paragraph (at different places), types into both halves — also behind formulas, in the half the
 * other side moved into a new paragraph — and deletes words there; on reconnect every word is there
 * once, where its author put it, the deleted ones are gone, both splits hold, in both editors and in
 * the saved file (the CRDT's model 2, core collab/model.ts: a split moves no text). Runs against the built client served by the server
 * (the service worker keeps the offline page alive):
 *   OVERLYX_E2E_BASE=http://127.0.0.1:3001 npx playwright test e2e/offline-splits.spec.ts
 */
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { login, collectErrors, adminCredentials, PROJECTS_DIR, shareProject, userCredentials, browserName } from './helpers';
import * as decoding from 'lib0/decoding';
import { expectedOfflineAuthConsole, expectedOfflineAuthRequest, expectedOfflineTexConsole, expectedOfflineTexRequest, pairedOfflineTexConsoleCount } from './offline-auth-errors';

const PROJECT = 'admin/e2e-offline-splits';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const FILE = `${DIR}/doc.tex`;
const UNDO_FILE = `${DIR}/delete-undo.tex`;
const PENDING_FILE = `${DIR}/pending-move.tex`;
const numbered = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const UNDO_PARAGRAPH = 'ORIONA ORIONB ORIONC ORIOND ORIONE $u^2$ ORIONF ORIONG ORIONH ORIONI ORIONJ ORIONK ORIONL.';
const PARAGRAPH = 'Alpha beta gamma: the encoder $E$ maps keys $k_i$ and values $v_i$ into one space, where every query $q$ meets them before the softmax.';

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, `\\documentclass{article}\n\\begin{document}\n${PARAGRAPH}\n\nClosing paragraph stays.\n\\end{document}\n`);
  writeFileSync(UNDO_FILE, `\\documentclass{article}\n\\begin{document}\n${UNDO_PARAGRAPH}\n\nClosing paragraph stays.\n\\end{document}\n`);
  writeFileSync(PENDING_FILE, `\\documentclass{article}\n\\begin{document}\n${numbered(1, 6)} $a+b$ ${numbered(7, 14)} $c$ ${numbered(15, 19)} \n\n${numbered(20, 29)} \n\n${numbered(30, 33)} $x^2$ ${numbered(34, 37)} \n\\end{document}\n`);
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const saveState = (page: Page) => page.locator('.statusbar .save-state');
/** the paragraphs' text, formulas as their LaTeX, without remote cursors */
const paragraphs = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('.lyx-editor > .lyx-par')).map(p => {
  // Node views render the formula without the static serializer's data-latex
  // attribute. Read its canonical node value before cloning the paragraph.
  const formulas = Array.from(p.querySelectorAll('.lyx-math-inline')).map(node => {
    const latex = (node as HTMLElement & { pmViewDesc?: { node?: { attrs: { latex?: unknown } } } }).pmViewDesc?.node?.attrs.latex;
    if (typeof latex !== 'string') throw new Error('Inline formula has no canonical LaTeX value');
    return latex;
  });
  const c = p.cloneNode(true) as HTMLElement;
  c.querySelectorAll('.ProseMirror-yjs-cursor').forEach(x => x.remove());
  c.querySelectorAll('.lyx-math-inline').forEach((m, i) => m.replaceWith(` $${formulas[i]}$ `));
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

test('an in-flight join keeps its visible word order when a coauthor splits its prefix, including typing and reload', async ({ page, context, browser }) => {
  test.setTimeout(120000);
  await shareProject(browser, PROJECT, ['u1']);
  let holdUpdates = false, remoteUpdates = 0;
  const held: { server: WebSocketRoute; bytes: string | Buffer }[] = [];
  const isUpdate = (bytes: string | Buffer) => {
    if (typeof bytes === 'string') return false;
    const decoder = decoding.createDecoder(bytes);
    return decoding.readVarUint(decoder) === 0 && decoding.readVarUint(decoder) === 2;
  };
  await context.routeWebSocket(url => url.pathname.startsWith('/ws'), client => {
    const server = client.connectToServer();
    client.onMessage(bytes => {
      if (holdUpdates && isUpdate(bytes)) held.push({ server, bytes });
      else server.send(bytes);
    });
    server.onMessage(bytes => {
      if (holdUpdates && isUpdate(bytes)) remoteUpdates++;
      client.send(bytes);
    });
  });
  const errors = collectErrors(page);
  const other = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    await login(page);
    await page.goto('/#/' + `${PROJECT}/pending-move.tex`);
    await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 30000 });
    const page2 = await other.newPage(), errors2 = collectErrors(page2);
    await login(page2, userCredentials('u1'));
    await page2.goto('/#/' + `${PROJECT}/pending-move.tex`);
    await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 30000 });
    holdUpdates = true;
    await caretBefore(page, 'w020', 'w020');
    await page.keyboard.press('Backspace');
    // TeX discards paragraph-end blanks; type the word separator at the join.
    await page.keyboard.press('Space');
    await expect.poll(async () => (await paragraphs(page)).length).toBe(2);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    const local = await paragraphs(page);
    await caretBefore(page2, 'w001', 'w013');
    await page2.keyboard.press('Enter');
    await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });
    await expect.poll(() => remoteUpdates).toBeGreaterThan(0);
    // the coauthor's Enter shows at once, merged with the join that is still on its way (nothing is
    // held back: a split moves no text, so there is no intermediate state to hide)
    const cut = local[0].indexOf('w013');
    await expect.poll(async () => JSON.stringify(await paragraphs(page))).toBe(JSON.stringify([local[0].slice(0, cut).trimEnd(), local[0].slice(cut), ...local.slice(1)]));
    await caretBefore(page, 'w013', 'w018');
    await page.keyboard.type('PENDING ');
    const pending = (await paragraphs(page)).join(' ');
    expect(pending).toContain('w017 PENDING w018');
    expect(pending.indexOf('w013')).toBeLessThan(pending.indexOf('w029'));
    holdUpdates = false;
    for (const packet of held.splice(0)) packet.server.send(packet.bytes);
    await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 30000 });
    await expect.poll(async () => JSON.stringify(await paragraphs(page2))).toBe(JSON.stringify(await paragraphs(page)));
    const final = await paragraphs(page), text = final.join(' ');
    expect(final).toHaveLength(3);
    expect(final[0]).toMatch(/^w001.*w012$/);
    expect(final[1]).toMatch(/^w013.*w029$/);
    expect(final[2]).toMatch(/^w030.*w037$/);
    const tokens = text.split(/[\s$]+/);
    let previous = -1;
    for (let i = 1; i <= 37; i++) {
      const word = `w${String(i).padStart(3, '0')}`;
      expect(tokens.filter(token => token === word), word).toHaveLength(1);
      expect(tokens.indexOf(word), word).toBeGreaterThan(previous);
      previous = tokens.indexOf(word);
    }
    expect(tokens.filter(token => token === 'PENDING')).toHaveLength(1);
    expect(text.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
    await expect.poll(() => readFileSync(PENDING_FILE, 'utf8')).toContain('w017 PENDING w018');
    await page.reload(); await page2.reload();
    await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 30000 });
    await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 30000 });
    expect(await paragraphs(page)).toEqual(final);
    expect(await paragraphs(page2)).toEqual(final);
    expect(errors.filter(error => !/favicon/.test(error))).toEqual([]);
    expect(errors2.filter(error => !/favicon/.test(error))).toEqual([]);
  } finally { await other.close(); }
});

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
  await expect.poll(() => { const f = readFileSync(FILE, 'utf8'); return ['ONLINEONE', 'ONLINETWO', 'OFFAAA', 'OFFBBB', 'OFFCCC'].every(s => count(f, s) === 1) && !f.includes('before the') ? 'saved' : f; }, { timeout: 20000 }).toBe('saved');
  const file = readFileSync(FILE, 'utf8');
  for (const s of ['Alpha beta gamma', 'into one space', 'where every', 'meets them', 'softmax', 'Closing paragraph']) expect(count(file, s), `"${s}" in the file`).toBe(1);
  expect(errors.filter(e => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError when attempting|Load failed|WebSocket|can’t establish a connection to the server at ws|connection to ws:\/\/\S+ was interrupted/.test(e))).toEqual([]);
  expect(errors2.filter(e => !/favicon/.test(e))).toEqual([]);
  await other.close();
});

test('offline deletion follows a coauthor split and remains undoable and redoable at the moved position', async ({ page, context, browser }, info) => {
  test.setTimeout(120000);
  const coauthor = userCredentials('u1');
  await shareProject(browser, PROJECT, ['u1']);
  let intentionallyOffline = false, offlineAuthConsoleErrors = 0, offlineAuthRequests = 0, offlineTexConsoleErrors = 0;
  const offlineTexConsoleUrls: string[] = [], offlineTexFailedGetUrls: string[] = [];
  const origin = () => new URL(page.url()).origin;
  page.on('requestfailed', request => {
    if (expectedOfflineAuthRequest(request, origin(), intentionallyOffline)) offlineAuthRequests++;
    else if (expectedOfflineTexRequest(request, origin(), intentionallyOffline)) offlineTexFailedGetUrls.push(request.url());
  });
  // Closing and rejecting the document socket makes the offline boundary
  // deterministic even in engines that keep WebSockets alive in offline mode.
  let blockSocket = false;
  const channels = new Set<{ client: WebSocketRoute; server: WebSocketRoute }>();
  await context.routeWebSocket(url => url.pathname.startsWith('/ws'), async client => {
    if (blockSocket) { await client.close(); return; }
    const server = client.connectToServer();
    const channel = { client, server }; channels.add(channel);
    client.onClose(async () => { channels.delete(channel); await server.close(); });
  });
  const errors = collectErrors(page, { allowConsole: message => {
    if (expectedOfflineAuthConsole(message, origin(), intentionallyOffline)) { offlineAuthConsoleErrors++; return true; }
    if (!expectedOfflineTexConsole(message, origin(), intentionallyOffline)) return false;
    offlineTexConsoleErrors++;
    offlineTexConsoleUrls.push(message.location().url);
    return true;
  } });
  await login(page);
  await page.goto('/#/' + `${PROJECT}/delete-undo.tex`);
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });

  const other = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const page2 = await other.newPage();
    const errors2 = collectErrors(page2);
    await login(page2, coauthor);
    await page2.goto('/#/' + `${PROJECT}/delete-undo.tex`);
    await page2.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
    await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });

    blockSocket = true;
    await Promise.all([...channels].map(async ({ client, server }) => { await client.close(); await server.close(); }));
    intentionallyOffline = true;
    await context.setOffline(true);
    await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });
    await deleteWords(page, 'ORIONA', 'ORIONC ');
    await expect(saveState(page)).toHaveText(/kept on this device/, { timeout: 15000 });
    // The shorter prefix, including the deleted word, moves to a new copy.
    await caretBefore(page2, 'ORIONA', 'ORIONE');
    await page2.keyboard.press('Enter');
    await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });
    await expect.poll(() => paragraphs(page2)).toEqual([
      'ORIONA ORIONB ORIONC ORIOND',
      'ORIONE $u^2$ ORIONF ORIONG ORIONH ORIONI ORIONJ ORIONK ORIONL.',
      'Closing paragraph stays.',
    ]);
    expect(readFileSync(UNDO_FILE, 'utf8')).toContain('ORIONC');

    blockSocket = false;
    intentionallyOffline = false;
    await context.setOffline(false);
    const verify = async (restored: boolean) => {
      const expected = [
        restored ? 'ORIONA ORIONB ORIONC ORIOND' : 'ORIONA ORIONB ORIOND',
        'ORIONE $u^2$ ORIONF ORIONG ORIONH ORIONI ORIONJ ORIONK ORIONL.',
        'Closing paragraph stays.',
      ];
      for (const editor of [page, page2]) {
        await expect(saveState(editor)).toHaveText(/All changes saved/, { timeout: 30000 });
        await expect.poll(() => paragraphs(editor), { timeout: 20000 }).toEqual(expected);
        expect(await editor.locator('.lyx-editor .lyx-math-inline').evaluateAll(nodes => nodes.map(node => {
          const latex = (node as HTMLElement & { pmViewDesc?: { node?: { attrs: { latex?: unknown } } } }).pmViewDesc?.node?.attrs.latex;
          if (typeof latex !== 'string') throw new Error('Inline formula has no canonical LaTeX value');
          return latex;
        }))).toEqual(['u^2']);
      }
      const tokens = Array.from({ length: 12 }, (_, i) => `ORION${String.fromCharCode(65 + i)}`).filter(token => restored || token !== 'ORIONC');
      await expect.poll(() => readFileSync(UNDO_FILE, 'utf8').match(/\bORION[A-L]\b/g) ?? [], { timeout: 20000 }).toEqual(tokens);
      const saved = readFileSync(UNDO_FILE, 'utf8');
      expect(saved.match(/\$u\^2\$/g)).toEqual(['$u^2$']);
      expect(saved.indexOf('ORIONE')).toBeLessThan(saved.indexOf('$u^2$'));
      expect(saved.indexOf('$u^2$')).toBeLessThan(saved.indexOf('ORIONF'));
      expect(saved).toContain('Closing paragraph stays.');
    };
    await verify(false);
    // Keep this page open: its own UndoManager must follow the remote split.
    await caretBefore(page, 'ORIONA', 'ORIOND');
    await page.keyboard.press('Control+z');
    await verify(true);
    await info.attach('deletion-restored-after-remote-split', { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Control+y');
    await verify(false);
    await page.reload();
    await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
    await verify(false);
    const pairedTexConsoleErrors = pairedOfflineTexConsoleCount(offlineTexConsoleUrls, offlineTexFailedGetUrls);
    expect(pairedTexConsoleErrors, 'each allowed offline TeX console error has its same-URL failed GET').toBe(offlineTexConsoleErrors);
    await info.attach('expected-offline-tex-source-errors', { body: JSON.stringify({ consoleErrors: offlineTexConsoleErrors, failedGets: offlineTexFailedGetUrls.length, paired: pairedTexConsoleErrors }), contentType: 'application/json' });
    expect(offlineAuthConsoleErrors, 'allowed offline auth console errors have matching GET requestfailed events').toBeLessThanOrEqual(offlineAuthRequests);
    await info.attach('expected-offline-auth-errors', { body: JSON.stringify({ consoleErrors: offlineAuthConsoleErrors, failedGetRequests: offlineAuthRequests }), contentType: 'application/json' });
    expect(errors.filter(error => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError when attempting|Load failed|WebSocket|can’t establish a connection to the server at ws|connection to ws:\/\/\S+ was interrupted/.test(error))).toEqual([]);
    expect(errors2.filter(error => !/favicon/.test(error))).toEqual([]);
  } finally {
    blockSocket = false;
    intentionallyOffline = false;
    await context.setOffline(false);
    await other.close();
  }
});
