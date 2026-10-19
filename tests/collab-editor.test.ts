// @vitest-environment happy-dom
/**
 * The editor's sync (client editor/collab.ts) inside the whole editor — every plugin of the shared
 * assembly (assembly.ts), the node views, the LyX key bindings — with keys pressed as a user
 * presses them, on two editors that exchange their updates. After every key both editors show
 * exactly what their CRDTs read as, and once the updates are exchanged they show the same.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorView } from 'prosemirror-view';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { schema } from '@overlyx/core';
import { Reader, writeDocument, REMOTE_META, type RemoteMeta } from '@overlyx/core/collab/index.ts';
import { assemblePlugins, editorViewProps } from '../packages/client/src/editor/assembly.ts';
import { collabSync, cursorPlugin, undoPlugin, undo, redo } from '../packages/client/src/editor/collab';
import { lyxToPm } from '@overlyx/core';
import { parseDocumentText } from '../packages/server/src/texdoc.ts';

const NET = Symbol('net');

class Editor {
  ydoc = new Y.Doc();
  awareness: Awareness;
  view: EditorView;
  sync: ReturnType<typeof collabSync>;
  outbox: Uint8Array[] = [];
  /** of each change from the other editor: whether it came as the CRDT's own steps (not a diff) */
  exact: boolean[] = [];
  constructor(id: number, state?: Uint8Array) {
    this.ydoc.clientID = id;
    if (state) Y.applyUpdate(this.ydoc, state, NET);
    this.awareness = new Awareness(this.ydoc);
    this.sync = collabSync(this.ydoc);
    let viewRef: EditorView | null = null;
    const watch = new Plugin({ appendTransaction: trs => { for (const t of trs) { const m = t.getMeta(REMOTE_META) as RemoteMeta | undefined; if (m) this.exact.push(m.exact); } return null; } });
    const plugins = assemblePlugins({ sync: [this.sync.plugin, cursorPlugin(this.awareness), undoPlugin(), watch], marginMode: false, getView: () => viewRef });
    const host = document.createElement('div');
    document.body.appendChild(host);
    this.view = new EditorView(host, { state: EditorState.create({ schema, doc: this.sync.doc, plugins }), ...editorViewProps({ docId: 'p/a.tex' }) });
    viewRef = this.view;
    this.ydoc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== NET) this.outbox.push(u); });
  }
  /** the editor shows what the CRDT reads as */
  check(what: string): void {
    const read = new Reader(schema, this.ydoc).read();
    expect(this.view.state.doc.eq(read), `${what}: the editor shows what its CRDT reads as\n${JSON.stringify(this.view.state.doc.toJSON()).slice(0, 600)}\n${JSON.stringify(read.toJSON()).slice(0, 600)}`).toBe(true);
  }
  key(key: string, mods: { shift?: boolean; ctrl?: boolean } = {}): boolean {
    const ev = new KeyboardEvent('keydown', { key, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, bubbles: true });
    return !!this.view.someProp('handleKeyDown', f => f(this.view, ev));
  }
  type(text: string): void {
    for (const ch of text) {
      const { from, to } = this.view.state.selection;
      const handled = this.view.someProp('handleTextInput', f => f(this.view, from, to, ch, () => this.view.state.tr.insertText(ch, from, to)));
      if (!handled) this.view.dispatch(this.view.state.tr.insertText(ch, from, to));
    }
  }
  at(needle: string, offset = 0): void {
    let pos = -1;
    this.view.state.doc.descendants((n, p) => { if (pos >= 0) return false; if (n.isText && n.text!.includes(needle)) pos = p + n.text!.indexOf(needle) + offset; return true; });
    expect(pos, `"${needle}"`).toBeGreaterThanOrEqual(0);
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos)));
  }
  text(): string[] { const out: string[] = []; this.view.state.doc.forEach(p => out.push(p.textContent)); return out; }
  destroy(): void { this.view.destroy(); this.sync.destroy(); this.awareness.destroy(); this.ydoc.destroy(); }
}

const editors: Editor[] = [];
afterEach(() => { for (const e of editors.splice(0)) e.destroy(); });

function pair(...paragraphs: string[]): [Editor, Editor, () => void] {
  return pairOf(schema.node('doc', null, paragraphs.map(t => schema.nodes.paragraph.create(null, t ? schema.text(t) : null))));
}

/** two editors on the document of a .tex file */
function pairOfTex(tex: string): [Editor, Editor, () => void] {
  return pairOf(schema.nodeFromJSON(lyxToPm(parseDocumentText(tex, 'u/p', 'a.tex').doc)));
}

function pairOf(doc: PMNode): [Editor, Editor, () => void] {
  const seed = new Y.Doc();
  seed.transact(() => writeDocument(schema, seed, doc));
  const state = Y.encodeStateAsUpdate(seed);
  const a = new Editor(1, state), b = new Editor(2, state);
  editors.push(a, b);
  const exchange = () => {
    for (let round = 0; round < 6; round++) {
      const ua = a.outbox.splice(0), ub = b.outbox.splice(0);
      if (!ua.length && !ub.length) break;
      for (const u of ua) Y.applyUpdate(b.ydoc, u, NET);
      for (const u of ub) Y.applyUpdate(a.ydoc, u, NET);
    }
    a.check('after the exchange (a)'); b.check('after the exchange (b)');
    expect(a.view.state.doc.eq(b.view.state.doc), 'the editors agree').toBe(true);
  };
  return [a, b, exchange];
}

describe('the sync inside the whole editor', () => {
  it('typing, Enter, Backspace, bold, undo and redo — and the other editor follows', () => {
    const [a, b, exchange] = pair('The first paragraph of text.', 'A second one.');
    a.at('paragraph of'); a.check('select');
    a.type('long '); a.check('typing');
    a.key('Enter'); a.check('Enter');
    a.type('New start. '); a.check('typing after Enter');
    exchange();
    expect(b.text()).toEqual(['The first long ', 'New start. paragraph of text.', 'A second one.']);
    // Backspace at a paragraph start joins
    b.at('A second'); b.key('Backspace'); b.check('Backspace');
    exchange();
    expect(a.text()).toEqual(['The first long ', 'New start. paragraph of text.A second one.']);
    // bold by key
    a.at('first'); a.view.dispatch(a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, a.view.state.selection.from, a.view.state.selection.from + 5)));
    a.key('b', { ctrl: true }); a.check('Ctrl+B');
    exchange();
    let bold = ''; b.view.state.doc.descendants(n => { if (n.isText && n.marks.some(m => m.type.name === 'series')) bold += n.text; });
    expect(bold).toBe('first');
    // undo (one's own steps only) and redo
    expect(undo(a.view.state, a.view.dispatch, a.view)).toBe(true); a.check('undo');
    exchange();
    bold = ''; b.view.state.doc.descendants(n => { if (n.isText && n.marks.some(m => m.type.name === 'series')) bold += n.text; });
    expect(bold).toBe('');
    expect(redo(a.view.state, a.view.dispatch, a.view)).toBe(true); a.check('redo');
    exchange();
  });

  it('both type into the same paragraph at the same time; one presses Enter in it', () => {
    const [a, b, exchange] = pair('alpha beta gamma delta');
    a.at('gamma'); a.type('AAA '); a.check('a types');
    b.at('beta'); b.type('BBB '); b.check('b types');
    b.at('delta'); b.key('Enter'); b.check('b Enter');
    exchange();
    expect(a.text()).toEqual(['alpha BBB beta AAA gamma ', 'delta']);
  });

  it('a formula inserted with the keyboard, typed around, the paragraph split before it', () => {
    const [a, b, exchange] = pair('Before after.');
    a.at(' after'); a.key('m', { ctrl: true }); a.check('Ctrl+M');
    // leave the formula, type after it
    a.at(' after'); a.type(' then'); a.check('typing after the formula');
    exchange();
    b.at('Before'); b.key('Enter'); b.check('Enter at the start');
    exchange();
    expect(a.view.state.doc.childCount).toBe(2);
  });

  it('what a plugin appends to a change is undone with it: a shape deleted, the arrow attached to it let go; one undo', () => {
    const deck = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\olshape{x=20mm,y=20mm,w=30mm,h=20mm,vb=0 0 30 20,draw=black,name=A,id=o1}{M 0 0 L 30 0 L 30 20 L 0 20 Z}
\olshape{x=100mm,y=50mm,w=30mm,h=20mm,vb=0 0 30 20,draw=black,name=B,id=o2}{M 0 0 L 30 0 L 30 20 L 0 20 Z}
\olshape{x=50mm,y=30mm,w=50mm,h=30mm,vb=0 0 50 30,draw=black,arrows=-Stealth,from=o1.e,to=o2.w}{M 0 0 L 50 30}
\end{frame}
\end{document}
`;
    const seed = new Y.Doc();
    seed.transact(() => writeDocument(schema, seed, schema.nodeFromJSON(lyxToPm(parseDocumentText(deck, 'u/p', 'deck.tex').doc))));
    const e = new Editor(1, Y.encodeStateAsUpdate(seed));
    editors.push(e);
    const find = (name: string) => { let at = -1; e.view.state.doc.descendants((n, p) => { if (at < 0 && n.attrs.name === name) at = p; }); return at; };
    const arrow = () => { let a: PMNode | null = null; e.view.state.doc.descendants(n => { if (!a && n.attrs.from) a = n; }); return a as PMNode | null; };
    expect(arrow()?.attrs.to).toBe('o2.w');
    const b = find('B');
    e.view.dispatch(e.view.state.tr.delete(b, b + e.view.state.doc.nodeAt(b)!.nodeSize));
    e.check('the shape deleted');
    expect(find('B')).toBe(-1);
    expect(arrow()?.attrs.to ?? null).toBe(null);
    expect(undo(e.view.state, e.view.dispatch, e.view)).toBe(true); e.check('undo');
    expect(find('B')).toBeGreaterThan(0);
    expect(arrow()?.attrs.to).toBe('o2.w');
  });

  it('typing in a table cell comes to the other editor as its own steps; each undoes only its own typing', () => {
    const [a, b, exchange] = pairOfTex('\\documentclass{article}\n\\begin{document}\nA table:\n\\begin{tabular}{ll}\nalpha & beta\\\\\ngamma & delta\n\\end{tabular}\n\nAfter.\n\n\\end{document}\n');
    a.at('beta'); a.type('big '); a.check('a types in a cell');
    b.at('delta', 5); b.type(' dot'); b.check('b types in another cell');
    b.at('beta', 4); b.type('s'); b.check('b types in the cell a typed in');
    exchange();
    const cells = (e: Editor) => { const out: string[] = []; e.view.state.doc.descendants(n => { if (n.type.spec.tableRole === 'cell' || n.type.spec.tableRole === 'header_cell') { out.push(n.textContent); return false; } return true; }); return out; };
    expect(cells(a)).toEqual(['alpha', 'big betas', 'gamma', 'delta dot']);
    expect(a.exact.length).toBeGreaterThan(0);
    expect(a.exact.every(Boolean) && b.exact.every(Boolean), `exact: a ${a.exact} b ${b.exact}`).toBe(true);
    expect(undo(a.view.state, a.view.dispatch, a.view)).toBe(true); a.check('a undoes');
    exchange();
    expect(cells(b)).toEqual(['alpha', 'betas', 'gamma', 'delta dot']);
  });

  it('on a slide: typing in a text box, an object moved — the other editor gets them as their own steps; undo is per editor', () => {
    const [a, b, exchange] = pairOfTex(String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\olshape{x=20mm,y=20mm,w=30mm,h=20mm,vb=0 0 30 20,draw=black,name=A}{M 0 0 L 30 0 L 30 20 L 0 20 Z}
\begin{olbox}{x=20mm,y=70mm,w=60mm,h=10mm,font=14pt}
Some words here
\end{olbox}
\end{frame}
\end{document}
`);
    a.at('words'); a.type('more '); a.check('a types in the box');
    b.at('here', 4); b.type(' too'); b.check('b types in the box');
    let shape = -1;
    b.view.state.doc.descendants((n, p) => { if (shape < 0 && n.attrs.name === 'A') shape = p; });
    b.view.dispatch(b.view.state.tr.setNodeMarkup(shape, undefined, { ...b.view.state.doc.nodeAt(shape)!.attrs, x: '40mm' }));
    b.check('b moves the shape');
    exchange();
    let box = '', x = '';
    a.view.state.doc.descendants(n => { if (n.type.name === 'ol_box') box = n.textContent; if (n.attrs.name === 'A') x = String(n.attrs.x); });
    expect(box).toBe('Some more words here too');
    expect(x).toBe('40mm');
    expect(a.exact.every(Boolean) && b.exact.every(Boolean), `exact: a ${a.exact} b ${b.exact}`).toBe(true);
    expect(undo(a.view.state, a.view.dispatch, a.view)).toBe(true); a.check('a undoes');
    exchange();
    b.view.state.doc.descendants(n => { if (n.type.name === 'ol_box') box = n.textContent; if (n.attrs.name === 'A') x = String(n.attrs.x); });
    expect(box).toBe('Some words here too');
    expect(x).toBe('40mm');
  });

  it('a remote change while the cursor is in the changed paragraph keeps the cursor where it was', () => {
    const [a, b, exchange] = pair('one two three');
    a.at('three'); const before = a.view.state.selection.from;
    b.at('one'); b.type('zero '); b.check('b types before');
    exchange();
    expect(a.view.state.selection.from).toBe(before + 'zero '.length);
    expect(a.view.state.doc.textBetween(a.view.state.selection.from, a.view.state.selection.from + 5)).toBe('three');
  });
});
