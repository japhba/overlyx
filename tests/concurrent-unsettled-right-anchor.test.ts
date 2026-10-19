// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math } from './yjs-net';

const words = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(6) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
  par(text(words(10, 20) + ' ')),
  par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
] };
const clean = (paragraphs: string[]) => paragraphs.map(paragraph => paragraph.replace(/\s+/g, ' ').trim());

for (const pendingMoves of [false, true]) {
  it(`copied successive drafts keep their gap while a right anchor is still resolving (captured split13, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves });
    const a = net.peer('a', 100), b = net.peer('b', 200);
    const observed: string[][] = [];
    const act = (run: () => void) => {
      run();
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Literal five-action minimum of the saved split13 history.
      act(() => b.typeBefore('w026', 'Tb1 ')); observed.push(b.pars());
      act(() => b.enterBefore('w029')); observed.push(b.pars());
      expect(clean(b.pars()).slice(1, 3)).toEqual([`${words(6, 20)} Tb1 ${words(3, 26)}`, 'w029']);
      act(() => a.enterBefore('w027')); observed.push(a.pars());
      expect(clean(a.pars()).slice(1, 3)).toEqual([words(7, 20), words(3, 27)]);
      act(() => b.typeBefore('w026', 'Tb2 ')); observed.push(b.pars());
      expect(clean(b.pars())[1]).toContain('w025 Tb1 Tb2 w026');
      act(() => b.enterBefore('w022')); observed.push(b.pars());
      expect(clean(b.pars()).slice(1, 4)).toEqual([words(2, 20), `${words(4, 22)} Tb1 Tb2 ${words(3, 26)}`, 'w029']);
      const final = net.converged(), all = final.join(' '), tokens = all.split(/[\s$]+/);
      expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
      for (const token of ['Tb1', 'Tb2']) expect(tokens.filter(word => word === token)).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w025'), tokens.indexOf('w025') + 4)).toEqual(['w025', 'Tb1', 'Tb2', 'w026']);
      expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
        expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
        expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
      }
      const index = new Map(tokens.map((word, i) => [word, i]));
      for (const view of observed) {
        const seen = view.join(' ').split(/[\s$]+/).filter(word => index.has(word));
        for (let i = 1; i < seen.length; i++) expect(index.get(seen[i])).toBeGreaterThan(index.get(seen[i - 1])!);
      }
      expect(clean(final)).toEqual([
        `${words(6)} $a+b$ ${words(8, 7)} $c$ ${words(5, 15)}`,
        words(2, 20), `${words(4, 22)} Tb1 Tb2 w026`, words(2, 27), 'w029',
        `${words(4, 30)} $x^2$ ${words(4, 34)}`,
      ]);
      for (const peer of net.peers) {
        expect(clean(peer.pars())).toEqual(clean(final));
        expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
      }
    } finally {
      for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
      net.server.destroy();
    }
  });
}
