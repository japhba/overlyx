// @vitest-environment happy-dom
/** A restored whole paragraph participates in ordering after its original left word moves. */
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
  it(`a restored draft paragraph keeps its original position before the next source paragraph (captured split8, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200);
    const observed: string[][] = [];
    const act = (run: () => void) => {
      run();
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Literal five-action minimum of the immutable captured split8 history.
      act(() => a.enterBefore('w021')); observed.push(a.pars());
      expect(clean(a.pars())[1]).toBe('w020');
      expect(clean(a.pars())[2]).toBe(words(9, 21));
      act(() => a.typeBefore('w019', 'Ta2 ')); observed.push(a.pars());
      expect(clean(a.pars())[0]).toMatch(/ w018 Ta2 w019$/);
      act(() => b.enterBefore('w017')); observed.push(b.pars());
      expect(clean(b.pars())[0]).toMatch(/ w015 w016$/);
      expect(clean(b.pars())[1]).toBe(words(3, 17));
      act(() => {
        const at = a.find('w019'); a.select(at, at + 5);
        a.view.dispatch(a.view.state.tr.deleteSelection());
      }); observed.push(a.pars());
      act(() => a.enterBefore('Ta2')); observed.push(a.pars());
      // The author explicitly kept the draft in its own paragraph before the w020 paragraph.
      expect(clean(a.pars())[0]).toMatch(/ w017 w018$/);
      expect(clean(a.pars()).slice(1, 4)).toEqual(['Ta2', 'w020', words(9, 21)]);
      const final = net.converged(), all = final.join(' '), tokens = all.split(/[\s$]+/);
      const expectedWords = Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).filter(word => word !== 'w019');
      expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(expectedWords);
      expect(tokens).not.toContain('w019');
      expect(tokens.filter(word => word === 'Ta2')).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w018'), tokens.indexOf('w018') + 4)).toEqual(['w018', 'Ta2', 'w020', 'w021']);
      expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
        expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
        expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
      }
      const finalIndex = new Map(tokens.map((word, index) => [word, index]));
      for (const paragraphs of observed) {
        const seen = paragraphs.join(' ').split(/[\s$]+/).filter(word => finalIndex.has(word));
        for (let i = 1; i < seen.length; i++) expect(finalIndex.get(seen[i]), `${seen[i - 1]} before ${seen[i]} in an actor's completed view`).toBeGreaterThan(finalIndex.get(seen[i - 1])!);
      }
      expect(clean(final)).toEqual([
        `${words(6)} $a+b$ ${words(8, 7)} $c$ ${words(2, 15)}`,
        words(2, 17), 'Ta2', 'w020', words(9, 21),
        `${words(4, 30)} $x^2$ ${words(4, 34)}`,
      ]);
      for (const peer of net.peers) {
        expect(clean(peer.pars())).toEqual(clean(final));
        expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
        expect(peer.pendingMoves?.waiting ?? false).toBe(false);
      }
    } finally {
      for (const peer of net.peers) { peer.remoteUpdates?.destroy(); peer.pendingMoves?.destroy(); peer.view.destroy(); peer.ydoc.destroy(); }
      net.server.destroy();
    }
  });
}
