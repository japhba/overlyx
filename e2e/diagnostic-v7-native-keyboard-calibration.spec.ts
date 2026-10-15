/** Native Firefox contenteditable calibration; no OverLyX source, auth, or app pages. */
import { test, expect, type Page, type Locator, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RUN = `v7-native-keyboard-${Date.now().toString(36)}`;
const FIXTURE = 'Shared baseline. A0😀 B0Ω A1😀 B1Ω';

type EditTarget = Locator;
const installCapture = (edit: EditTarget) => edit.evaluate(node => {
  const p = node as HTMLElement;
  const w = p.ownerDocument.defaultView!;
  const win = w as Window & { __nativeCalibration?: unknown[] };
  win.__nativeCalibration ??= [];
  const state = () => {
    const selection = p.ownerDocument.getSelection();
    const n = selection?.focusNode ?? null;
    const value = n?.nodeType === Node.TEXT_NODE ? n.textContent ?? '' : null;
    const offset = selection?.focusOffset ?? null;
    return {
      hasFocus: p.ownerDocument.hasFocus(),
      activeTag: p.ownerDocument.activeElement?.localName ?? null,
      activeId: (p.ownerDocument.activeElement as HTMLElement | null)?.id ?? null,
      editable: p.getAttribute('contenteditable'),
      text: p.textContent ?? '',
      focusNodeKind: n?.nodeType === Node.TEXT_NODE ? '#text' : n?.nodeType === Node.ELEMENT_NODE ? (n as Element).localName : null,
      focusNodeLengthUtf16: value?.length ?? null,
      focusOffsetUtf16: offset,
      focusAround: value !== null && offset !== null ? value.slice(Math.max(0, offset - 6), Math.min(value.length, offset + 6)) : null,
      selected: selection?.toString() ?? '',
      collapsed: selection?.isCollapsed ?? null,
    };
  };
  const add = (type: string, phase: 'capture' | 'bubble') => (event: Event) => {
    const target = event.target;
    if (target !== p && !(target instanceof Node && p.contains(target))) return;
    if (type === 'keydown' || type === 'keyup') {
      const key = (event as KeyboardEvent).key;
      if (!['Control', 'End', ' '].includes(key)) return;
    }
    const k = event as KeyboardEvent;
    const i = event as InputEvent;
    win.__nativeCalibration!.push({
      type, phase, time: Number(w.performance.now().toFixed(2)),
      trusted: event.isTrusted, defaultPrevented: event.defaultPrevented,
      key: type === 'keydown' || type === 'keyup' ? k.key : undefined,
      code: type === 'keydown' || type === 'keyup' ? k.code : undefined,
      ctrl: type === 'keydown' || type === 'keyup' ? k.ctrlKey : undefined,
      inputType: type === 'beforeinput' || type === 'input' ? i.inputType : undefined,
      data: type === 'beforeinput' || type === 'input' ? i.data : undefined,
      ...state(),
    });
  };
  for (const type of ['keydown', 'keyup', 'beforeinput', 'input']) {
    p.ownerDocument.addEventListener(type, add(type, 'capture'), true);
    p.ownerDocument.addEventListener(type, add(type, 'bubble'), false);
  }
});

async function state(edit: EditTarget) {
  return edit.evaluate(node => {
    const p = node as HTMLElement;
    const selection = p.ownerDocument.getSelection();
    const n = selection?.focusNode ?? null;
    const value = n?.nodeType === Node.TEXT_NODE ? n.textContent ?? '' : null;
    const offset = selection?.focusOffset ?? null;
    return {
      hasFocus: p.ownerDocument.hasFocus(),
      activeTag: p.ownerDocument.activeElement?.localName ?? null,
      editable: p.getAttribute('contenteditable'), text: p.textContent ?? '',
      focusNodeKind: n?.nodeType === Node.TEXT_NODE ? '#text' : n?.nodeType === Node.ELEMENT_NODE ? (n as Element).localName : null,
      focusNodeLengthUtf16: value?.length ?? null, focusOffsetUtf16: offset,
      focusAround: value !== null && offset !== null ? value.slice(Math.max(0, offset - 6), Math.min(value.length, offset + 6)) : null,
      selected: selection?.toString() ?? '', collapsed: selection?.isCollapsed ?? null,
    };
  });
}

async function initialize(page: Page) {
  await page.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;background:white} .edit{position:absolute;left:100px;top:100px;width:1000px;margin:0;font:32px sans-serif;white-space:nowrap}
  </style></head><body><p id="edit" class="edit" contenteditable="true">${FIXTURE}</p></body></html>`);
  const edit = page.locator('#edit');
  await expect(edit).toBeVisible();
  await installCapture(edit);
  return edit;
}

async function typeSpaceAfterCtrlEnd(page: Page, edit: EditTarget) {
  await edit.dblclick({ position: { x: 350, y: 18 } });
  const afterDoubleClick = await state(edit);
  await page.keyboard.press('Control+End');
  const beforeSpace = await state(edit);
  await page.keyboard.press('Space');
  const afterSpace = await state(edit);
  const events = await edit.evaluate(node => ((node.ownerDocument.defaultView as any).__nativeCalibration ?? []));
  return { afterDoubleClick, beforeSpace, afterSpace, events };
}

test('V7 Firefox native keyboard calibration: one page, parallel contexts, and transformed sandbox frame', async ({ browser }, info: TestInfo) => {
  test.skip(info.project.name !== 'firefox', 'This calibration is scoped to the failing Firefox lane.');
  const results: Record<string, unknown> = { run: RUN, browser: info.project.name, fixture: FIXTURE, fixtureLengthUtf16: FIXTURE.length };

  // One page is the focused-tab baseline.
  const singleContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    const page = await singleContext.newPage();
    const edit = await initialize(page);
    results.singlePage = await typeSpaceAfterCtrlEnd(page, edit);
  } finally { await singleContext.close(); }

  // Two independent contexts in the same Firefox process, replaying the original
  // sequential double-clicks and concurrent Ctrl+End + Space actions.
  const [contextA, contextB] = await Promise.all([
    browser.newContext({ viewport: { width: 1400, height: 900 } }),
    browser.newContext({ viewport: { width: 1400, height: 900 } }),
  ]);
  try {
    const [pageA, pageB] = await Promise.all([contextA.newPage(), contextB.newPage()]);
    const [editA, editB] = await Promise.all([initialize(pageA), initialize(pageB)]);
    await editA.dblclick({ position: { x: 350, y: 18 } });
    await editB.dblclick({ position: { x: 350, y: 18 } });
    const parallel = await Promise.all([
      (async () => {
        const afterDoubleClick = await state(editA);
        await pageA.keyboard.press('Control+End');
        const beforeSpace = await state(editA);
        await pageA.keyboard.press('Space');
        return { afterDoubleClick, beforeSpace, afterSpace: await state(editA), events: await editA.evaluate(node => ((node.ownerDocument.defaultView as any).__nativeCalibration ?? [])) };
      })(),
      (async () => {
        const afterDoubleClick = await state(editB);
        await pageB.keyboard.press('Control+End');
        const beforeSpace = await state(editB);
        await pageB.keyboard.press('Space');
        return { afterDoubleClick, beforeSpace, afterSpace: await state(editB), events: await editB.evaluate(node => ((node.ownerDocument.defaultView as any).__nativeCalibration ?? [])) };
      })(),
    ]);
    results.parallelContexts = { A: parallel[0], B: parallel[1] };
  } finally { await Promise.all([contextA.close(), contextB.close()]); }

  // Minimal iframe environment: sandboxed srcdoc, global user-select suppression,
  // text selection restored on the editor, and an outer CSS transform like the canvas.
  const frameContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    const page = await frameContext.newPage();
    await page.setContent(`<!doctype html><html><head><style>
      html,body{margin:0;user-select:none;-webkit-user-select:none} iframe{position:absolute;left:0;top:0;width:1200px;height:500px;border:0;transform:scale(.82);transform-origin:0 0}
    </style></head><body><iframe id="frame" sandbox="allow-scripts allow-same-origin"></iframe></body></html>`);
    const child = `<!doctype html><html><head><style>
      html,body,*{user-select:none;-webkit-user-select:none} body{margin:0;background:white}.edit{position:absolute;left:100px;top:100px;width:1000px;margin:0;font:32px sans-serif;white-space:nowrap;user-select:text;-webkit-user-select:text}
    </style></head><body><p id="edit" class="edit" contenteditable="true">${FIXTURE}</p></body></html>`;
    await page.locator('#frame').evaluate((node, srcdoc) => { (node as HTMLIFrameElement).srcdoc = srcdoc; }, child);
    const edit = page.frameLocator('#frame').locator('#edit');
    await expect(edit).toBeVisible();
    await installCapture(edit);
    const geometry = await page.locator('#frame').evaluate(node => {
      const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
      return { x: r.x, y: r.y, width: r.width, height: r.height, transform: s.transform, outerUserSelect: getComputedStyle(document.body).userSelect };
    });
    results.transformedSandboxFrame = { geometry, ...(await typeSpaceAfterCtrlEnd(page, edit)) };
  } finally { await frameContext.close(); }

  const output = info.outputPath('native-keyboard-calibration.json');
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(results, null, 2));
  await info.attach('native-keyboard-calibration.json', { body: Buffer.from(JSON.stringify(results, null, 2)), contentType: 'application/json' });
});
