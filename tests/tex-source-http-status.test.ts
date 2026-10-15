// @vitest-environment jsdom
/** Real API/fetch Responses plus the actual SourcePane loader and undo implementation. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { api, API_BASE } from '../packages/client/src/api';
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document; close: () => void } };
};

const statuses = [400, 401, 403, 404, 500, 502, 503];
const id = 'fictional/Your Name/slides & notes.tex';
const cached = String.raw`\begin{document}cached preview\end{document}`;
const fresh = String.raw`\begin{document}fresh preview\end{document}`;
const bodies = ['{"error":"CONTROL_ERROR_BODY"}', 'CONTROL_PLAIN_ERROR_BODY', '<html>CONTROL_PROXY_ERROR</html>'];
const compile = (source: string) => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const tree = (source: string) => ts.createSourceFile('actual.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function variable(ast: ts.SourceFile, name: string): string {
  let found: ts.VariableDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(found, 'actual-source binding must exist'); return `const ${found.getText(ast)};`;
}
const pane = tree(readFileSync('packages/client/src/app/SourcePane.tsx', 'utf8'));
const mapping = tree(readFileSync('packages/client/src/app/sourcemap.ts', 'utf8'));
const mapCode = mapping.statements.filter(node => ts.isFunctionDeclaration(node) && ['editRange', 'mapOffset'].includes(node.name?.text ?? ''))
  .map(node => node.getText(mapping).replace(/^export /, '')).join('\n');
type Snapshot = { value: string; start: number; end: number };
type Undo = { canUndo: boolean; record(snapshot: Snapshot): void };
const codearea = { exports: {} as { UndoStack?: new (snapshot: Snapshot) => Undo } };
new Function('exports', 'module', compile(readFileSync('packages/client/src/app/codearea.ts', 'utf8')))(codearea.exports, codearea);

function controlledFetch(responses: (Response | Error | DOMException)[]) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL) => {
    const next = responses.shift(); assert.ok(next, 'controlled response available');
    if (!(next instanceof Response)) throw next; return next;
  });
  vi.stubGlobal('fetch', fetchMock); return fetchMock;
}
function fixture() {
  const dom = new JSDOM('<textarea></textarea>');
  const el = dom.window.document.querySelector('textarea')!;
  el.value = cached; el.setSelectionRange(8, 8);
  const UndoStack = codearea.exports.UndoStack!;
  const undo = new UndoStack({ value: cached.slice(0, -1), start: 0, end: 0 });
  undo.record({ value: cached, start: 8, end: 8 }); assert.equal(undo.canUndo, true);
  const state = { display: cached, stale: false };
  const target = { docId: id, view: {}, ydoc: {} };
  const refs = { textRef: { current: cached }, spansRef: { current: [{ start: 0, end: cached.length }] },
    fragmentRef: { current: false }, sourceOwner: { current: target }, targetRef: { current: target },
    seq: { current: 0 }, dirtyRef: { current: false }, focused: { current: false },
    pendingReload: { current: false }, refreshFailedRef: { current: false }, ta: { current: el }, undo: { current: undo } };
  const scope = createContext({ ...refs, target, api,
    setText: (value: string) => { state.display = value; }, setRefreshFailed: (value: boolean) => { state.stale = value; }, syncScroll: () => {} });
  runInContext(compile(mapCode + '\n' + variable(pane, 'markRefreshFailed') + '\n' + variable(pane, 'load') + '\nglobalThis.load = load;'), scope);
  return { refs, state, el, undo, load: scope.load as () => Promise<void>, dispose: () => dom.window.close() };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(statuses)('rejects HTTP %i as non-source and retains the cached preview, real undo and spans', async status => {
  for (const body of bodies) {
    const fetchMock = controlledFetch([new Response(body, { status })]);
    await expect(api.texText(id)).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/docs/${encodeURIComponent(id)}/tex`);
  }
  const fetchMock = controlledFetch([new Response(bodies[0], { status }), new Response(bodies[0], { status })]);
  const f = fixture(); const spans = f.refs.spansRef.current;
  try {
    await f.load();
    expect(f.refs.textRef.current).toBe(cached); expect(f.el.value).toBe(cached); expect(f.state.display).toBe(cached);
    expect(f.undo.canUndo).toBe(true); expect(f.refs.spansRef.current).toBe(spans);
    expect(f.state.stale).toBe(true); expect(f.refs.refreshFailedRef.current).toBe(true); expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally { f.dispose(); }
});

it('preserves exact successful source bytes, including empty, Unicode and legitimate JSON-looking TeX', async () => {
  for (const body of ['', 'plain source', String.raw`\begin{document}π∑ Your Name\end{document}`, '{"error":"legitimate source example"}']) {
    controlledFetch([new Response(body, { status: 200 })]); expect(await api.texText(id)).toBe(body);
  }
  controlledFetch([new Response(null, { status: 204 })]); expect(await api.texText(id)).toBe('');
});
it('preserves transport/abort/read failures but reports denied HTTP before consuming a broken error body', async () => {
  for (const error of [new TypeError('CONTROL_OFFLINE'), new DOMException('CONTROL_ABORT', 'AbortError')]) {
    controlledFetch([error]); await expect(api.texText(id)).rejects.toBe(error);
  }
  const failure = new Error('CONTROL_STREAM_FAILURE');
  const response = (status: number) => new Response(new ReadableStream({ start(controller) { controller.error(failure); } }), { status });
  controlledFetch([response(200)]); await expect(api.texText(id)).rejects.toBe(failure);
  controlledFetch([response(401)]); await expect(api.texText(id)).rejects.toMatchObject({ status: 401 });
});
it('keeps the legacy no-map fallback and recovers a stale preview on a successful retry', async () => {
  controlledFetch([new Response('{"error":"no map"}', { status: 404 }), new Response(fresh, { status: 200 })]);
  const legacy = fixture();
  try { await legacy.load(); expect(legacy.refs.textRef.current).toBe(fresh); expect(legacy.el.value).toBe(fresh); expect(legacy.state.stale).toBe(false); }
  finally { legacy.dispose(); }
  const fetchMock = controlledFetch([new Response('failed', { status: 503 }), new Response('failed', { status: 503 }),
    new Response(JSON.stringify({ text: fresh, spans: [] }), { status: 200 })]);
  const retry = fixture();
  try {
    await retry.load(); expect(retry.state.stale).toBe(true); expect(retry.refs.textRef.current).toBe(cached);
    await retry.load(); expect(retry.refs.textRef.current).toBe(fresh); expect(retry.state.stale).toBe(false); expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally { retry.dispose(); }
});
