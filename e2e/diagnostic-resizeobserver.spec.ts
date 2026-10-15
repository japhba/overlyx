/**
 * One-off WebKit/Firefox diagnostic. It forwards native ResizeObserver entries/callback timing
 * unchanged, recording only allowlisted target categories and numeric geometry. It is not release
 * coverage and intentionally does not suppress or filter browser errors.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, PROJECTS_DIR, userCredentials } from './helpers';

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const NAME = `ro-native-diagnostic-${RUN}`;
const PROJECT = `luna1/${NAME}`;
const FILE = path.join(PROJECTS_DIR, 'luna1', NAME, 'slides', 'index.html');
const frame = (page: Page) => page.frameLocator('.dl-frame');
const slides = (page: Page) => frame(page).locator('section.slide');
const rail = (page: Page) => page.frameLocator('.dl-railframe').locator('section.slide');

function installNativeObserverDiagnostic(): void {
  const Native = window.ResizeObserver;
  if (!Native || (window as any).__olRoDiagnostic) return;

  type Size = { width: number; height: number };
  type Box = { client: Size; scroll: Size };
  type Entry = { category: string; tag: string; content: Size; before: Size; after: Size };
  type RecordItem = { t: number; kind: 'callback'; observerId: number; entries: Entry[]; rootBefore: Box; rootAfter: Box } |
    { t: number; kind: 'window-error'; category: string };
  const records: RecordItem[] = [];
  let dropped = 0;
  let nextObserverId = 1;
  const LIMIT = 2500;
  const rounded = (n: number) => Math.round(n * 10) / 10;
  const size = (r: DOMRect | { width: number; height: number }): Size => ({ width: rounded(r.width), height: rounded(r.height) });
  const rootBox = (): Box => {
    const root = document.documentElement;
    return { client: { width: root.clientWidth, height: root.clientHeight }, scroll: { width: root.scrollWidth, height: root.scrollHeight } };
  };
  const tag = (el: Element): string => {
    const t = el.localName.toLowerCase();
    return ['html', 'body', 'div', 'section', 'span', 'ol-overlay', 'ol-rail'].includes(t) ? t : 'other';
  };
  const category = (el: Element): string => {
    if (el === document.documentElement) return 'html-root';
    if (el === document.body) return 'body';
    if (el.closest('[data-dl-mathedit], .lm-field')) return 'math-editor';
    if (el.closest('.dl-ctx')) return 'context-toolbar';
    if (el.closest('.dl-toolbar')) return 'deck-toolbar';
    if (el.closest('.dl-canvas')) return 'canvas';
    if (el.closest('.ol-overlay')) return 'editor-overlay';
    if (el.closest('ol-rail')) return 'rail-overlay';
    if (el.closest('.dl-pane, .dl-rail')) return 'app-pane';
    return 'other';
  };
  const save = (r: RecordItem) => { if (records.length < LIMIT) records.push(r); else dropped++; };

  class ObservedResizeObserver extends Native {
    constructor(callback: ResizeObserverCallback) {
      const observerId = nextObserverId++;
      super(function(this: ResizeObserver, entries: ResizeObserverEntry[], observer: ResizeObserver) {
        const t = rounded(performance.now());
        let rootBefore: Box = { client: { width: 0, height: 0 }, scroll: { width: 0, height: 0 } };
        let before: Size[] = [];
        try { rootBefore = rootBox(); before = entries.map(e => size(e.target.getBoundingClientRect())); } catch { /* diagnostics must not alter callback behavior */ }
        try {
          callback.call(this, entries, observer);
        } finally {
          try {
            save({ t, kind: 'callback', observerId, entries: entries.map((e, i) => ({
              category: category(e.target), tag: tag(e.target),
              content: { width: rounded(e.contentRect.width), height: rounded(e.contentRect.height) },
              before: before[i] ?? { width: 0, height: 0 }, after: size(e.target.getBoundingClientRect()),
            })), rootBefore, rootAfter: rootBox() });
          } catch { /* telemetry is best-effort; preserve the native callback result/exception */ }
        }
      });
    }
  }

  (window as any).__olRoDiagnostic = { records, get dropped() { return dropped; } };
  (window as any).ResizeObserver = ObservedResizeObserver;
  window.addEventListener('error', event => {
    const message = (event as ErrorEvent).message;
    const category = message === 'ResizeObserver loop completed with undelivered notifications.' ||
      message === 'ResizeObserver loop limit exceeded' ? 'resize-observer-loop' : 'other-window-error';
    try { save({ t: rounded(performance.now()), kind: 'window-error', category }); } catch { /* no effect on the page */ }
  });
}

async function snapshotDiagnostics(page: Page, testInfo: TestInfo, phase: 'pre-reload' | 'post-reload' | 'failure-final'): Promise<void> {
  const frames = [];
  for (const f of page.frames()) {
    const role = f === page.mainFrame() ? 'app' : await f.frameElement().then(el => el.evaluate(node => {
      if (!(node instanceof HTMLIFrameElement)) return 'other-frame';
      if (node.classList.contains('dl-frame')) return 'canvas-frame';
      if (node.classList.contains('dl-railframe')) return 'thumbnail-frame';
      return 'other-frame';
    })).catch(() => 'other-frame');
    const diagnostic = await f.evaluate(() => {
      const d = (window as any).__olRoDiagnostic as { records: unknown[]; dropped: number } | undefined;
      if (!d) return null;
      return { records: d.records, dropped: d.dropped };
    }).catch(() => null);
    if (diagnostic) frames.push({ role, ...diagnostic });
  }
  const json = JSON.stringify({ diagnosticOnly: true, browser: testInfo.project.name, viewport: { width: 1400, height: 900 }, frames }, null, 2);
  const output = testInfo.outputPath(`resizeobserver-diagnostic-${phase}.json`);
  writeFileSync(output, json);
  await testInfo.attach(`sanitized-resizeobserver-${phase}`, { path: output, contentType: 'application/json' });
  try { await testInfo.attach(`gui-screen-${phase}`, { body: await page.screenshot(), contentType: 'image/png' }); } catch { /* preserve the diagnostic if the page has already closed */ }
}

test('diagnostic only: GUI new deck title/list/math/textbox edits and native resize observer telemetry', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.addInitScript(installNativeObserverDiagnostic);
  let completed = false;
  try {
    await login(page, userCredentials('luna1'), { ui: 'default' });
    await page.locator('[data-new-project]').click();
    await page.locator('[data-new-kind="deck"]').click();
    await page.locator('[data-new-name]').fill(NAME);
    await page.locator('[data-new-create]').click();
    await expect(page).toHaveURL(new RegExp(`#/${PROJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/slides/index\\.html$`));
    await expect(slides(page)).toHaveCount(2);
    await expect(rail(page)).toHaveCount(2);

    // Edit the starter title using the canvas editor.
    const title = slides(page).first().locator('h1');
    await title.dblclick();
    await expect(title).toHaveAttribute('contenteditable', 'true');
    await expect.poll(() => title.evaluate(el => document.activeElement === el)).toBe(true);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Resize Observer Native Diagnostic');
    await page.keyboard.press('Escape');
    await expect(title).toHaveText('Resize Observer Native Diagnostic');

    // Edit a list item, leaving the mixed prose/math starter item intact.
    await rail(page).nth(1).click();
    await expect(slides(page).nth(1)).toBeVisible();
    const list = slides(page).nth(1).locator('ul').first();
    const bullet = slides(page).nth(1).locator('ul > li').first();
    await bullet.dblclick();
    // The runtime retypes the list as one contenteditable UL; the caret remains on this first LI.
    await expect(list).toHaveAttribute('contenteditable', 'true');
    await expect.poll(() => list.evaluate(el => document.activeElement === el)).toBe(true);
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.type('Canvas-edited list item');
    await page.keyboard.press('Escape');
    await expect(bullet).toContainText('Canvas-edited list item');
    await expect(slides(page).nth(1).locator('ul > li').nth(1).locator('mjx-container')).toBeVisible();

    // Reopen and edit the starter inline equation through the visible MathJax glyphs.
    const formula = slides(page).nth(1).locator('ul > li').nth(1).locator('mjx-container').first();
    await expect(formula).toBeVisible();
    await formula.dblclick();
    const mathField = page.locator('[data-dl-mathedit] .lm-field');
    await expect(mathField).toBeVisible();
    await mathField.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('x^2');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('+1');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0);
    await expect(slides(page).nth(1).locator('mjx-container')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(slides(page).nth(1).locator('ul > li').nth(1)).not.toHaveAttribute('contenteditable', 'true');

    // Create a separate editable text box via the toolbar, then edit it in place.
    await rail(page).nth(0).click();
    const slide = slides(page).first();
    const slideBox = await slide.boundingBox();
    if (!slideBox) throw new Error('Canvas title slide did not have a visible box');
    await page.locator('[data-tb="dk-text"]').click();
    const scale = slideBox.width / 1280;
    await page.mouse.click(slideBox.x + 300 * scale, slideBox.y + 570 * scale);
    await page.keyboard.type('New editable canvas textbox');
    await page.keyboard.press('Escape');
    const textBox = slides(page).first().getByText('New editable canvas textbox', { exact: true });
    await expect(textBox).toBeVisible();
    await textBox.dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Edited canvas textbox');
    await page.keyboard.press('Escape');
    await expect(slide).toContainText('Edited canvas textbox');

    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 20_000 });
    const source = () => readFileSync(FILE, 'utf8');
    await expect.poll(source, { timeout: 20_000 }).toContain('Resize Observer Native Diagnostic');
    expect(source()).toContain('Canvas-edited list item');
    expect(source()).toContain('Edited canvas textbox');
    expect(source()).toContain('\\(x^{2}+1\\)');

    // Keep pre-reload frame telemetry: navigation recreates iframe realms and their observers.
    await snapshotDiagnostics(page, testInfo, 'pre-reload');
    await page.reload();
    await expect(slides(page).first().locator('h1')).toHaveText('Resize Observer Native Diagnostic', { timeout: 30_000 });
    await expect(slides(page).first()).toContainText('Edited canvas textbox');
    await rail(page).nth(1).click();
    await expect(slides(page).nth(1).locator('ul > li').first()).toContainText('Canvas-edited list item');
    await expect(slides(page).nth(1).locator('mjx-container')).toBeVisible();
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 20_000 });
    await snapshotDiagnostics(page, testInfo, 'post-reload');
    completed = true;
  } finally {
    if (!completed) await snapshotDiagnostics(page, testInfo, 'failure-final');
  }
});
