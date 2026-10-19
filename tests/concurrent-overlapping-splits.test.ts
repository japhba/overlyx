// @vitest-environment happy-dom
/** Preserve the native cuts when an offline prefix overlaps a coauthor's smaller suffix. */
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { schema } from '@overlyx/core';
import { Net, par, text, math, parsOf } from './yjs-net';

const words = (n: number, from: number) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(6, 1) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
  par(text(words(10, 20) + ' ')),
  par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
] };
const normalized = (paragraphs: string[]) => paragraphs.map(paragraph => paragraph.replace(/\s+/g, ' ').trim());
function ordered(paragraphs: string[], intermediate = false) {
  const all = normalized(paragraphs).join(' ');
  // A canonical per-keystroke update may contain `Tw012` before the author
  // finishes `Tc2 `. The original label must survive uniquely and in order;
  // final documents and complete actor actions still require whole tokens.
  const tokens = intermediate ? all.match(/w\d{3}/g) ?? [] : all.split(/[\s$]+/);
  let last = -1;
  for (let i = 1; i <= 37; i++) {
    const word = `w${String(i).padStart(3, '0')}`;
    expect(tokens.filter(value => value === word), word).toHaveLength(1);
    const at = tokens.indexOf(word);
    expect(at, word).toBeGreaterThan(last); last = at;
  }
  expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
  for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
    expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
    expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
  }
}
function finalCuts(paragraphs: string[]) {
  ordered(paragraphs);
  const clean = normalized(paragraphs), all = clean.join(' '), tokens = all.split(/[\s$]+/);
  for (const word of ['Tb1', 'Tc2', 'Tb5']) expect(tokens.filter(value => value === word), word).toHaveLength(1);
  expect(all).toContain('w011 Tc2 w012');
  expect(all).toContain('w013 Tb5 w014');
  expect(all).toContain('w015 Tb1 w016');
  expect(clean).toHaveLength(7);
  expect(clean[0]).toMatch(/ w007$/);
  expect(clean[1]).toBe('w008');
  expect(clean[2]).toBe('w009');
  expect(clean[3]).toBe('w010 w011 Tc2 w012 w013 Tb5 w014 $c$ w015 Tb1');
  expect(clean[4]).toBe('w016 w017 w018 w019');
  expect(clean[5]).toBe(words(10, 20));
  expect(clean[6]).toBe(`${words(4, 30)} $x^2$ ${words(4, 34)}`);
}

for (const pendingMoves of [true, false]) for (const restart of [false, true]) {
  it(`concurrent native cuts remain ordered after later typing changes paragraph lengths (captured1017, pending=${pendingMoves}, restart=${restart})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    const canonical: string[][] = [], shown: string[][] = [];
    // the server's document after each change it applied
    net.server.on('afterTransaction', transaction => { if (transaction.changed.size) canonical.push(parsOf(net.serverDoc())); });
    const act = (run: () => void) => {
      run();
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Exact nine-action minimum from the immutable matching-provider seed1017 history.
      act(() => b.typeBefore('w016', 'Tb1 ')); shown.push(b.pars());
      act(() => b.enterBefore('w016')); shown.push(b.pars());
      act(() => b.enterBefore('w009')); shown.push(b.pars());
      expect(normalized(b.pars())[0]).toMatch(/ w008$/);
      expect(normalized(b.pars())[1]).toMatch(/^w009 /);
      act(() => net.offline(a));
      act(() => c.typeBefore('w012', 'Tc2 ')); shown.push(c.pars());
      act(() => a.enterBefore('w010')); shown.push(a.pars());
      expect(normalized(a.pars())[0]).toMatch(/ w009$/);
      expect(normalized(a.pars())[1]).toMatch(/^w010 /);
      act(() => b.enterBefore('w008')); shown.push(b.pars());
      expect(normalized(b.pars())[0]).toMatch(/ w007$/);
      expect(normalized(b.pars())[1]).toBe('w008');
      expect(normalized(b.pars())[2]).toMatch(/^w009 /);
      act(() => b.typeBefore('w014', 'Tb5 ')); shown.push(b.pars());
      act(() => net.flush());
      // The shrinking replay reconnects the remaining offline author with the default peer-first exchange.
      act(() => net.online(a));
      const final = net.converged();
      for (const view of shown) ordered(view);
      finalCuts(final);
      for (const peer of [a, b, c]) {
        finalCuts(peer.pars());
      }
      expect(canonical.length).toBeGreaterThan(0);
      for (const response of canonical) ordered(response, true);
      if (restart) {
        net.restart();
        for (const peer of net.peers) net.online(peer);
        finalCuts(net.converged());
        // A later real join supersedes its one cached cut after persistence;
        // the other five paragraph boundaries remain in order.
        b.joinAt('w009');
        const joined = net.converged();
        ordered(joined);
        const expected = normalized(final);
        expected.splice(1, 2, 'w008 w009');
        expect(normalized(joined)).toEqual(expected);
      }
    } finally {
      for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
      net.server.destroy();
    }
  });
}
