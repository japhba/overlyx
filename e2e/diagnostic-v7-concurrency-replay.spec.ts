/** One-lane diagnostic replay of the original three-round Firefox collaboration failure. */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { apiLogin, PROJECTS_DIR, shareProject, userCredentials } from './helpers';

const RUN = `v7-replay-${Date.now().toString(36)}`;
const made: string[] = [];

// Capture only fixture-scoped editable text, native selection coordinates, and the
// actual inner-op packets received by the top-level app. Never retain URLs/headers.
const installCapture = async (page: Page) => page.addInitScript(() => {
  (window as any).__v7Native = [];
  (window as any).__v7Ops = [];
  (window as any).__v7Sources = [];
  (window as any).__v7SelectionCalls = [];
  (window as any).__v7ParentFocus = [];
  addEventListener('message', event => {
    const d = (event as MessageEvent).data;
    if (d?.__v7Native === true) (window as any).__v7Native.push(d.row);
    if (d?.__v7Source === true) (window as any).__v7Sources.push(d.row);
    if (d?.__v7SelectionCall === true) (window as any).__v7SelectionCalls.push(d.row);
    if (d?.ol !== 'ops' || !Array.isArray(d.ops)) return;
    const ops = d.ops.filter((op: any) => op?.t === 'inner').map((op: any) => ({
      path: op.path, before: op.before, html: op.html, as: op.as,
    }));
    if (ops.length) (window as any).__v7Ops.push({ version: d.version, ops });
  });
  if (window.parent === window) {
    for (const type of ['focus', 'blur', 'visibilitychange']) addEventListener(type, event => {
      const frame = document.querySelector('.dl-frame');
      (window as any).__v7ParentFocus.push({
        type, time: Number(performance.now().toFixed(2)), hasFocus: document.hasFocus(),
        visibility: document.visibilityState, activeTag: document.activeElement?.localName ?? null,
        activeIsCanvasFrame: document.activeElement === frame,
      });
    }, true);
    return;
  }
  addEventListener('message', event => {
    const d = (event as MessageEvent).data;
    if (d?.ol !== 'source' || !Number.isFinite(d.version) || typeof d.html !== 'string') return;
    const doc = new DOMParser().parseFromString(d.html, 'text/html');
    const sub = doc.querySelector('.sub');
    parent.postMessage({ __v7Source: true, row: { version: d.version, innerHTML: sub?.innerHTML ?? null } }, '*');
  });
  const fixture = () => document.querySelector('.sub');
  const outerFocus = () => {
    try {
      const doc = parent.document, frame = doc.querySelector('.dl-frame');
      return { hasFocus: doc.hasFocus(), activeTag: doc.activeElement?.localName ?? null, activeIsCanvasFrame: doc.activeElement === frame };
    } catch { return { hasFocus: null, activeTag: null, activeIsCanvasFrame: null }; }
  };
  const nodeKind = (node: Node | null) => node?.nodeType === Node.TEXT_NODE ? '#text'
    : node?.nodeType === Node.ELEMENT_NODE ? (node as Element).localName : node ? `node-${node.nodeType}` : null;
  const selectionState = () => {
    const p = fixture(), s = getSelection(), a = s?.anchorNode ?? null, f = s?.focusNode ?? null;
    const relevant = !!p && ((a && (a === p || p.contains(a))) || (f && (f === p || p.contains(f))) || document.activeElement === p);
    return {
      relevant,
      activeTag: document.activeElement?.localName ?? null,
      activeEditable: document.activeElement?.closest('[contenteditable="true"]')?.localName ?? null,
      anchorNodeKind: nodeKind(a), anchorOffset: s?.anchorOffset ?? null,
      focusNodeKind: nodeKind(f), focusOffset: s?.focusOffset ?? null,
      isCollapsed: s?.isCollapsed ?? null,
    };
  };
  const argInfo = (arg: unknown): unknown => {
    if (typeof arg === 'number' || typeof arg === 'string' || arg == null) return arg;
    if (arg instanceof Range) return {
      kind: 'Range', collapsed: arg.collapsed,
      startNodeKind: nodeKind(arg.startContainer), startOffset: arg.startOffset,
      endNodeKind: nodeKind(arg.endContainer), endOffset: arg.endOffset,
    };
    if (arg instanceof Node) return { kind: nodeKind(arg), tag: arg.nodeType === Node.ELEMENT_NODE ? (arg as Element).localName : null,
      textLengthUtf16: arg.nodeType === Node.TEXT_NODE ? arg.textContent?.length ?? null : null };
    return { kind: typeof arg };
  };
  const safeRuntimeCaller = () => {
    const stack = new Error().stack ?? '';
    const lines = stack.split('\n').slice(1);
    for (const line of lines) {
      const m = line.match(/(?:^|[/\\])(runtime(?:-[A-Za-z0-9_-]+)?\.js):(\d+):(\d+)\)?$/);
      if (!m) continue;
      return { script: 'runtime.js', line: Number(m[2]), column: Number(m[3]) };
    }
    return null;
  };
  const methods = ['removeAllRanges', 'addRange', 'setBaseAndExtent', 'collapse'];
  const hookStatus: unknown[] = [];
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(Selection.prototype, method);
    const original = (Selection.prototype as any)[method];
    if (typeof original !== 'function' || !descriptor || (!descriptor.writable && !descriptor.set)) {
      hookStatus.push({ method, hooked: false }); continue;
    }
    const wrapped = function(this: Selection, ...args: unknown[]) {
      const before = selectionState();
      try { return original.apply(this, args); }
      finally {
        const after = selectionState();
        if (before.relevant || after.relevant) parent.postMessage({ __v7SelectionCall: true, row: {
          method, time: Number(performance.now().toFixed(2)), args: args.map(argInfo),
          before, after, caller: safeRuntimeCaller(),
        } }, '*');
      }
    };
    try {
      Object.defineProperty(Selection.prototype, method, { ...descriptor, value: wrapped });
      hookStatus.push({ method, hooked: true });
    } catch { hookStatus.push({ method, hooked: false }); }
  }
  parent.postMessage({ __v7SelectionCall: true, row: { kind: 'hook-status', methods: hookStatus } }, '*');
  const state = () => {
    const p = fixture(), s = getSelection(), n = s?.focusNode;
    const value = p?.textContent ?? '';
    const offset = s?.focusOffset ?? null;
    const focusText = n?.nodeType === Node.TEXT_NODE ? n.textContent ?? '' : null;
    return {
      activeTag: document.activeElement?.localName ?? null,
      editableTag: document.activeElement?.closest('[contenteditable="true"]')?.localName ?? null,
      editable: p?.getAttribute('contenteditable') ?? null,
      rootText: value,
      focusNodeKind: n?.nodeType === Node.TEXT_NODE ? '#text' : n?.nodeType === Node.ELEMENT_NODE ? (n as Element).localName : null,
      focusParent: n?.nodeType === Node.ELEMENT_NODE ? (n as Element).localName : n?.parentElement?.localName ?? null,
      focusOffset: offset,
      anchorOffset: s?.anchorOffset ?? null,
      collapsed: s?.isCollapsed ?? null,
      selected: s?.toString() ?? '',
      focusTextLength: focusText?.length ?? null,
      focusTextAround: focusText !== null && offset !== null ? focusText.slice(Math.max(0, offset - 5), Math.min(focusText.length, offset + 5)) : null,
      textEnd: value.slice(-20),
    };
  };
  const send = (kind: string, phase: string, extra: Record<string, unknown> = {}) => {
    const p = fixture();
    parent.postMessage({ __v7Native: true, row: {
      kind, phase, time: Number(performance.now().toFixed(2)), ...extra, ...state(), outerFocus: outerFocus(),
      inputHtml: kind === 'input' ? p?.innerHTML ?? null : undefined,
    } }, '*');
  };
  const addKeyboardRecord = (type: string) => (event: Event, phase: string) => {
    const target = event.target as Element | null;
    if (!target?.closest('.sub[contenteditable="true"]')) return;
    const e = event as KeyboardEvent;
    send(type, phase, { key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, trusted: e.isTrusted, defaultPrevented: e.defaultPrevented });
  };
  for (const type of ['keydown', 'keyup']) {
    document.addEventListener(type, event => addKeyboardRecord(type)(event, 'capture'), true);
    window.addEventListener(type, event => addKeyboardRecord(type)(event, 'window-bubble'), false);
  }
  for (const type of ['beforeinput', 'input']) {
    const recordInput = (event: Event, phase: string) => {
      const target = event.target as Element | null;
      if (!target?.closest('.sub[contenteditable="true"]')) return;
      const input = event as InputEvent;
      send(type, phase, { inputType: input.inputType, data: input.data, trusted: input.isTrusted, defaultPrevented: input.defaultPrevented });
    };
    document.addEventListener(type, event => recordInput(event, 'capture'), true);
    window.addEventListener(type, event => recordInput(event, 'window-bubble'), false);
  }
  document.addEventListener('selectionchange', () => {
    const current = selectionState();
    if (current.relevant) parent.postMessage({ __v7Native: true, row: {
      kind: 'selectionchange', phase: 'document', time: Number(performance.now().toFixed(2)), ...current,
      outerFocus: outerFocus(),
    } }, '*');
  });
});

async function session(browser: Browser, project: string) {
  const key = `admin/${project}`;
  made.push(key);
  const folder = path.join(PROJECTS_DIR, key, 'talk');
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'index.html');
  const initial = 'Shared baseline.';
  writeFileSync(file, `<!doctype html><html><head><meta name="overlyx" content="deck"><title>Concurrent editing</title>
  <style>body{margin:0}.slide{position:relative;width:1280px;height:720px;background:white}.sub{position:absolute;left:100px;top:150px;width:1000px;font:32px sans-serif}</style></head><body>
  <section class="slide"><p class="sub">${initial}</p><p style="position:absolute;left:100px;top:350px;font:32px sans-serif">Other box</p></section></body></html>`);
  writeFileSync(path.join(folder, 'second.html'), '<html><head><meta name="overlyx" content="deck"></head><body><section class="slide" style="width:1280px;height:720px"><p>Second canvas</p></section></body></html>');
  await shareProject(browser, key, ['u1']);
  const contexts = await Promise.all([browser.newContext({ baseURL: process.env.OVERLYX_E2E_BASE }), browser.newContext({ baseURL: process.env.OVERLYX_E2E_BASE })]);
  const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
  await Promise.all([installCapture(a), installCapture(b)]);
  await apiLogin(contexts[0]); await apiLogin(contexts[1], userCredentials('u1'));
  for (const page of [a, b]) {
    await page.goto(`/#/${key}/talk/index.html`);
    await expect(page.frameLocator('.dl-frame').locator('.sub')).toHaveText(initial);
  }
  return { a, b, file, initial, close: async () => { await Promise.all(contexts.map(context => context.close())); } };
}

const box = (page: Page) => page.frameLocator('.dl-frame').locator('.sub');
async function append(page: Page, text: string, finish = true) {
  if (await box(page).getAttribute('contenteditable') !== 'true') await box(page).dblclick();
  await expect(box(page)).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.press('Control+End'); await page.keyboard.type(text);
  if (finish) await page.keyboard.press('Escape');
}
async function read(page: Page, field: '__v7Native' | '__v7Ops' | '__v7SelectionCalls' | '__v7ParentFocus') {
  return page.evaluate(name => (window as any)[name] ?? [], field);
}

test.afterAll(() => {
  if (!process.env.OVERLYX_E2E_KEEP) for (const key of made) rmSync(path.join(PROJECTS_DIR, key), { recursive: true, force: true });
});

test('V7 diagnostic: replay original three-round rapid save, undo/redo, reload sequence with actual input ops', async ({ browser }, info) => {
  const s = await session(browser, `${RUN}-parallel-undo`);
  try {
    // Keep the original test's exact sequence: no diagnostic waits or pauses between key presses.
    for (let round = 0; round < 3; round++) {
      await box(s.a).dblclick(); await box(s.b).dblclick();
      await Promise.all([append(s.a, ` A${round}😀`), append(s.b, ` B${round}Ω`)]);
      for (const token of [`A${round}😀`, `B${round}Ω`]) await expect.poll(() => readFileSync(s.file, 'utf8')).toContain(token);
      await expect.poll(() => box(s.a).textContent()).toContain(`B${round}Ω`);
      await expect.poll(() => box(s.b).textContent()).toContain(`A${round}😀`);
    }
    const beforeUndo = { text: await box(s.a).textContent(), source: readFileSync(s.file, 'utf8') };
    await s.a.locator('[data-tb="dk-undo"]').click();
    await expect.poll(() => readFileSync(s.file, 'utf8')).not.toContain('A2😀');
    const afterUndo = { text: await box(s.a).textContent(), source: readFileSync(s.file, 'utf8') };
    await s.a.locator('[data-tb="dk-redo"]').click();
    await expect.poll(() => readFileSync(s.file, 'utf8')).toContain('A2😀');
    const afterRedo = { text: await box(s.a).textContent(), source: readFileSync(s.file, 'utf8') };
    const evidenceBeforeReload = {
      inputA: await read(s.a, '__v7Native'), inputB: await read(s.b, '__v7Native'),
      opsA: await read(s.a, '__v7Ops'), opsB: await read(s.b, '__v7Ops'),
      sourcesA: await read(s.a, '__v7Sources'), sourcesB: await read(s.b, '__v7Sources'),
      selectionCallsA: await read(s.a, '__v7SelectionCalls'), selectionCallsB: await read(s.b, '__v7SelectionCalls'),
      parentFocusA: await read(s.a, '__v7ParentFocus'), parentFocusB: await read(s.b, '__v7ParentFocus'),
    };
    const outputPath = info.outputPath('sanitized-v7-replay-diagnostic.json');
    mkdirSync(path.dirname(outputPath), { recursive: true });
    const preReload = {
      run: RUN, phase: 'pre-reload', beforeUndo, afterUndo, afterRedo,
      ...evidenceBeforeReload,
      sourceParagraph: (readFileSync(s.file, 'utf8').match(/<p class="sub">([\s\S]*?)<\/p>/)?.[1] ?? null),
    };
    writeFileSync(outputPath, JSON.stringify(preReload, null, 2));
    await s.a.reload(); await s.b.reload();
    const afterReload = { A: await box(s.a).textContent(), B: await box(s.b).textContent(), source: readFileSync(s.file, 'utf8') };
    const result = {
      run: RUN,
      beforeUndo, afterUndo, afterRedo, afterReload,
      ...evidenceBeforeReload,
      tokensInSavedHtml: Object.fromEntries(['B0Ω', 'B1Ω', 'B2Ω', 'A0😀', 'A1😀', 'A2😀'].map(token => [token, readFileSync(s.file, 'utf8').includes(token)])),
    };
    writeFileSync(outputPath, JSON.stringify(result, null, 2));
    await info.attach('sanitized-v7-replay-diagnostic.json', {
      body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json',
    });
  } finally { await s.close(); }
});
