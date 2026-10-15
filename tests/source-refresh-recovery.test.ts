// @vitest-environment jsdom
/** Actual-source async refresh/ownership regressions; parser and API responses are controlled. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document; Event: typeof Event; close: () => void } };
};
import { h, render } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { it } from 'vitest';
import type { Context } from 'node:vm';
type Target = { docId: string; view: Record<string, any>; ydoc: object };
type SourceMapReply = { text: string; spans: { start: number; end: number }[] };

const sourcePath = 'packages/client/src/app/SourcePane.tsx';
const source = readFileSync(sourcePath, 'utf8');
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const ast = (text: string) => ts.createSourceFile('actual.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function variable(tree: ts.SourceFile, name: string, optional = false) {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(tree); if (!found && optional) return ''; assert.ok(found, `actual ${name} must exist`);
  return `const ${found.getText(tree)};`;
}
const codearea = readFileSync('packages/client/src/app/codearea.ts', 'utf8');
const undoModule = { exports: {} as Record<string, any> };
new Function('exports', 'module', compile(codearea))(undoModule.exports, undoModule);
const mapTree = ast(readFileSync('packages/client/src/app/sourcemap.ts', 'utf8'));
const mapCode = mapTree.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['editRange', 'mapOffset', 'mapSpans'].includes(node.name?.text ?? ''))
  .map(node => node.getText(mapTree).replace(/^export /, '')).join('\n');
const oldText = String.raw`\begin{document}
control preview
\end{document}`;
const draftText = String.raw`\begin{document}
\section{unfinished draft
\end{document}`;
const remoteText = String.raw`\begin{document}
new remote preview
\end{document}`;
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(text: string) {
  const tree = ast(text), dom = new JSDOM('<textarea></textarea>');
  const el = dom.window.document.querySelector('textarea')!;
  el.value = oldText; el.setSelectionRange(oldText.length, oldText.length);
  const map = deferred<SourceMapReply>(), fallback = deferred<string>(), applyReply = deferred<{ warnings: string[] }>();
  const mapQueue = [map], fallbackQueue = [fallback];
  const state = { display: oldText, dirty: false, scheduledApply: 0, mapCalls: 0, fallbackCalls: 0,
    refreshFailed: false, applied: 'idle', applyCalls: [] as { doc: string; value: string }[], appliedResult: '', geometryTouches: 0, rafs: [] as (() => void)[], caretTimers: [] as (() => void)[] };
  const refs = {
    textRef: { current: oldText }, spansRef: { current: [{ start: 0, end: oldText.length }] },
    fragmentRef: { current: false }, dirtyRef: { current: false }, focused: { current: false },
    pendingReload: { current: false }, seq: { current: 0 }, ta: { current: el },
    undo: { current: new undoModule.exports.UndoStack({ value: oldText, start: oldText.length, end: oldText.length }) },
    refreshFailedRef: { current: false }, targetRef: { current: null as Target | null }, sourceOwner: { current: null as Target | null },
    inFlight: { current: null }, lastOffset: { current: null }, caretLock: { current: 0 },
  };
  const target: Target = { docId: 'control-source', view: { dom: { querySelectorAll: () => [] }, state: { selection: { $from: {}, $to: {}, $head: {}, empty: true } } }, ydoc: {} };
  refs.targetRef.current = target; refs.sourceOwner.current = target;
  const shared = { ...refs, el, document: dom.window.document,
    api: { texMap: () => { state.mapCalls++; return mapQueue.shift()?.promise ?? Promise.resolve({ text: remoteText, spans: [] }); },
      texText: () => { state.fallbackCalls++; return fallbackQueue.shift()?.promise ?? Promise.resolve(remoteText); },
      applySource: (doc: string, value: string) => { state.applyCalls.push({ doc, value }); return applyReply.promise; } },
    setText: (value: string) => { state.display = value; }, setDirty: (value: boolean) => { state.dirty = value; },
    setRefreshFailed: (value: boolean) => { state.refreshFailed = value; },
    setApplied: (value: string) => { state.applied = value; }, setApplyNote: () => {}, setProblems: () => {},
    setNotes: () => {}, setSel: () => {}, syncScroll: () => {},
    scheduleApply: () => { state.scheduledApply++; },
    editorContext: {}, checkTexHealth: () => [], lintTex: () => [], offsetNamed: () => null,
    useLayoutEffect, own: () => false, scrollEl: { scrollTop: 0, getBoundingClientRect: () => { state.geometryTouches++; return { top: 0 }; } },
    requestAnimationFrame: (callback: () => void) => { state.rafs.push(callback); return state.rafs.length; }, cancelAnimationFrame: () => {},
    lineEls: () => { state.geometryTouches++; return []; },
    setTimeout: (callback: () => void) => { state.caretTimers.push(callback); return state.caretTimers.length; }, clearTimeout: () => {},
    sel: { start: 0, end: 0 }, blocksOf: () => [],
    docPosOf: () => { state.geometryTouches++; return null; }, sourceOffsetOf: () => { state.geometryTouches++; return 0; },
    setCurLine: () => {}, setCurOff: () => {}, setCurSel: () => {}, lineOfOffset: () => 0,
  };
  const methods = ['markDirty', 'updateSel', 'load', 'changed', 'refreshMap', 'apply'].map(name => variable(tree, name)).join('\n');
  const extra = ['markRefreshFailed', 'sameTarget', 'ownsSource', 'holdPreviousSource'].map(name => variable(tree, name, true)).join('\n');
  const code = compile(mapCode + '\n' + extra + '\n' + methods + '\nglobalThis.methods = { load, changed, markDirty, refreshMap, apply };');
  const makeScope = (current: Target) => { const context = createContext({ ...shared, target: current, view: current.view, text: oldText, dirty: false, refreshFailed: false });
    runInContext(code, context); return context; };
  let scope = makeScope(target);
  let hook: ts.CallExpression | undefined;
  const effects: ts.ArrowFunction[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'useLayoutEffect' && node.getText(tree).includes('seq.current++')) hook = node;
      if (node.expression.text === 'useEffect' && ts.isArrowFunction(node.arguments[0])) effects.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const root = dom.window.document.createElement('div'); dom.window.document.body.append(root);
  const globalDocument = globalThis.document;
  function Guard({ context }: { context: Context }) { if (hook) runInContext(compile(hook.getText(tree)), context); return h('span', {}); }
  const commit = (context: Context) => { globalThis.document = dom.window.document; render(h(Guard, { context }), root); globalThis.document = globalDocument; };
  const unmount = () => { globalThis.document = dom.window.document; render(null, root); globalThis.document = globalDocument; };
  const caretEffects = effects.filter(node => node.getText(tree).includes('const head = sourceOffsetOf') || node.getText(tree).includes('const head = docPosOf'));
  const mirror = () => {
    const scrolls = ['onDocScroll', 'onSrcScroll'].map(name => variable(tree, name)).join('\n');
    runInContext(compile('let rafDoc = 0, rafSrc = 0;\n' + scrolls + '\nglobalThis.scrolls = [onDocScroll, onSrcScroll];'), scope);
    const caret = caretEffects.map(node => runInContext(compile('(' + node.getText(tree) + ')').trim().replace(/;$/, ''), scope));
    return { scrolls: scope.scrolls, caret };
  };
  el.addEventListener('input', () => scope.methods.changed(el));
  return { state, refs, el, map, fallback, mapQueue, applyReply, dom, load: () => scope.methods.load(),
    apply: () => scope.methods.apply(), refreshMap: (value: string) => scope.methods.refreshMap(value),
    clean: () => scope.methods.markDirty(false), mirror, commit: () => commit(scope), unmount,
    target, switchTarget: (next: Target) => { refs.targetRef.current = next; scope = makeScope(next); commit(scope); },
    dispose: () => { unmount(); dom.window.close(); },
    type: () => { el.value = draftText; el.setSelectionRange(draftText.length, draftText.length);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); },
  };
}


const candidate = source;
const run = (name: string, body: (f: ReturnType<typeof fixture>) => Promise<void>) => it(name, async () => {
  const item = fixture(candidate); try { await body(item); } finally { item.dispose(); }
});
run('late-success-keeps-draft-and-real-undo', async f => {
  const pending = f.load(); f.type(); f.map.resolve({ text: remoteText, spans: [] }); await pending;
  assert.equal(f.refs.textRef.current, draftText); assert.equal(f.el.value, draftText); assert.equal(f.state.display, draftText);
  assert.equal(f.refs.undo.current.canUndo, true); assert.equal(f.state.scheduledApply, 1);
});
run('late-failure-keeps-visible-and-autoapply-draft', async f => {
  const pending = f.load(); f.type(); f.map.reject(new Error('controlled offline')); f.fallback.reject(new Error('controlled offline')); await pending;
  assert.equal(f.refs.textRef.current, draftText); assert.equal(f.el.value, draftText); assert.equal(f.state.display, draftText);
  assert.equal(f.refs.undo.current.canUndo, true); assert.equal(f.state.scheduledApply, 1);
});
run('typed-epoch-survives-dirty-being-cleared', async f => {
  const pending = f.load(); f.type(); f.clean(); f.map.resolve({ text: remoteText, spans: [] }); await pending;
  assert.equal(f.refs.textRef.current, draftText); assert.equal(f.el.value, draftText); assert.equal(f.refs.undo.current.canUndo, true);
});
run('focused-preview-kept-until-blur', async f => {
  const pending = f.load(); f.refs.focused.current = true; f.map.resolve({ text: remoteText, spans: [] }); await pending;
  assert.equal(f.refs.textRef.current, oldText); assert.equal(f.refs.pendingReload.current, true);
});
run('offline-cache-preserved-with-stale-indicator', async f => {
  const spans = f.refs.spansRef.current, pending = f.load();
  f.map.reject(new Error('controlled offline')); f.fallback.reject(new Error('controlled offline')); await pending;
  assert.equal(f.refs.textRef.current, oldText); assert.equal(f.el.value, oldText); assert.equal(f.state.display, oldText);
  assert.equal(f.refs.spansRef.current, spans); assert.equal(f.state.refreshFailed, true); assert.equal(f.refs.refreshFailedRef.current, true);
  await f.load(); assert.equal(f.el.value, remoteText); assert.equal(f.state.refreshFailed, false);
});
run('normal-load-preserves-scroll-and-installs-current-source', async f => {
  f.el.scrollTop = 41; const pending = f.load(); f.map.resolve({ text: remoteText, spans: [] }); await pending;
  assert.equal(f.el.value, remoteText); assert.equal(f.el.scrollTop, 41); assert.equal(f.refs.sourceOwner.current, f.target);
});
run('old-target-response-and-new-target-apply-blocked', async f => {
  f.commit(); const pending = f.load(), next = { docId: 'control-next', view: {}, ydoc: {} };
  f.switchTarget(next); f.map.resolve({ text: remoteText, spans: [] }); await pending;
  assert.equal(f.el.value, oldText); assert.equal(f.state.refreshFailed, true);
  const applying = f.apply(); assert.equal(f.state.applyCalls.length, 0); assert.equal(await applying, false); assert.equal(f.state.applied, 'held');
  await f.load(); assert.equal(f.refs.sourceOwner.current, next); assert.equal(f.el.value, remoteText);
});
run('same-doc-id-new-view-still-requires-owner-refresh', async f => {
  f.commit(); f.switchTarget({ docId: f.target.docId, view: {}, ydoc: f.target.ydoc });
  const applying = f.apply(); assert.equal(f.state.applyCalls.length, 0); assert.equal(await applying, false);
});
run('unmount-invalidates-a-late-refresh', async f => {
  f.commit(); const pending = f.load(); f.unmount(); f.map.resolve({ text: remoteText, spans: [] }); await pending;
  assert.equal(f.el.value, oldText); assert.equal(f.refs.textRef.current, oldText);
});
run('late-old-map-does-not-install-on-new-owner', async f => {
  f.commit(); const spans = f.refs.spansRef.current, pending = f.refreshMap(oldText);
  f.switchTarget({ docId: 'control-next', view: {}, ydoc: {} });
  f.map.resolve({ text: oldText, spans: [{ start: 7, end: 9 }] }); await pending;
  assert.equal(f.refs.spansRef.current, spans);
});
run('valid-owner-apply-remains-available', async f => {
  f.type(); const pending = f.apply(); assert.equal(f.state.applyCalls.length, 1);
  f.applyReply.resolve({ warnings: [] }); assert.equal(await pending, true); assert.equal(f.state.dirty, false);
});
run('late-apply-result-cannot-clear-draft-on-switched-owner', async f => {
  f.commit(); f.type(); const pending = f.apply();
  f.switchTarget({ docId: 'control-next', view: {}, ydoc: {} }); f.applyReply.resolve({ warnings: [] });
  assert.equal(await pending, false); assert.equal(f.state.dirty, true); assert.equal(f.state.applied, 'held');
  assert.equal(f.state.applyCalls.length, 1); assert.equal(f.state.applyCalls[0].doc, 'control-source');
});
run('stale-scroll-and-caret-entries-dont-read-document-geometry', async f => {
  const mirror = f.mirror(); f.refs.refreshFailedRef.current = true; f.el.focus();
  for (const action of [...mirror.scrolls, ...mirror.caret]) action();
  assert.equal(f.state.rafs.length, 0); assert.equal(f.state.caretTimers.length, 0); assert.equal(f.state.geometryTouches, 0);
});
run('queued-scroll-and-caret-stop-if-preview-becomes-stale', async f => {
  const mirror = f.mirror(); f.el.focus();
  for (const action of mirror.scrolls) action();
  const sourceCaret = mirror.caret.find(action => action.toString().includes('setTimeout'));
  assert.ok(sourceCaret); sourceCaret(); assert.equal(f.state.rafs.length, 2); assert.equal(f.state.caretTimers.length, 1);
  f.refs.refreshFailedRef.current = true;
  for (const action of [...f.state.rafs, ...f.state.caretTimers]) action();
  assert.equal(f.state.geometryTouches, 0);
});
it("marks retained source as stale and offers a non-destructive retry", () => {
  assert.match(source, /role="status" data-source-refresh="stale"/);
  assert.match(source, /disabled=\{dirty\}.*Retry the source refresh/);
});
