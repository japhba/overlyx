// @vitest-environment happy-dom
import { it, expect } from 'vitest';
import { Net, par, text, math } from './yjs-net';

const words = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(6) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
  par(text(words(10, 20) + ' ')),
  par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
] };

for (const pendingMoves of [false, true]) it(`a later split suffix wins its original gap despite extra authored typing (pending ${pendingMoves})`, () => {
  const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200);
  try {
    // Exact six-action known seed36 minimum. The two authors split at
    // different places; neither author joins away either new boundary.
    net.offline(a);
    a.typeBefore('w036', 'Ta1 ');
    b.enterBefore('w035');
    net.flush();
    a.typeBefore('w036', 'Ta2 ');
    a.enterBefore('Ta1');
    expect(a.pars().at(-1)?.trim()).toBe('Ta1 Ta2 w036 w037');
    expect(a.pars().at(-2)?.trim().endsWith('w035')).toBe(true);
    net.online(a);
    const paragraphs = net.converged(), final = paragraphs.join(' ');
    const tokens = final.split(/[\s$]+/);
    expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
    for (const token of ['Ta1', 'Ta2']) expect(tokens.filter(word => word === token)).toHaveLength(1);
    expect(tokens.slice(tokens.indexOf('w035'), tokens.indexOf('w035') + 5)).toEqual(['w035', 'Ta1', 'Ta2', 'w036', 'w037']);
    for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
      expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
    }
    expect(paragraphs.map(paragraph => paragraph.replace(/\s+/g, ' ').trim())).toEqual([
      `${words(6)} $a+b$ ${words(8, 7)} $c$ ${words(5, 15)}`,
      words(10, 20),
      `${words(4, 30)} $x^2$ w034`,
      'w035',
      'Ta1 Ta2 w036 w037',
    ]);
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.pendingMoves?.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

for (const pendingMoves of [false, true]) it(`a newly kept split side retains the settled order of two typed words (pending ${pendingMoves})`, () => {
  const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200);
  try {
    // Exact six-action immutable known70 minimum. Both typed words stay
    // between the formula and w007; Enter puts their pair in its own paragraph.
    b.typeBefore('w007', 'Tb1 ');
    b.enterBefore('w013');
    net.flush();
    a.enterBefore('w007');
    b.typeBefore('w007', 'Tb2 ');
    b.enterBefore('Tb1');
    expect(b.pars().some(paragraph => paragraph.trim().startsWith('Tb1 Tb2 w007'))).toBe(true);
    const paragraphs = net.converged(), final = paragraphs.join(' '), tokens = final.split(/[\s$]+/);
    expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
    for (const word of ['Tb1', 'Tb2']) expect(tokens.filter(token => token === word)).toHaveLength(1);
    expect(tokens.slice(tokens.indexOf('w006'), tokens.indexOf('w006') + 4)).toEqual(['w006', 'a+b', 'Tb1', 'Tb2']);
    expect(tokens.slice(tokens.indexOf('Tb1'), tokens.indexOf('Tb1') + 3)).toEqual(['Tb1', 'Tb2', 'w007']);
    for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
      expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
    }
    expect(paragraphs.map(paragraph => paragraph.replace(/\s+/g, ' ').trim())).toEqual([
      `${words(6)} $a+b$`,
      'Tb1 Tb2',
      words(6, 7),
      `${words(2, 13)} $c$ ${words(5, 15)}`,
      words(10, 20),
      `${words(4, 30)} $x^2$ ${words(4, 34)}`,
    ]);
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.pendingMoves?.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

for (const pendingMoves of [false, true]) it(`a joined tail follows its winning predecessor across an overlapping split (pending ${pendingMoves})`, () => {
  const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200);
  try {
    // Exact five-action known seed69 minimum. Joining w020 removes only
    // its original boundary; both later Enter operations remain independent.
    a.typeBefore('w018', 'Ta3 ');
    net.flush();
    a.joinAt('w020');
    a.enterBefore('Ta3');
    expect(a.pars().some(paragraph => paragraph.trim().startsWith('Ta3 w018 w019 w020'))).toBe(true);
    b.enterBefore('w018');
    expect(b.pars().some(paragraph => paragraph.trim() === 'w018 w019')).toBe(true);
    const paragraphs = net.converged(), final = paragraphs.join(' '), tokens = final.split(/[\s$]+/);
    expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
    expect(tokens.filter(word => word === 'Ta3')).toHaveLength(1);
    expect(tokens.slice(tokens.indexOf('w017'), tokens.indexOf('w017') + 5)).toEqual(['w017', 'Ta3', 'w018', 'w019', 'w020']);
    for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
      expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
    }
    expect(paragraphs.map(paragraph => paragraph.replace(/\s+/g, ' ').trim())).toEqual([
      `${words(6)} $a+b$ ${words(8, 7)} $c$ ${words(3, 15)}`,
      'Ta3',
      words(12, 18),
      `${words(4, 30)} $x^2$ ${words(4, 34)}`,
    ]);
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.pendingMoves?.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});
