/**
 * The server's own edits of a document an editor has open (an Agent-panel or MCP edit: docs.ts
 * agentEdit → docedit.ts, made on the document worker's mirror or on the main thread) go through
 * the repair of paragraph moves (server/moves.ts) as what they are: the server saw the document it
 * edited, so nothing it deleted comes back and nothing it wrote goes missing — in the document, in the
 * connected editor and in the file. The editor sends an agent's edit back (it applies it itself, and
 * y-websocket sends on what it did not get from the provider): that update deletes the originals the
 * edit copied, and once deleted their copies too — e2e/agent.spec.ts lost the whole sentence that way.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as Y from 'yjs';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ySyncPlugin, initProseMirrorDoc } from 'y-prosemirror';
import { schema } from '@overlyx/core';
import { typingAnchorPlugin } from '../packages/client/src/editor/plugins/typinganchor';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-agent-edit-moves-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_DOC_WORKERS = '1';

const { manager, docWorkers } = await import('../packages/server/src/docs.ts');
// a DOM for the editor only (the happy-dom environment would replace URL, which the document workers need)
{
  const { Window } = await import('happy-dom');
  const w = new Window();
  const g = globalThis as Record<string, unknown>;
  for (const k of ['window', 'document', 'navigator', 'MutationObserver', 'getComputedStyle', 'Node', 'HTMLElement', 'Element', 'DOMParser', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    if (g[k] === undefined) g[k] = k === 'window' ? w : (w as unknown as Record<string, unknown>)[k];
  }
}
type Doc = Awaited<ReturnType<typeof manager.open>>;

afterAll(async () => { await docWorkers.close(); });

const texDoc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const NET = Symbol('net');
let pending = 0;
/** until every message in flight has been delivered */
async function settle() { for (let i = 0; i < 200 && (pending > 0 || i < 3); i++) await new Promise(r => setTimeout(r, 5)); }

/** a y-prosemirror editor (with the typing anchor, like the client) connected to the document the way
 *  ws.ts connects one: updates both ways as messages, delivered after the current task */
function connect(doc: Doc, id: number) {
  const ydoc = new Y.Doc();
  ydoc.clientID = id;
  const conn = {};
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(doc.ydoc), NET);
  const later = (f: () => void) => { pending++; setTimeout(() => { try { f(); } finally { pending--; } }, 1); };
  ydoc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== NET) later(() => doc.moves.receive(u, conn, { step2: false })); });
  // an agent's edit (origin 'mcp') is applied by the editor itself (ws.ts MSG_AGENT_EDIT, undoable there),
  // and y-websocket sends it back like any update not from the provider
  const relay = (u: Uint8Array, origin: unknown) => { if (origin !== conn) later(() => Y.applyUpdate(ydoc, u, origin === 'mcp' ? 'agent-edit' : NET)); };
  doc.ydoc.on('update', relay);
  const fragment = ydoc.getXmlFragment('prosemirror');
  const { doc: pm, mapping } = initProseMirrorDoc(fragment, schema);
  const view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc: pm, plugins: [ySyncPlugin(fragment, { mapping }), typingAnchorPlugin()] }) });
  return {
    view,
    /** the text of the paragraphs, formulas as $…$, other inline nodes as <name> */
    pars(): string[] {
      const out: string[] = [];
      view.state.doc.forEach(p => { let s = ''; p.forEach(n => { s += n.isText ? n.text : n.type.name === 'math_inline' ? `$${n.attrs.latex}$` : `<${n.type.name}>`; }); out.push(s); });
      return out;
    },
    /** a formula at the end of the first paragraph (a paste of $…$) */
    appendFormula(latex: string) {
      const end = view.state.doc.firstChild!.nodeSize - 1;
      const tr = view.state.tr.insert(end, schema.nodes.math_inline.create({ latex }));
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 1)));
    },
    close() { doc.ydoc.off('update', relay); view.destroy(); },
  };
}

/** opened with its work on the main thread (no document worker), as OVERLYX_DOC_WORKERS=0 does */
async function onMain(id: string): Promise<Doc> {
  const pool = docWorkers as unknown as { broken: boolean };
  pool.broken = true;
  try {
    const d = await manager.open(id);
    Object.defineProperty(d, 'usesWorker', { get: () => false });
    return d;
  } finally { pool.broken = false; }
}

async function scenario(name: string, main: boolean) {
  mkdirSync(join(ROOT, 'projects', 'u', name), { recursive: true });
  const file = join(ROOT, 'projects', 'u', name, 'paper.tex');
  writeFileSync(file, texDoc('The agent will help with this paper.\n\nA second paragraph stays.'));
  const doc = main ? await onMain(`u/${name}/paper.tex`) : await manager.open(`u/${name}/paper.tex`);
  const editor = connect(doc, 4242);
  editor.appendFormula('E=mc^2');
  await settle();
  await doc.saveToFile();
  return { doc, editor, file };
}

describe('agent edits of a document with an editor connected', () => {
  for (const [where, main] of [['on the worker’s mirror', false], ['on the main thread', true]] as const) for (const round of [1, 2]) it(`made ${where}: tracked, then untracked, then taken back — the document, the editor and the file hold exactly what was asked (${round === 1 ? 'a new document' : 'its stored state again, the file written anew'})`, async () => {
    const { doc, editor, file } = await scenario(main ? 'agent-main' : 'agent', main);
    const t0 = await doc.textAsync();
    expect(t0).toContain('The agent will help with this paper.$E=mc^2$');

    // a tracked word change (the Agent panel with Track changes ticked)
    await doc.agentEdit('tracked', t0, { after: t0.replace('will help with', 'will assist with') }, { author: 'Agent' });
    await settle();
    const t1 = await doc.textAsync();
    expect(t1).toMatch(/\\lyxdeleted\{Agent\}\{[^}]*\}\{help\}\\lyxadded\{Agent\}\{[^}]*\}\{assist\}/);
    expect(t1).toContain('with this paper.$E=mc^2$');

    // an untracked one that puts a raw TeX command into the sentence (Track changes unticked)
    const want = t1.replace('this paper.', '\\brokenmacro{} this paper.');
    await doc.agentEdit('plain', t1, { after: want });
    await settle();
    expect(await doc.textAsync()).toBe(want);
    expect(doc.toText()).toBe(want);
    expect(editor.pars()[0]).toMatch(/with <inset> this paper\.\$E=mc\^2\$$/);
    await doc.saveToFile();
    expect(readFileSync(file, 'utf8')).toBe(want);

    // taken back (the checkpoint's Undo: a restore of the text before it)
    await doc.agentEdit('restore', want, { after: t1 });
    await settle();
    expect(await doc.textAsync()).toBe(t1);
    expect(doc.toText()).toBe(t1);
    expect(editor.pars()[0]).not.toContain('<inset>');
    expect(editor.pars()[0]).toMatch(/with this paper\.\$E=mc\^2\$$/);
    expect(editor.pars()[1]).toBe('A second paragraph stays.');
    await doc.saveToFile();
    expect(readFileSync(file, 'utf8')).toBe(t1);
    editor.close();
    await manager.unload(doc.id);
  });
});

describe('MCP edits (edit_document / write_document) of a document with an editor connected', () => {
  for (const [where, main] of [['on the worker’s mirror', false], ['on the main thread', true]] as const) it(`made ${where}: a passage replaced, a paragraph split and joined, tracked and not — exactly what was asked, everywhere`, async () => {
    const { doc, editor, file } = await scenario(main ? 'mcp-main' : 'mcp', main);
    const check = async (has: string[], hasNot: string[]) => {
      await settle();
      const t = await doc.textAsync();
      expect(doc.toText()).toBe(t);
      for (const s of has) expect(t).toContain(s);
      for (const s of hasNot) expect(t).not.toContain(s);
      await doc.saveToFile();
      expect(readFileSync(file, 'utf8')).toBe(t);
      return t;
    };
    // edit_document, tracked:false — a paragraph split in two (the second half copied into a new one)
    await doc.agentEdit('plain', null, { replace: { oldText: 'will help with this paper.', newText: 'will help.\n\nWith this paper.', all: false } });
    await check(['The agent will help.\n\nWith this paper.$E=mc^2$', 'A second paragraph stays.'], ['will help with']);
    expect(editor.pars().slice(0, 3)).toEqual(['The agent will help.', 'With this paper.$E=mc^2$', 'A second paragraph stays.']);
    // edit_document, tracked — words changed in the copied half
    await doc.agentEdit('tracked', null, { replace: { oldText: 'With this paper.', newText: 'With this draft.', all: false } }, { author: 'Agent' });
    await check(['With this \\lyxdeleted{Agent}', 'draft'], []);
    // write_document, tracked:false — the two joined again (the whole source given)
    const now = await doc.textAsync();
    const joined = now.replace(/The agent will help\.\n\n/, 'The agent will help. ');
    expect(joined).not.toBe(now);
    await doc.agentEdit('plain', null, { after: joined });
    const t = await check(['The agent will help. With this ', 'A second paragraph stays.'], []);
    expect(t).toBe(joined);
    expect(editor.pars()[0]).toMatch(/^The agent will help\. With this /);
    expect(editor.pars()[0]).toMatch(/\$E=mc\^2\$$/);
    editor.close();
    await manager.unload(doc.id);
  });
});
