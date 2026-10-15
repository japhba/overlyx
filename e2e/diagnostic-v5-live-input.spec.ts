/** One-lane V5 diagnostic: capture only fictional fixture text and actual editable selection state. */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { apiLogin, login, PROJECTS_DIR, shareProject, userCredentials } from './helpers';
import { starterDeck } from '../packages/core/src/html/deliverable';

const RUN = `v5-input-${Date.now().toString(36)}`;
const made: string[] = [];
const root = path.join(PROJECTS_DIR, 'admin');
const installCapture = (page: Page) => page.addInitScript(() => {
  (window as any).__v5Ops = [];
  addEventListener('message', event => {
    const d = (event as MessageEvent).data;
    if (d?.ol !== 'ops' || !Array.isArray(d.ops)) return;
    const ops = d.ops.filter((op: any) => op?.t === 'inner').map((op: any) => ({
      t: op.t, path: op.path, before: op.before, html: op.html, as: op.as,
    }));
    if (ops.length) (window as any).__v5Ops.push({ version: d.version, ops });
  });
  // Diagnostic-only wrapper: forward the real native call unchanged, retain only command name,
  // boolean result, and selection/element kinds (never arbitrary page text or arguments).
  if (window.parent !== window) {
    (window as any).__v5Exec = [];
    const native = Document.prototype.execCommand;
    const state = () => {
      const s = getSelection(), n = s?.focusNode;
      const el = n?.nodeType === Node.ELEMENT_NODE ? n as Element : n?.parentElement;
      return {
        activeTag: document.activeElement?.localName ?? null,
        editTag: document.activeElement?.closest('[contenteditable="true"]')?.localName ?? null,
        focusNodeKind: n?.nodeType === Node.TEXT_NODE ? '#text' : n?.nodeType === Node.ELEMENT_NODE ? (n as Element).localName : null,
        focusParentTag: el?.localName ?? null,
        anchor: s?.anchorOffset ?? null, focus: s?.focusOffset ?? null,
        collapsed: s?.isCollapsed ?? null,
        selectedLength: s?.toString().length ?? 0,
        selectedNodeTag: s?.anchorNode?.nodeType === Node.ELEMENT_NODE ? (s.anchorNode as Element).localName : s?.anchorNode?.parentElement?.localName ?? null,
      };
    };
    Document.prototype.execCommand = function(command, showUI, value) {
      const before = state();
      const result = native.call(this, command, showUI, value);
      if (command === 'insertUnorderedList' || command === 'insertOrderedList')
        (window as any).__v5Exec.push({ command, returned: result, before, after: state() });
      return result;
    };
  }
});

async function paired(browser: Browser, name: string, html: string): Promise<{ a: Page; b: Page; file: string; close: () => Promise<void> }> {
  const project = `admin/${name}`;
  made.push(project);
  const folder = path.join(PROJECTS_DIR, project, 'talk');
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'index.html');
  writeFileSync(file, html);
  writeFileSync(path.join(folder, 'second.html'), '<html><head><meta name="overlyx" content="deck"></head><body><section class="slide"><p>Other slide</p></section></body></html>');
  await shareProject(browser, project, ['u1']);
  const ca = await browser.newContext({ baseURL: process.env.OVERLYX_E2E_BASE, viewport: { width: 1400, height: 900 } });
  const cb = await browser.newContext({ baseURL: process.env.OVERLYX_E2E_BASE, viewport: { width: 1400, height: 900 } });
  const a = await ca.newPage(), b = await cb.newPage();
  await installCapture(a); await installCapture(b);
  await login(a, undefined, { ui: 'default' });
  await apiLogin(cb, userCredentials('u1'));
  for (const p of [a, b]) {
    await p.goto(`/#/${project}/talk/index.html`);
    await expect(p.frameLocator('.dl-frame').locator('section.slide').first()).toBeVisible({ timeout: 30000 });
  }
  return { a, b, file, close: async () => { await Promise.all([ca.close(), cb.close()]); } };
}

async function editState(page: Page) {
  return page.frameLocator('.dl-frame').locator('body').evaluate(() => {
    const s = getSelection(), node = s?.focusNode;
    const text = node?.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : '';
    return {
      activeTag: document.activeElement?.localName ?? null,
      activeContentEditable: document.activeElement?.getAttribute('contenteditable') ?? null,
      selection: s ? { collapsed: s.isCollapsed, text: s.toString(), anchor: s.anchorOffset, focus: s.focusOffset, nodeText: text } : null,
    };
  });
}
async function ops(page: Page) { return page.evaluate(() => (window as any).__v5Ops ?? []); }
async function snapshot(page: Page) {
  return page.frameLocator('.dl-frame').locator('section.slide .sub').textContent();
}
async function focus(page: Page) { await page.bringToFront(); }

test.afterAll(() => { for (const key of made) rmSync(path.join(PROJECTS_DIR, key), { recursive: true, force: true }); });

test('V5 rapid Unicode: capture actual selection and committed inner ops at round 2', async ({ browser }) => {
  const html = `<!doctype html><html><head><meta name="overlyx" content="deck"><title>Unicode probe</title><style>body{margin:0}.slide{position:relative;width:1280px;height:720px}.sub{position:absolute;left:100px;top:150px;width:1000px;font:32px sans-serif}</style></head><body><section class="slide"><p class="sub">Shared baseline. B0Ω A0😀 B1Ω A1😀</p></section></body></html>`;
  const s = await paired(browser, `${RUN}-unicode`, html);
  try {
    const pre: any = {};
    for (const p of [s.a, s.b]) { await focus(p); await p.frameLocator('.dl-frame').locator('.sub').dblclick(); }
    for (const [label, p] of [['A', s.a], ['B', s.b]] as const) {
      await focus(p); pre[`${label}-doubleclick`] = await editState(p);
      await p.keyboard.press('Control+End'); pre[`${label}-after-control-end`] = await editState(p);
    }
    await focus(s.a); await s.a.keyboard.type(' A2😀', { delay: 20 });
    await focus(s.b); await s.b.keyboard.type(' B2Ω', { delay: 20 });
    const draft = { A: await snapshot(s.a), B: await snapshot(s.b) };
    await Promise.all([s.a.keyboard.press('Escape'), s.b.keyboard.press('Escape')]);
    await expect.poll(() => readFileSync(s.file, 'utf8')).toContain('A2😀');
    const result = {
      phase: 'rapid-unicode', pre,
      localDraftAfterTyping: draft,
      finalText: await snapshot(s.a),
      finalTokens: Object.fromEntries(['B1Ω', 'B1', 'A2😀', 'A2😀Ω', 'B2Ω'].map(t => [t, (readFileSync(s.file, 'utf8').match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length > 0])),
      opsA: await ops(s.a), opsB: await ops(s.b),
    };
    console.log('V5_DIAG', JSON.stringify(result));
  } finally { await s.close(); }
});

test('V5 list conversion: record selection around toolbar command and emitted inner operation', async ({ page }) => {
  const project = `admin/${RUN}-list`;
  made.push(project);
  const folder = path.join(PROJECTS_DIR, project, 'talk'); mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'index.html');
  writeFileSync(file, `<!doctype html><html><head><meta name="overlyx" content="deck"><title>List probe</title><style>body{margin:0}.slide{position:relative;width:1280px;height:720px}.sub{position:absolute;left:100px;top:150px;width:1000px;font:32px sans-serif}</style></head><body><section class="slide"><p class="sub">Shared baseline.</p></section></body></html>`);
  await installCapture(page); await login(page, undefined, { ui: 'default' }); await page.goto(`/#/${project}/talk/index.html`);
  const box = page.frameLocator('.dl-frame').locator('.sub'); await expect(box).toBeVisible({ timeout: 30000 });
  await focus(page); await box.dblclick(); await page.keyboard.press('Control+End');
  const beforeToolbar = await editState(page);
  await page.locator('[data-tb="dk-ul"]').click();
  const afterToolbar = await editState(page);
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('Second paragraph.', { delay: 10 });
  const afterTyping = await editState(page);
  await page.keyboard.press('Escape');
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('Second paragraph.');
  const source = readFileSync(file, 'utf8');
  const result = {
    phase: 'list-conversion', beforeToolbar, afterToolbar, afterTyping,
    structure: Object.fromEntries(['<p', '<div', '<ul', '<ol', '<li'].map(tag => [tag, (source.match(new RegExp(tag, 'g')) ?? []).length])),
    listMarkers: { secondParagraph: source.includes('Second paragraph.'), listContainer: /<(?:ul|ol)\b/.test(source), listItem: /<li\b/.test(source) },
    execCommands: await page.frameLocator('.dl-frame').locator('body').evaluate(() => (window as any).__v5Exec ?? []),
    ops: await ops(page),
  };
  console.log('V5_DIAG', JSON.stringify(result));
});

test('V5 remote caret: use locator targeting and capture actual selection and caret after formula', async ({ browser }) => {
  const project = `admin/${RUN}-carets`; made.push(project);
  const folder = path.join(PROJECTS_DIR, project, 'talk'); mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'index.html');
  writeFileSync(file, starterDeck('Caret probe'));
  writeFileSync(path.join(folder, 'second.html'), '<html><head><meta name="overlyx" content="deck"></head><body><section class="slide"><p>Other slide</p></section></body></html>');
  await shareProject(browser, project, ['u1']);
  const ca = await browser.newContext({ baseURL: process.env.OVERLYX_E2E_BASE, viewport: { width: 1400, height: 900 } });
  const cb = await browser.newContext({ baseURL: process.env.OVERLYX_E2E_BASE, viewport: { width: 1400, height: 900 } });
  const a = await ca.newPage(), b = await cb.newPage(); await installCapture(a); await installCapture(b);
  await login(a, undefined, { ui: 'default' }); await apiLogin(cb, userCredentials('u1'));
  for (const p of [a, b]) { await p.goto(`/#/${project}/talk/index.html`); await expect(p.frameLocator('.dl-frame').locator('section.slide').first()).toBeVisible({ timeout: 30000 }); }
  try {
    await focus(a); await a.frameLocator('.dl-railframe').locator('section.slide').nth(1).click();
    await focus(b); await b.frameLocator('.dl-railframe').locator('section.slide').nth(1).click();
    const listItem = a.frameLocator('.dl-frame').locator('section.slide').nth(1).locator('li').nth(1);
    await expect(listItem.locator('mjx-container')).toBeVisible({ timeout: 15000 });
    // Locator targeting keeps the point in the visible list text without relying on a stale
    // page-coordinate conversion for the transformed iframe.
    await focus(a); await listItem.dblclick({ position: { x: 12, y: 12 } });
    const afterDoubleClick = await editState(a);
    await a.keyboard.press('End'); const afterEnd = await editState(a);
    await a.keyboard.type(' ok', { delay: 20 }); const afterType = await editState(a);
    const getCaret = (p: Page) => p.frameLocator('.dl-frame').locator('body').evaluate(() => (window as any).__ol?.peerCarets?.() ?? []);
    const own = await a.frameLocator('.dl-frame').locator('body').evaluate(() => {
      const s = getSelection()!, r = s.getRangeAt(0).cloneRange(); r.collapse(false);
      const rect = (range: Range) => { const q = range.getBoundingClientRect(); return { x: q.left + scrollX, y: q.top + scrollY, width: q.width, height: q.height, rects: range.getClientRects().length }; };
      const node = s.focusNode, offset = s.focusOffset;
      let previous = null, next = null;
      if (node?.nodeType === Node.TEXT_NODE) {
        const value = node.textContent ?? '';
        if (offset > 0) { const q = document.createRange(); q.setStart(node, offset - 1); q.setEnd(node, offset); previous = rect(q); }
        if (offset < value.length) { const q = document.createRange(); q.setStart(node, offset); q.setEnd(node, offset + 1); next = rect(q); }
      }
      const collapsedRect = rect(r);
      return { activeTag: document.activeElement?.localName ?? null, offset, nodeLength: node?.textContent?.length ?? null,
        nodeKind: node?.nodeType === Node.TEXT_NODE ? '#text' : node?.nodeType === Node.ELEMENT_NODE ? (node as Element).localName : null,
        parentTag: node?.nodeType === Node.ELEMENT_NODE ? (node as Element).localName : node?.parentElement?.localName ?? null,
        selected: s.toString(), collapsed: s.isCollapsed, x: collapsedRect.x, y: collapsedRect.y,
        collapsedRect, previousGlyph: previous, nextGlyph: next };
    });
    const localGeometry = await a.frameLocator('.dl-frame').locator('section.slide').nth(1).locator('li').nth(1).evaluate(li => {
      const describe = (r: Range) => { const q = r.getBoundingClientRect(); return { x: q.left + scrollX, y: q.top + scrollY, width: q.width, height: q.height, rects: r.getClientRects().length }; };
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
      const texts: any[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement?.closest('mjx-container')) continue;
        const value = n.textContent ?? '';
        if (!value.length) continue;
        const first = document.createRange(); first.setStart(n, 0); first.setEnd(n, Math.min(1, value.length));
        const last = document.createRange(); last.setStart(n, Math.max(0, value.length - 1)); last.setEnd(n, value.length);
        texts.push({ label: value.includes('Math is TeX:') ? 'prefix' : value.includes('ok') ? 'typed-suffix' : 'other-text',
          length: value.length, firstGlyph: describe(first), lastGlyph: describe(last) });
      }
      const s = getSelection(), chain: string[] = [];
      for (let e = s?.focusNode?.nodeType === Node.ELEMENT_NODE ? s.focusNode as Element : s?.focusNode?.parentElement; e && e !== li; e = e.parentElement) chain.push(e.localName);
      return { textNodes: texts, focusAncestorsInsideItem: chain };
    });
    const remote = await getCaret(b);
    const result = {
      phase: 'remote-caret', afterDoubleClick, afterEnd, afterType, own,
      remote: remote.map((c: any) => ({ x: c.x, y: c.y, selected: c.selected })),
      deltaX: remote[0] ? Math.abs(remote[0].x - own.x) : null,
      localText: await a.frameLocator('.dl-frame').locator('section.slide').nth(1).locator('li').nth(1).textContent(),
      localGeometry,
      execCommands: await a.frameLocator('.dl-frame').locator('body').evaluate(() => (window as any).__v5Exec ?? []),
      emitted: await ops(a),
    };
    console.log('V5_DIAG', JSON.stringify(result));
  } finally { await Promise.all([ca.close(), cb.close()]); }
});
