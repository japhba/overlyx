// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { Net, Peer, par, text, math } from './yjs-net';

const words = (n: number, from: number) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(6, 1) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
  par(text(words(10, 20) + ' ')),
  par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
] };

it('receiving a concurrent split while a join is in flight keeps the optimistic view in source order', () => {
  const net = new Net(content, { pendingMoves: true }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  const act = (fn: () => void) => { fn(); for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc))); };
  try {
    act(() => b.joinAt('w020'));
    const before = b.pars().join(' ');
    expect(before.indexOf('w013')).toBeLessThan(before.indexOf('w029'));
    act(() => c.enterBefore('w013'));
    act(() => net.offline(c));
    act(() => net.receive(b));
    expect(b.pendingMoves?.waiting).toBe(true);
    expect(b.pars().join(' ')).toBe(before);
    act(() => b.typeBefore('w018', 'Tb1 '));
    const pending = b.pars().join(' '), tokens = pending.split(/[\s$]+/);
    const final = net.converged().join(' '), finalTokens = final.split(/[\s$]+/);
    for (let i = 1; i <= 37; i++) expect(finalTokens.filter(token => token === `w${String(i).padStart(3, '0')}`)).toHaveLength(1);
    expect(final.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
    // These anchors are unique even while other concurrent copies are pending.
    expect(tokens.filter(token => token === 'w013')).toHaveLength(1);
    expect(tokens.filter(token => token === 'w029')).toHaveLength(1);
    expect(final.indexOf('w013')).toBeLessThan(final.indexOf('w029'));
    expect(pending.indexOf('w013')).toBeLessThan(pending.indexOf('w029'));
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

it('a raw echo cannot release a local join before its canonical repair arrives', () => {
  const net = new Net(content, { pendingMoves: true }), b = net.peer('b', 200), c = net.peer('c', 300);
  try {
    b.joinAt('w020');
    c.enterBefore('w013'); net.offline(c); net.receive(b);
    b.typeBefore('w018', 'Tb1 ');
    const local = b.pars();
    net.send(b);
    const packets = b.inbox.splice(0);
    expect(packets.length).toBeGreaterThan(1);
    b.inbox.push(packets[0]); net.receive(b);
    expect(b.pendingMoves?.waiting).toBe(true);
    expect(b.pars()).toEqual(local);
    b.inbox.push(...packets.slice(1)); net.receive(b);
    expect(b.pendingMoves?.waiting).toBe(false);
    const final = net.converged().join(' ');
    expect(final).toContain('w017 Tb1 w018');
    expect(final.indexOf('w013')).toBeLessThan(final.indexOf('w029'));
    expect(final.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

it('undoing a pending join stays responsive and retains the coauthor split after acknowledgment', () => {
  const net = new Net(content, { pendingMoves: true }), b = net.peer('b', 200), c = net.peer('c', 300);
  const undo = new Y.UndoManager(b.ydoc.getXmlFragment('prosemirror'), { trackedOrigins: new Set([ySyncPluginKey]) });
  try {
    const original = b.pars();
    b.joinAt('w020');
    c.enterBefore('w013'); net.offline(c); net.receive(b);
    undo.undo();
    expect(b.pars()).toEqual(original);
    const final = net.converged();
    expect(b.pendingMoves?.waiting).toBe(false);
    expect(final).toHaveLength(4);
    expect(final[0]).toContain('w012'); expect(final[0]).not.toContain('w013');
    expect(final[1]).toMatch(/^w013/);
    expect(final[2]).toMatch(/^w020/);
    expect(final[3]).toMatch(/^w030/);
    for (let i = 1; i <= 37; i++) expect(final.join(' ').split(/[\s$]+/).filter(token => token === `w${String(i).padStart(3, '0')}`)).toHaveLength(1);
  } finally {
    undo.destroy();
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

it('reloading a local draft under a new client ID acknowledges its previous client move', () => {
  const net = new Net(content, { pendingMoves: true }), b = net.peer('b', 200), c = net.peer('c', 300);
  try {
    b.joinAt('w020'); b.typeBefore('w018', 'DRAFT ');
    // The browser closes before its outbox is sent; IndexedDB holds these bytes.
    const cached = Y.encodeStateAsUpdate(b.ydoc);
    b.online = false; b.outbox = []; b.inbox = [];
    c.enterBefore('w013'); net.flush();
    const reopened = new Peer(net, 'reopened', 400, cached); net.peers.push(reopened);
    expect(reopened.pendingMoves?.waiting).toBe(true);
    net.online(reopened, 'server-first');
    const final = net.converged().join(' ');
    expect(reopened.pendingMoves?.waiting).toBe(false);
    expect(final).toContain('w017 DRAFT w018');
    for (let i = 1; i <= 37; i++) expect(final.split(/[\s$]+/).filter(token => token === `w${String(i).padStart(3, '0')}`)).toHaveLength(1);
    expect(final.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});
