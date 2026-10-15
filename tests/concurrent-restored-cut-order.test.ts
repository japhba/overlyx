// @vitest-environment happy-dom
import { it, expect } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math } from './yjs-net';

const words = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(6) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
  par(text(words(10, 20) + ' ')),
  par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
] };
const clean = (paragraphs: string[]) => paragraphs.map(paragraph => paragraph.replace(/\s+/g, ' ').trim());

for (const pendingMoves of [false, true]) it(`offline consecutive cuts retain a later typing gap and deleted boundary endpoint (pending ${pendingMoves})`, () => {
  const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  const act = (run: () => void) => { run(); for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc))); };
  try {
    // Exact ten-action minimum of captured1002. Joining removes the w019/w020
    // and w029/w030 boundaries; the other four authored cuts remain distinct.
    act(() => a.joinAt('w020'));
    act(() => a.enterBefore('w014'));
    act(() => net.flush());
    act(() => net.offline(c));
    act(() => c.enterBefore('w021'));
    act(() => c.joinAt('w030'));
    act(() => { const at = a.find('w024'); a.select(at, at + 5); a.view.dispatch(a.view.state.tr.deleteSelection()); });
    act(() => c.enterBefore('w025'));
    expect(clean(c.pars()).slice(1)).toEqual([
      `w014 $c$ ${words(6, 15)}`, words(4, 21),
      `${words(9, 25)} $x^2$ ${words(4, 34)}`,
    ]);
    act(() => b.typeBefore('w019', 'Tb3 '));
    act(() => b.enterBefore('Tb3'));
    expect(clean(b.pars())[1]).toBe(`w014 $c$ ${words(4, 15)}`);
    expect(clean(b.pars())[2]).toMatch(/^Tb3 w019 w020 /);
    net.online(c);
    const final = net.converged(), tokens = final.join(' ').split(/[\s$]+/);
    expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).filter(word => word !== 'w024'));
    expect(tokens.filter(word => word === 'Tb3')).toHaveLength(1);
    expect(tokens.slice(tokens.indexOf('w018'), tokens.indexOf('w018') + 4)).toEqual(['w018', 'Tb3', 'w019', 'w020']);
    for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    expect(clean(final)).toEqual([
      `${words(6)} $a+b$ ${words(7, 7)}`,
      `w014 $c$ ${words(4, 15)}`,
      'Tb3 w019 w020', words(3, 21),
      `${words(9, 25)} $x^2$ ${words(4, 34)}`,
    ]);
  } finally {
    for (const peer of net.peers) { peer.remoteUpdates?.destroy(); peer.pendingMoves?.destroy(); peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

for (const pendingMoves of [false, true]) it(`a collected typed insertion keeps its gap when a stale temporary cut is rejoined (pending ${pendingMoves})`, () => {
  const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  const act = (run: () => void) => { run(); for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc))); };
  try {
    // Exact five-action minimum of stored1032. B explicitly removes its own
    // temporary w026 cut; A's independent w028 cut survives.
    act(() => b.enterBefore('w026'));
    expect(clean(b.pars()).slice(1, 3)).toEqual([words(6, 20), words(4, 26)]);
    act(() => b.joinAt('w026'));
    expect(clean(b.pars())[1]).toBe(words(10, 20));
    act(() => net.offline(a));
    act(() => a.typeBefore('w026', 'Ta1 '));
    act(() => a.enterBefore('w028'));
    expect(clean(a.pars()).slice(1, 3)).toEqual([`${words(6, 20)} Ta1 ${words(2, 26)}`, words(2, 28)]);
    net.online(a);
    const final = net.converged(), tokens = final.join(' ').split(/[\s$]+/);
    expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
    expect(tokens.filter(word => word === 'Ta1')).toHaveLength(1);
    expect(tokens.slice(tokens.indexOf('w025'), tokens.indexOf('w025') + 3)).toEqual(['w025', 'Ta1', 'w026']);
    for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    expect(clean(final)).toEqual([
      `${words(6)} $a+b$ ${words(8, 7)} $c$ ${words(5, 15)}`,
      `${words(6, 20)} Ta1 ${words(2, 26)}`, words(2, 28),
      `${words(4, 30)} $x^2$ ${words(4, 34)}`,
    ]);
  } finally {
    for (const peer of [a, b, c]) { peer.remoteUpdates?.destroy(); peer.pendingMoves?.destroy(); peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});
