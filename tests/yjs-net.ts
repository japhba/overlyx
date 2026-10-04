/**
 * A Yjs "network" for tests: a server Y.Doc and editors (y-prosemirror + the editor's typing anchor)
 * that talk to it the way y-websocket does — live updates while online, a sync step 1/2 exchange on
 * reconnect — with the deliveries under the test's control, so that any interleaving of edits,
 * splits and reconnects can be replayed deterministically. The server applies what it receives
 * through MoveRepair (packages/server/src/moves.ts) like ws.ts does, unless `repair: false`.
 */
import { expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { splitBlock, joinBackward } from 'prosemirror-commands';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import * as Y from 'yjs';
import { ySyncPlugin, initProseMirrorDoc, prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { schema } from '@overlyx/core';
import { typingAnchorPlugin } from '../packages/client/src/editor/plugins/typinganchor';
import { MoveRepair } from '../packages/server/src/moves';
import { decodeRecord } from '../packages/core/src/moves';

export type Json = Record<string, unknown>;
export const par = (...content: Json[]): Json => ({ type: 'paragraph', content });
export const text = (t: string, marks?: Json[]): Json => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
export const math = (latex: string): Json => ({ type: 'math_inline', attrs: { latex } });
export const emph = [{ type: 'emph', attrs: { value: 'on' } }];

/** what the network's own deliveries are tagged with (not sent back out by the editor) */
const NET = Symbol('net');

export class Peer {
  ydoc = new Y.Doc();
  view: EditorView;
  online = false;
  /** server → this peer, not delivered yet */
  inbox: Uint8Array[] = [];
  /** this peer → server, not delivered yet */
  outbox: Uint8Array[] = [];
  constructor(public net: Net, public name: string, id: number, state: Uint8Array) {
    this.ydoc.clientID = id;
    Y.applyUpdate(this.ydoc, state, NET);
    const fragment = this.ydoc.getXmlFragment('prosemirror');
    const { doc, mapping } = initProseMirrorDoc(fragment, schema);
    const plugins = [ySyncPlugin(fragment, { mapping }), typingAnchorPlugin()];
    this.view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc, plugins }) });
    this.ydoc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== NET && this.online) this.outbox.push(u); });
  }

  /** text positions: the first occurrence of `needle` in a text node (offset into it) */
  find(needle: string, nth = 0): number {
    let at = -1, seen = 0;
    this.view.state.doc.descendants((n, pos) => {
      if (at >= 0 || !n.isText) return;
      let i = n.text!.indexOf(needle);
      while (i >= 0 && seen < nth) { seen++; i = n.text!.indexOf(needle, i + 1); }
      if (i >= 0) at = pos + i;
    });
    if (at < 0) throw new Error(`${this.name}: "${needle}" not found in ${JSON.stringify(this.pars())}`);
    return at;
  }
  select(from: number, to = from) { this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, from, to))); }
  /** type `s` key by key at `pos` (or the cursor) */
  type(s: string, pos?: number) { if (pos !== undefined) this.select(pos); for (const ch of s) this.view.dispatch(this.view.state.tr.insertText(ch)); }
  typeBefore(needle: string, s: string) { this.type(s, this.find(needle)); }
  typeAfter(needle: string, s: string) { this.type(s, this.find(needle) + needle.length); }
  enter(pos?: number) { if (pos !== undefined) this.select(pos); expect(splitBlock(this.view.state, this.view.dispatch)).toBe(true); }
  enterBefore(needle: string) { this.enter(this.find(needle)); }
  /** Backspace at the start of the paragraph that begins with `needle` */
  joinAt(needle: string) { this.select(this.find(needle)); expect(joinBackward(this.view.state, this.view.dispatch)).toBe(true); }
  /** delete the first occurrence of `needle` (one step, like a selection + Backspace) */
  remove(needle: string) { const at = this.find(needle); this.view.dispatch(this.view.state.tr.delete(at, at + needle.length)); }
  /** add a mark to the first occurrence of `needle` */
  mark(needle: string, name: string, attrs: Json) { const at = this.find(needle); this.view.dispatch(this.view.state.tr.addMark(at, at + needle.length, schema.marks[name].create(attrs))); }
  /** change the LaTeX of the first inline formula whose LaTeX is `latex` */
  setFormula(latex: string, next: string) {
    let at = -1;
    this.view.state.doc.descendants((n, pos) => { if (at < 0 && n.type.name === 'math_inline' && n.attrs.latex === latex) at = pos; });
    expect(at).toBeGreaterThanOrEqual(0);
    const node = this.view.state.doc.nodeAt(at)!;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, latex: next }));
  }
  /** the paragraphs' text (formulas as $latex$) */
  pars(): string[] { return parsOf(this.view.state.doc); }
  formulas(): string[] { const out: string[] = []; this.view.state.doc.descendants(n => { if (n.type.name === 'math_inline') out.push(n.attrs.latex); }); return out; }
  /** the text that carries mark `name` */
  marked(name: string): string { let s = ''; this.view.state.doc.descendants(n => { if (n.isText && n.marks.some(m => m.type.name === name)) s += n.text; }); return s; }
}

export function parsOf(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach(p => {
    let s = '';
    p.forEach(n => { s += n.isText ? n.text : n.type.name === 'math_inline' ? `$${n.attrs.latex}$` : `<${n.type.name}>`; });
    out.push(s);
  });
  return out;
}

export class Net {
  server = new Y.Doc();
  repair: MoveRepair | null;
  peers: Peer[] = [];
  /** the state vector each peer reported in its last sync step 1 */
  knows = new Map<Peer, Map<number, number>>();

  constructor(doc: Json, opts: { repair?: boolean } = {}) {
    this.server.clientID = 1;
    prosemirrorJSONToYXmlFragment(schema, doc, this.server.getXmlFragment('prosemirror'));
    this.repair = opts.repair === false ? null : new MoveRepair(this.server, { log: process.env.OVERLYX_MOVES_DEBUG ? (...a) => console.log(...a) : undefined });
    this.server.on('update', (u: Uint8Array) => { for (const p of this.peers) if (p.online) p.inbox.push(u); });
  }

  /**
   * The server restarts: its document is loaded from the persisted state (as docs.ts does, origin
   * 'db'), garbage collection included; every peer loses its connection.
   */
  restart(): void {
    for (const p of this.peers) if (p.online) this.offline(p);
    const state = Y.encodeStateAsUpdate(this.server);
    this.server = new Y.Doc();
    this.server.clientID = 2;
    this.repair = this.repair ? new MoveRepair(this.server) : null;
    Y.applyUpdate(this.server, state, 'db');
    this.server.on('update', (u: Uint8Array) => { for (const p of this.peers) if (p.online) p.inbox.push(u); });
  }

  /** a peer that has the server's current state (and is online unless said otherwise) */
  peer(name: string, id: number, online = true): Peer {
    const p = new Peer(this, name, id, Y.encodeStateAsUpdate(this.server));
    this.peers.push(p);
    p.online = online;
    return p;
  }

  private toServer(p: Peer, u: Uint8Array, step2: boolean) {
    if (this.repair) this.repair.receive(u, p, { step2, knows: step2 ? this.knows.get(p) ?? null : null });
    else Y.applyUpdate(this.server, u, p);
  }

  /** deliver one peer's queued updates to the server */
  send(p: Peer) { const out = p.outbox; p.outbox = []; for (const u of out) this.toServer(p, u, false); }
  /** deliver what the server sent to one peer */
  receive(p: Peer) { const inb = p.inbox; p.inbox = []; for (const u of inb) Y.applyUpdate(p.ydoc, u, NET); }

  /** deliver everything until nothing is in flight */
  flush() {
    for (let round = 0; round < 50; round++) {
      if (!this.peers.some(p => p.inbox.length || p.outbox.length)) return;
      for (const p of this.peers) this.send(p);
      for (const p of this.peers) this.receive(p);
    }
    throw new Error('the network does not settle');
  }

  offline(p: Peer) { this.send(p); p.online = false; p.inbox = []; }

  /**
   * Reconnect: the peer's sync step 1 (its state vector) reaches the server, then — in the order
   * asked — the peer's step 2 (what the server lacks) and the server's step 2 (what the peer lacks).
   */
  online(p: Peer, order: 'peer-first' | 'server-first' = 'peer-first') {
    const peerSV = Y.encodeStateVector(p.ydoc), serverSV = Y.encodeStateVector(this.server);
    const known = Y.decodeStateVector(peerSV);
    this.knows.set(p, known);
    const fromPeer = Y.encodeStateAsUpdate(p.ydoc, serverSV);
    p.online = true;
    // like ws.ts: a peer with edits the server has not seen gets the server's step 2 once its own is applied
    const news = [...known].some(([client, clock]) => clock > Y.getState(this.server.store, client));
    if (news || !this.repair) {
      if (news) { this.toServer(p, fromPeer, true); Y.applyUpdate(p.ydoc, Y.encodeStateAsUpdate(this.server, peerSV), NET); return; }
    }
    const fromServer = Y.encodeStateAsUpdate(this.server, peerSV);
    if (order === 'peer-first') { this.toServer(p, fromPeer, true); Y.applyUpdate(p.ydoc, fromServer, NET); }
    else { Y.applyUpdate(p.ydoc, fromServer, NET); this.toServer(p, fromPeer, true); }
  }

  /** every online peer and the server show the same document; returns its paragraphs */
  converged(): string[] {
    this.flush();
    const serverDoc = yXmlFragmentToProseMirrorRootNode(this.server.getXmlFragment('prosemirror'), schema);
    const expected = parsOf(serverDoc);
    for (const p of this.peers) if (p.online) expect(p.pars(), p.name).toEqual(expected);
    return expected;
  }
}

/** `s` occurs exactly once in `t` */
export const once = (t: string | string[], s: string) => {
  const all = Array.isArray(t) ? t.join('\n') : t;
  expect(all.split(s).length - 1, `"${s}" in ${JSON.stringify(t)}`).toBe(1);
};
export const absent = (t: string | string[], s: string) => {
  const all = Array.isArray(t) ? t.join('\n') : t;
  expect(all.includes(s), `"${s}" in ${JSON.stringify(t)}`).toBe(false);
};

/** the Yjs structure of a document, for debugging */
export function dumpDoc(d: Y.Doc): void {
  const out: string[] = [];
  const walk = (t: Y.AbstractType<any>, ind: string) => {
    for (let it = t._start; it; it = it.right) {
      const c: any = it.content;
      const id = `${it.id.client}:${it.id.clock}`;
      const o = it.origin ? `${it.origin.client}:${it.origin.clock}` : '-';
      const ro = it.rightOrigin ? `${it.rightOrigin.client}:${it.rightOrigin.clock}` : '-';
      const del = it.deleted ? 'X' : ' ';
      if (c instanceof Y.ContentType) { out.push(`${ind}${del} ${id} <${(c.type as any).nodeName ?? 'text'}> o=${o} ro=${ro}`); walk(c.type, ind + '  '); }
      else if (c instanceof Y.ContentString) out.push(`${ind}${del} ${id} "${c.str}" o=${o} ro=${ro}`);
      else if (c instanceof Y.ContentFormat) out.push(`${ind}${del} ${id} fmt ${c.key}=${JSON.stringify(c.value)}`);
      else out.push(`${ind}${del} ${id} ${c.constructor.name} len=${it.length}`);
    }
  };
  walk(d.getXmlFragment('prosemirror'), '');
  console.log(out.join('\n'));
  const m = d.getMap('moves');
  for (const k of m.keys()) { const r = decodeRecord(k, m.get(k)); console.log(k, r ? `protect ${r.protect.map(p => p.client + ':' + p.clock).join(',')} adopt ${r.adopt.join(',')}\n   ${r.entries.join(' ')}` : '?'); }
}
