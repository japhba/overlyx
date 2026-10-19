// @vitest-environment happy-dom
/**
 * The server's repair of moves (server/moves.ts) exists for edits made concurrently with a paragraph
 * split or join. Edits nobody made concurrently are none of its business: when every update reaches
 * everybody before the next edit is made, the server's document after each step must be exactly the
 * editor's own.
 *
 * 18–19 Oct 2026 it was not. In cosyne_27/main.tex the repair moved established text it took for late
 * edits while one person was editing alone: inserting a comment moved "$\lambda\propto y^2$ stays below
 * a critical $\lambda_*$, although … (Fig." into the middle of the paragraph above; an Enter moved two
 * formulas and "The RNN uses one" into a section heading; "levels $\ell-1$ and $\ell$" became
 * "$\ell$ and $\ell-1$". Its test for a late edit read Yjs insertion origins, which in a document
 * with a long history point at runs some earlier split had moved.
 *
 * Several editors take turns here (random typing, Enter, Backspace joins, formulas, quotes, comment
 * threads, bold, deletions within and across paragraphs, formula edits, undo, server restarts), so the
 * document collects the kind of history that misled the repair. Any change the repair makes fails, and
 * so does an editor that shows something else than its own Yjs document holds.
 *
 * OVERLYX_SEQ_SEEDS / OVERLYX_SEQ_STEPS make it bigger. Known limit in long runs (about 1 in 100 seeds
 * of 150 steps, with or without the repair): Ctrl+Z of an Enter whose paragraph somebody else joined
 * back restores the copied half a second time (y-prosemirror splits by copying; undo brings back the
 * originals) — once even everything.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { TextSelection } from 'prosemirror-state';
import { splitBlock, joinBackward } from 'prosemirror-commands';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { Net, par, text, math, emph, parsOf, type Json, type Peer } from './yjs-net';

const STEPS = Number(process.env.OVERLYX_SEQ_STEPS ?? 70);
const SEEDS = Number(process.env.OVERLYX_SEQ_SEEDS ?? 12);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const quote = (kind: string): Json => ({ type: 'quotes', attrs: { kind } });
const start = (): Json => ({
  type: 'doc', content: [
    par(text('First, we consider the effect of weight sharing. We define networks through the iteration '), math('h^t=W\\phi(h^{t-1})'), text(' and read out '), math('f=V\\phi(h)'), text('. The RNN uses one '), math('W'), text(' at every step.')),
    par(text('A transition in the learning signal.', [{ type: 'series', attrs: { value: 'bold' } }]), text(' The kernels coincide as long as the signal strength '), math('\\lambda\\propto y^2'), text(' stays below a critical '), math('\\lambda_*'), text(', although both differ from the lazy kernel (Fig. B). Above it only the RNN becomes coherent.')),
    par(text('Learners see '), quote('eld'), text('practice'), quote('erd'), text(' and '), text('generate', emph), text(' tasks; the response follows the change between levels '), math('\\ell-1'), text(' and '), math('\\ell'), text('.')),
    par(text('Discussion: a constraint that matches the data trades expressivity for sample efficiency.')),
  ],
});

const WORDS = ['alpha ', 'beta', ' gamma', 'x', ', ', 'delta epsilon ', '.', 'kernel '];

/** text positions of every textblock, with the textblock's start, size and depth */
function blocks(doc: PMNode): { pos: number; node: PMNode }[] {
  const out: { pos: number; node: PMNode }[] = [];
  doc.descendants((n, pos) => { if (n.isTextblock) out.push({ pos, node: n }); });
  return out;
}
/** a position inside a random textblock (between its inline children) */
function somewhere(r: () => number, doc: PMNode, topOnly = false): number {
  const bs = blocks(doc).filter(b => !topOnly || doc.resolve(b.pos + 1).depth === 1);
  const b = bs[Math.floor(r() * bs.length)];
  return b.pos + 1 + Math.floor(r() * (b.node.content.size + 1));
}

/**
 * The document as JSON, for comparison. ProseMirror marks on inline nodes (a formula inside a bold
 * range) are left out: they are not stored by design — such a node keeps its font in its `marks`
 * attribute (core/schema.ts), which the editor's own commands set.
 */
function shape(doc: PMNode): string {
  const strip = (j: any) => {
    if (j.type !== 'text') delete j.marks;
    for (const c of j.content ?? []) strip(c);
    return j;
  };
  return JSON.stringify(strip(doc.toJSON()));
}
/** paragraphs with the text of insets inside them, for messages */
function readable(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach(p => out.push(p.textBetween(0, p.content.size, ' ¶ ', n => n.type.name === 'math_inline' ? `$${n.attrs.latex}$` : `<${n.type.name}>`)));
  return out;
}

type Op = (a: Peer, r: () => number, um: Y.UndoManager) => string | null;
const ops: [number, Op][] = [
  [6, (a, r) => { const w = WORDS[Math.floor(r() * WORDS.length)]; const at = somewhere(r, a.view.state.doc); a.type(w, at); return `type ${JSON.stringify(w)} @${at}`; }],
  [3, (a, r) => { const at = somewhere(r, a.view.state.doc); a.select(at); return splitBlock(a.view.state, a.view.dispatch) ? `enter @${at}` : null; }],
  [3, (a, r) => {
    const tops: number[] = [];
    a.view.state.doc.forEach((_n, off, i) => { if (i > 0) tops.push(off + 1); });
    if (!tops.length) return null;
    const at = tops[Math.floor(r() * tops.length)];
    a.select(at);
    return joinBackward(a.view.state, a.view.dispatch) ? `join @${at}` : null;
  }],
  [2, (a, r) => { const at = somewhere(r, a.view.state.doc); a.select(at); a.view.dispatch(a.view.state.tr.replaceSelectionWith(schema.nodes.math_inline.create({ latex: 'z_' + Math.floor(r() * 9) }), false)); return `formula @${at}`; }],
  [1, (a, r) => { const at = somewhere(r, a.view.state.doc); a.select(at); a.view.dispatch(a.view.state.tr.replaceSelectionWith(schema.nodes.quotes.create({ kind: r() < 0.5 ? 'eld' : 'erd' }), false)); return `quote @${at}`; }],
  [2, (a, r) => {
    // a comment thread at a point in the text (commands.ts insertComment), then its message typed
    const at = somewhere(r, a.view.state.doc, true);
    const header = schema.nodes.paragraph.create({ layout: 'Plain Layout' }, schema.text('Someone (2026-10-18 08:43):'));
    const node = schema.nodes.inset.create({ name: 'Note', arg: 'Comment', params: '[]', status: 'open' }, Fragment.from([header, schema.nodes.paragraph.create({ layout: 'Plain Layout' })]));
    a.select(at);
    const tr = a.view.state.tr.replaceSelectionWith(node, false);
    const body = tr.mapping.map(at, -1) + 1 + header.nodeSize + 1;
    a.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(body, tr.doc.content.size)))));
    a.type('I would add a citation here');
    return `comment @${at}`;
  }],
  [1, (a, r) => {
    const doc = a.view.state.doc, bs = blocks(doc).filter(b => b.node.content.size > 2), b = bs[Math.floor(r() * bs.length)];
    if (!b) return null;
    const from = b.pos + 1 + Math.floor(r() * b.node.content.size), to = Math.min(b.pos + 1 + b.node.content.size, from + 1 + Math.floor(r() * 12));
    a.view.dispatch(a.view.state.tr.addMark(from, to, schema.marks.series.create({ value: 'bold' })));
    return `bold ${from}-${to}`;
  }],
  [3, (a, r) => {
    const doc = a.view.state.doc, bs = blocks(doc).filter(b => b.node.content.size > 1), b = bs[Math.floor(r() * bs.length)];
    if (!b) return null;
    const from = b.pos + 1 + Math.floor(r() * b.node.content.size), to = Math.min(b.pos + 1 + b.node.content.size, from + 1 + Math.floor(r() * 8));
    a.view.dispatch(a.view.state.tr.delete(from, to));
    return `delete ${from}-${to}`;
  }],
  [1, (a, r) => {
    // a selection from one top-level paragraph into the next, deleted (the two are joined)
    const doc = a.view.state.doc;
    if (doc.childCount < 2) return null;
    const i = Math.floor(r() * (doc.childCount - 1));
    let off = 0;
    for (let k = 0; k < i; k++) off += doc.child(k).nodeSize;
    const p = doc.child(i), q = doc.child(i + 1);
    const from = off + 1 + Math.floor(r() * (p.content.size + 1)), to = off + p.nodeSize + 1 + Math.floor(r() * (q.content.size + 1));
    a.view.dispatch(a.view.state.tr.delete(from, to));
    return `delete across ${from}-${to}`;
  }],
  [1, (a, r) => {
    const at: number[] = [];
    a.view.state.doc.descendants((n, pos) => { if (n.type.name === 'math_inline') at.push(pos); });
    if (!at.length) return null;
    const pos = at[Math.floor(r() * at.length)], node = a.view.state.doc.nodeAt(pos)!;
    a.view.dispatch(a.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: node.attrs.latex + "'" }));
    return `formula edit @${pos}`;
  }],
  [2, (_a, _r, um) => {
    if (!um.undoStack.length) return null;
    // Yjs (13.6.32–33) can throw inside an undo whose redo chain reaches an item garbage-collected
    // after somebody else deleted it (Item.js redoItem); that is not what this test is about
    try { um.undo(); } catch (e) { return `undo (threw: ${(e as Error).message})`; }
    return 'undo';
  }],
];
const total = ops.reduce((s, [w]) => s + w, 0);
function pick(r: () => number): Op {
  let x = r() * total;
  for (const [w, op] of ops) { if ((x -= w) < 0) return op; }
  return ops[0][1];
}

/** the stretch where two renderings differ, with some context */
function differing(x: string, y: string): [string, string] {
  let l = 0; while (l < x.length && x[l] === y[l]) l++;
  let r = 0; while (r < x.length - l && r < y.length - l && x[x.length - 1 - r] === y[y.length - 1 - r]) r++;
  const around = (t: string) => `…${t.slice(Math.max(0, l - 50), t.length - r + 30)}…`;
  return [around(x), around(y)];
}
/** the readable text when that differs, else the structure */
const compared = (p: PMNode, q: PMNode): [string, string] => readable(p).join(' ‖ ') === readable(q).join(' ‖ ') ? [shape(p), shape(q)] : [readable(p).join(' ‖ '), readable(q).join(' ‖ ')];

function run(seed: number): void {
  const r = rng(seed);
  // OVERLYX_SEQ_REPAIR=0: the same edits without the server's repair (to tell its failures from the editor's)
  const repair = process.env.OVERLYX_SEQ_REPAIR !== '0';
  const net = new Net(start(), { pendingMoves: repair, repair });
  const peers = [net.peer('a', 101), net.peer('b', 202), net.peer('c', 303)];
  const ums = peers.map(p => new Y.UndoManager(p.ydoc.getXmlFragment('prosemirror'), { trackedOrigins: new Set([ySyncPluginKey]), captureTimeout: 0 }));
  const log: string[] = [];
  for (let step = 0; step < STEPS; step++) {
    if (step > 0 && step % 25 === 0) {
      // the server restarts (loaded from its persisted state); everybody reconnects
      net.restart();
      for (const p of peers) net.online(p);
      net.flush();
      log.push('restart');
    }
    const i = Math.floor(r() * peers.length), a = peers[i];
    const what = pick(r)(a, r, ums[i]);
    if (!what) continue;
    log.push(`${step} ${a.name}: ${what}`);
    const mine = a.view.state.doc;
    net.flush();
    const recent = log.slice(-8).join('\n');
    // every editor shows what its Yjs document holds (typinganchor.ts once wrote a keystroke into another
    // comment thread, and kept a stale inset that the next change from elsewhere put back on the screen)
    for (const p of peers) {
      const own = yXmlFragmentToProseMirrorRootNode(p.ydoc.getXmlFragment('prosemirror'), schema);
      if (shape(own) !== shape(p.view.state.doc)) {
        const [x, y] = differing(...compared(p.view.state.doc, own));
        expect.fail(`seed ${seed}, step ${step}: ${p.name}'s editor shows something else than its Yjs document holds\n  editor: ${x}\n  Yjs:    ${y}\n${recent}`);
      }
    }
    const server = yXmlFragmentToProseMirrorRootNode(net.server.getXmlFragment('prosemirror'), schema);
    if (shape(server) !== shape(mine)) {
      const [m, sv] = compared(mine, server), [x, y] = differing(m, sv);
      expect.fail(`seed ${seed}, step ${step}: the repair changed what ${a.name} did${m.startsWith('{') ? ' (structure only)' : ''}\n  ${a.name}:     ${x}\n  server: ${y}\n${recent}`);
    }
    for (const p of peers) expect(parsOf(p.view.state.doc), `seed ${seed}, step ${step}: ${p.name} diverged`).toEqual(parsOf(server));
  }
}

describe('edits made one after another are never changed by the repair of moves', () => {
  for (let seed = 1; seed <= SEEDS; seed++) it(`seed ${seed}`, () => run(seed), 60_000);
});
