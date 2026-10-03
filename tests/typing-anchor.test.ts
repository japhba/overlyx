// @vitest-environment happy-dom
/**
 * Typed text joins the Yjs history where it was typed (editor/plugins/typinganchor.ts). y-prosemirror's
 * prefix-first diff anchored a character typed in front of an equal one ("q" before "queries") behind
 * that character, so two users typing at the same place — one of them offline — got their words
 * spliced into each other mid-word on reconnect (CHAOS-2: "values and  Zc2on Zc1offq0006Z q0000Z queries").
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { splitBlock } from 'prosemirror-commands';
import { EditorView } from 'prosemirror-view';
import * as Y from 'yjs';
import { ySyncPlugin, initProseMirrorDoc, prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { schema } from '@overlyx/core';
import { typingAnchorPlugin, anchoredEdit } from '../packages/client/src/editor/plugins/typinganchor';

type Json = Record<string, unknown>;
const par = (...content: Json[]): Json => ({ type: 'paragraph', content });
const text = (t: string, marks?: Json[]): Json => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const math = (latex: string): Json => ({ type: 'math_inline', attrs: { latex } });

/** a Y.Doc holding `doc`, as the server would have it */
function baseState(doc: Json): Uint8Array {
  const y = new Y.Doc();
  prosemirrorJSONToYXmlFragment(schema, doc, y.getXmlFragment('prosemirror'));
  return Y.encodeStateAsUpdate(y);
}

/** one client: its own Y.Doc (from the shared state) and an editor bound to it */
function client(state: Uint8Array, id: number, anchored = true) {
  const ydoc = new Y.Doc();
  ydoc.clientID = id;
  Y.applyUpdate(ydoc, state);
  const fragment = ydoc.getXmlFragment('prosemirror');
  const { doc, mapping } = initProseMirrorDoc(fragment, schema);
  const plugins = [ySyncPlugin(fragment, { mapping }), ...(anchored ? [typingAnchorPlugin()] : [])];
  const view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc, plugins }) });
  return { ydoc, view };
}

/** put the cursor right before the first occurrence of `needle` and type `s` key by key */
function typeBefore(view: EditorView, needle: string, s: string) {
  let at = -1;
  view.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text!.includes(needle)) at = pos + n.text!.indexOf(needle); });
  expect(at).toBeGreaterThan(0);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  for (const ch of s) view.dispatch(view.state.tr.insertText(ch));
}

function merge(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
}

describe('anchoredEdit', () => {
  it('places an ambiguous insertion so that it ends at the cursor', () => {
    // "q" typed in front of "queries": prefix-first puts it behind the existing q
    expect(anchoredEdit('and queries', 'and qqueries', 5)).toEqual({ index: 4, remove: 0, insert: 'q' });
    expect(anchoredEdit('aaa', 'aaaa', 1)).toEqual({ index: 0, remove: 0, insert: 'a' });
  });
  it('places an ambiguous deletion at the cursor', () => {
    expect(anchoredEdit('aaab', 'aab', 0)).toEqual({ index: 0, remove: 1, insert: '' });
  });
  it('leaves unambiguous changes, replacements and the prefix-first placement to y-prosemirror', () => {
    expect(anchoredEdit('abc', 'abxc', 3)).toBeNull();
    expect(anchoredEdit('and queries', 'and qqueries', 6)).toBeNull();
    expect(anchoredEdit('abc', 'axc', 2)).toBeNull();
    expect(anchoredEdit('abc', 'abc', 1)).toBeNull();
  });
  it('never splits a surrogate pair', () => {
    expect(anchoredEdit('😀😀', '😀😀😀', 3)).toBeNull();
    expect(anchoredEdit('😀', '😀😀', 2)).toEqual({ index: 0, remove: 0, insert: '😀' });
  });
});

describe('typing at the same place on two clients that meet later', () => {
  const words = (s: string) => s.split(/\s+/).filter(Boolean);

  it('keeps each typed word whole (a word typed before an equal letter)', () => {
    const state = baseState({ type: 'doc', content: [par(text('all of the keys, values and queries come from the same place.'))] });
    const c1 = client(state, 100), c2 = client(state, 200);
    typeBefore(c1.view, 'queries', 'Zc1offq0008Z ');
    typeBefore(c2.view, 'queries', 'Zc2onq0007Z ');
    merge(c1.ydoc, c2.ydoc);
    const t1 = c1.view.state.doc.textContent, t2 = c2.view.state.doc.textContent;
    expect(t1).toBe(t2);
    expect(words(t1)).toContain('Zc1offq0008Z');
    expect(words(t1)).toContain('Zc2onq0007Z');
    expect(t1).toMatch(/values and (Zc1offq0008Z Zc2onq0007Z|Zc2onq0007Z Zc1offq0008Z) queries/);
  });

  it('also inside formatted text, next to a formula and in a list item', () => {
    const state = baseState({ type: 'doc', content: [
      par(text('Divide each by '), math('\\sqrt{d_k}'), text(' and apply '), text('softmax', [{ type: 'emph', attrs: { value: 'on' } }]), text(' sums.')),
      { type: 'paragraph', attrs: { layout: 'Itemize' }, content: [text('keys, values and queries')] },
    ] });
    const c1 = client(state, 100), c2 = client(state, 200);
    // the letter after the cursor typed in the middle of a word: the case the prefix-first diff got wrong
    typeBefore(c1.view, 'and apply', 'Xa1 ');
    typeBefore(c2.view, 'and apply', 'Ya2 ');
    typeBefore(c1.view, 'softmax', 'Ks1 ');
    typeBefore(c2.view, 'softmax', 'Ms2 ');
    typeBefore(c1.view, 'queries', 'Pq1 ');
    typeBefore(c2.view, 'queries', 'Rq2 ');
    merge(c1.ydoc, c2.ydoc);
    const t = c1.view.state.doc.textContent;
    expect(c2.view.state.doc.textContent).toBe(t);
    for (const w of ['Xa1', 'Ya2', 'Ks1', 'Ms2', 'Pq1', 'Rq2']) expect(words(t)).toContain(w);
    // the formatting of the run typed into is kept
    let emph = '';
    c1.view.state.doc.descendants(n => { if (n.isText && n.marks.some(m => m.type.name === 'emph')) emph += n.text; });
    expect(emph).toContain('softmax');
  });

  it('a deletion beside equal letters removes what was deleted, and the text stays in sync with Yjs', () => {
    const state = baseState({ type: 'doc', content: [par(text('aaab'))] });
    const c = client(state, 100);
    c.view.dispatch(c.view.state.tr.setSelection(TextSelection.create(c.view.state.doc, 2)));
    c.view.dispatch(c.view.state.tr.delete(1, 2));
    expect(c.view.state.doc.textContent).toBe('aab');
    // the first "a" went (not the third): a concurrent insertion after it on another client stays at the start
    const other = client(state, 200);
    other.view.dispatch(other.view.state.tr.insertText('X', 2));
    merge(c.ydoc, other.ydoc);
    expect(c.view.state.doc.textContent).toBe('Xaab');
    expect(other.view.state.doc.textContent).toBe('Xaab');
  });
});

describe('Enter in the middle of a paragraph while somebody else edits it', () => {
  const ENCODER = [text('The encoder is composed of a stack of '), math('N=6'), text(' identical layers. Each layer has two sub-layers: a multi-head self-attention mechanism. That is, the output is '), math('\\mathrm{LayerNorm}(x)'), text(', where '), math('f(x)'), text(' is the function.')];
  const pars = (v: EditorView) => { const out: string[] = []; v.state.doc.forEach(p => out.push(p.textContent)); return out; };
  /** Enter right before the first occurrence of `needle` */
  const enterBefore = (view: EditorView, needle: string) => {
    let at = -1;
    view.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text!.includes(needle)) at = pos + n.text!.indexOf(needle); });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    splitBlock(view.state, view.dispatch);
  };

  it('text typed offline into the first half survives the other side\'s split (formulas in the paragraph)', () => {
    const state = baseState({ type: 'doc', content: [par(...ENCODER), par(text('Next paragraph.'))] });
    const online = client(state, 200), offline = client(state, 100);
    typeBefore(online.view, 'multi-head', 'Zon ');
    enterBefore(online.view, 'multi-head');
    typeBefore(offline.view, 'identical layers', 'OFFLINE ');
    typeBefore(offline.view, 'multi-head', 'Zoff ');
    merge(online.ydoc, offline.ydoc);
    const t = pars(online.view);
    expect(pars(offline.view)).toEqual(t);
    expect(t.join('\n')).toContain('OFFLINE identical layers');
    expect(t.join('\n')).toContain('Zoff');
    expect(t[1]).toMatch(/^multi-head self-attention mechanism/);
    // nothing doubled
    expect(t.join('\n').match(/The encoder is composed/g)).toHaveLength(1);
    expect(t.join('\n').match(/multi-head/g)).toHaveLength(1);
  });

  it('two people splitting the same paragraph: no half appears twice except the part after both split points', () => {
    const state = baseState({ type: 'doc', content: [par(...ENCODER)] });
    const c1 = client(state, 100), c2 = client(state, 200);
    enterBefore(c1.view, 'multi-head');
    enterBefore(c2.view, 'That is');
    merge(c1.ydoc, c2.ydoc);
    const t = pars(c1.view).join('\n');
    expect(pars(c2.view).join('\n')).toBe(t);
    expect(t.match(/The encoder is composed/g)).toHaveLength(1);
    expect(t.match(/multi-head/g)).toHaveLength(1);   // between the two split points: once
  });

  it('a split inside a list item keeps its layout; text typed meanwhile after the split point ends the first half', () => {
    const state = baseState({ type: 'doc', content: [{ type: 'paragraph', attrs: { layout: 'Itemize' }, content: [text('keys, values and queries come from the same place.')] }] });
    const c1 = client(state, 100), c2 = client(state, 200);
    enterBefore(c1.view, 'queries');
    typeBefore(c2.view, 'same place', 'very ');
    merge(c1.ydoc, c2.ydoc);
    // Yjs cannot move text: the second half is a copy, so what was typed into it meanwhile stays where its characters were
    expect(pars(c1.view)).toEqual(['keys, values and very ', 'queries come from the same place.']);
    expect(pars(c2.view)).toEqual(pars(c1.view));
    c1.view.state.doc.forEach(p => expect(p.attrs.layout).toBe('Itemize'));
  });
});
