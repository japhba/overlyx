// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math } from './yjs-net';

const words = (n: number, from: number) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(6, 1) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
  par(text(words(10, 20) + ' ')),
  par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
] };
const act = (net: Net, fn: () => void) => { fn(); for (const p of net.peers) p.view.dispatch(p.view.state.tr.setSelection(TextSelection.atStart(p.view.state.doc))); };

it('a new paragraph before the next original paragraph follows a concurrent split of the previous paragraph', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  act(net, () => net.offline(a));
  act(net, () => c.enterBefore('w025'));
  act(net, () => a.typeBefore('w030', 'Ta3 '));
  act(net, () => a.enterBefore('w030'));
  net.online(a);
  const final = net.converged().join(' ');
  expect(final.indexOf('w029')).toBeLessThan(final.indexOf('Ta3'));
  expect(final.indexOf('Ta3')).toBeLessThan(final.indexOf('w030'));
  const got = final.split(/[\s$]+/);
  for (let i = 1; i <= 37; i++) expect(got.filter(w => w === `w${String(i).padStart(3, '0')}`)).toHaveLength(1);
  expect(got.filter(w => w === 'Ta3')).toHaveLength(1);
  for (const p of [a, b, c]) { p.view.destroy(); p.ydoc.destroy(); }
  net.server.destroy();
});

it('typing and splitting before a copied word keeps that order after an earlier empty paragraph insertion', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.enterBefore('w030'));
  act(net, () => b.enterBefore('w028'));
  act(net, () => net.offline(b));
  act(net, () => net.flush());
  act(net, () => a.typeBefore('w028', 'Ta2 '));
  act(net, () => a.enterBefore('w028'));
  net.online(b);
  const final = net.converged().join(' ');
  expect(final.indexOf('w027')).toBeLessThan(final.indexOf('Ta2'));
  expect(final.indexOf('Ta2')).toBeLessThan(final.indexOf('w028'));
  const got = final.split(/[\s$]+/);
  for (let i = 1; i <= 37; i++) expect(got.filter(w => w === `w${String(i).padStart(3, '0')}`)).toHaveLength(1);
  expect(got.filter(w => w === 'Ta2')).toHaveLength(1);
  for (const p of [a, b]) { p.view.destroy(); p.ydoc.destroy(); }
  net.server.destroy();
});

it('a stale offline split of a joined paragraph stays before its concurrent later tail on reconnect', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  try {
    act(net, () => b.joinAt('w030'));
    act(net, () => net.offline(a));
    act(net, () => a.enterBefore('w033'));
    act(net, () => net.offline(b));
    net.online(a, 'server-first');
    act(net, () => b.enterBefore('w030'));
    act(net, () => a.enterBefore('w037'));
    net.online(b);
    const final = net.converged().join(' ');
    expect(final.split(/[\s$]+/).filter(word => /^w\d{3}$/.test(word)))
      .toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
    for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
      expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
    }
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

it('a stale joined suffix follows its prefix when a moved left anchor passes its deleted right anchor', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  try {
    act(net, () => a.enterBefore('w015'));
    act(net, () => net.flush());
    act(net, () => b.enterBefore('w030'));
    act(net, () => net.offline(a));
    act(net, () => b.joinAt('w015'));
    act(net, () => b.joinAt('w020'));
    act(net, () => a.joinAt('w015'));
    act(net, () => net.offline(b));
    act(net, () => b.enterBefore('w025'));
    for (const peer of net.peers) if (!peer.online) net.online(peer);
    const final = net.converged().join(' ');
    expect(final.split(/[\s$]+/).filter(word => /^w\d{3}$/.test(word)))
      .toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
    for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
      expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
    }
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

function completeOrder(net: Net, inserted: string): void {
  for (const peer of net.peers) if (!peer.online) net.online(peer);
  const final = net.converged().join(' '), tokens = final.split(/[\s$]+/);
  expect(tokens.filter(word => /^w\d{3}$/.test(word)))
    .toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
  expect(tokens.filter(word => word === inserted)).toHaveLength(1);
  expect(tokens.slice(tokens.indexOf('w020'), tokens.indexOf('w020') + 3)).toEqual(['w020', inserted, 'w021']);
  for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
  for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
    expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
    expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
  }
}

it('batched root splits still follow source order after competing joins change their copied text', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  try {
    act(net, () => a.joinAt('w030'));
    act(net, () => a.joinAt('w020'));
    act(net, () => net.flush());
    act(net, () => net.offline(b));
    act(net, () => b.typeBefore('w021', 'Tb2 '));
    act(net, () => b.enterBefore('Tb2'));
    act(net, () => a.enterBefore('w032'));
    act(net, () => a.enterBefore('w024'));
    act(net, () => a.joinAt('w024'));
    act(net, () => b.enterBefore('w021'));
    act(net, () => net.offline(a));
    completeOrder(net, 'Tb2');
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

it('an offline typed paragraph stays between its word anchors through a concurrent join', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  try {
    act(net, () => a.joinAt('w030'));
    act(net, () => net.offline(b));
    act(net, () => b.typeBefore('w021', 'Tb2 '));
    act(net, () => b.enterBefore('Tb2'));
    act(net, () => b.enterBefore('w021'));
    completeOrder(net, 'Tb2');
    expect(net.converged().map(paragraph => paragraph.replace(/\s+/g, ' ').trim())).toEqual([
      `${words(6, 1)} $a+b$ ${words(8, 7)} $c$ ${words(5, 15)}`,
      'w020',
      'Tb2',
      `${words(13, 21)} $x^2$ ${words(4, 34)}`,
    ]);
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

for (const pendingMoves of [false, true]) it(`a moved live bound does not reverse a joined formula and its later paragraph (pending ${pendingMoves})`, () => {
  const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  try {
    // Exact captured seed1016 minimum in both client models.
    act(net, () => b.typeBefore('w005', 'Tb2 '));
    act(net, () => net.flush());
    act(net, () => c.enterBefore('w029'));
    act(net, () => a.joinAt('w020'));
    act(net, () => net.offline(c));
    act(net, () => c.enterBefore('w011'));
    act(net, () => net.offline(b));
    act(net, () => b.joinAt('w020'));
    act(net, () => net.flush());
    act(net, () => c.enterBefore('Tb2'));
    act(net, () => a.enterBefore('w011'));
    act(net, () => net.online(c));
    act(net, () => { const at = b.find('w009'); b.select(at, at + 5); b.view.dispatch(b.view.state.tr.deleteSelection()); });
    act(net, () => b.joinAt('w030'));
    for (const peer of net.peers) if (!peer.online) net.online(peer);
    const final = net.converged().join(' '), tokens = final.split(/[\s$]+/);
    expect(tokens.filter(word => /^w\d{3}$/.test(word)))
      .toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).filter(word => word !== 'w009'));
    expect(tokens.filter(word => word === 'Tb2')).toHaveLength(1);
    expect(tokens.slice(tokens.indexOf('w004'), tokens.indexOf('w004') + 3)).toEqual(['w004', 'Tb2', 'w005']);
    for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
      expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
    }
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.pendingMoves?.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

for (const pendingMoves of [false, true]) it(`an earlier concurrent prefix sorts before a later suffix and its authored empty successor (pending ${pendingMoves})`, () => {
  const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  try {
    // Exact independently reproduced eight-action seed1037 history.
    act(net, () => net.offline(a));
    act(net, () => a.joinAt('w020'));
    act(net, () => b.joinAt('w020'));
    act(net, () => c.enterBefore('w013'));
    act(net, () => net.offline(c));
    act(net, () => a.enterBefore('w016'));
    act(net, () => a.enterBefore('w030'));
    act(net, () => net.offline(b));
    net.online(a); net.online(b); net.online(c);
    const paragraphs = net.converged(), final = paragraphs.join(' '), tokens = final.split(/[\s$]+/);
    expect(tokens.filter(word => /^w\d{3}$/.test(word)))
      .toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
    const empty = paragraphs.flatMap((paragraph, index) => paragraph.trim() === '' ? [index] : []);
    expect(empty).toHaveLength(1);
    expect(paragraphs[empty[0] - 1].trim().endsWith('w029')).toBe(true);
    expect(paragraphs[empty[0] + 1].trim().startsWith('w030')).toBe(true);
    for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
      expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
    }
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.pendingMoves?.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

for (const pendingMoves of [false, true]) it(`a repair copy before a later middle paragraph stays before that paragraph's empty successor (pending ${pendingMoves})`, () => {
  const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200);
  try {
    // Exact ten-action seed22 history; the empty's origin follows the later
    // middle paragraph, while a server copy incorrectly inherited it as left.
    act(net, () => net.offline(b));
    act(net, () => a.joinAt('w020'));
    act(net, () => net.offline(a));
    act(net, () => a.enterBefore('w010'));
    act(net, () => a.typeBefore('w019', 'Ta4 '));
    act(net, () => b.enterBefore('w028'));
    act(net, () => a.enterBefore('w030'));
    const authored = a.pars(), authoredEmpty = authored.findIndex(paragraph => paragraph.trim() === '');
    expect(authored[authoredEmpty - 1].trim().endsWith('w029')).toBe(true);
    expect(authored[authoredEmpty + 1].trim().startsWith('w030')).toBe(true);
    act(net, () => net.online(b));
    act(net, () => a.enterBefore('Ta4'));
    const split = a.pars(), typedSuffix = split.findIndex(paragraph => paragraph.trim().startsWith('Ta4'));
    expect(split[typedSuffix - 1].trim().endsWith('w018')).toBe(true);
    expect(split[typedSuffix].trim().startsWith('Ta4 w019')).toBe(true);
    act(net, () => b.enterBefore('w013'));
    net.online(a);
    const paragraphs = net.converged(), final = paragraphs.join(' '), tokens = final.split(/[\s$]+/);
    expect(tokens.filter(word => /^w\d{3}$/.test(word)))
      .toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
    expect(tokens.filter(word => word === 'Ta4')).toHaveLength(1);
    expect(tokens.slice(tokens.indexOf('w018'), tokens.indexOf('w018') + 3)).toEqual(['w018', 'Ta4', 'w019']);
    const empty = paragraphs.flatMap((paragraph, index) => paragraph.trim() === '' ? [index] : []);
    expect(empty).toHaveLength(1);
    expect(paragraphs.findIndex(paragraph => paragraph.includes('w012'))).toBeLessThan(empty[0]);
    expect(paragraphs[empty[0] - 1].trim().endsWith('w029')).toBe(true);
    expect(paragraphs[empty[0] + 1].trim().startsWith('w030')).toBe(true);
    for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
      expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
    }
    expect(paragraphs.map(paragraph => paragraph.replace(/\s+/g, ' ').trim())).toEqual([
      `${words(6, 1)} $a+b$ ${words(3, 7)}`,
      words(3, 10),
      `${words(2, 13)} $c$ ${words(4, 15)}`,
      `Ta4 ${words(9, 19)}`,
      words(2, 28),
      '',
      `${words(4, 30)} $x^2$ ${words(4, 34)}`,
    ]);
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.pendingMoves?.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});
