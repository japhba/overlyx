// @vitest-environment happy-dom
/** Arbitration preserves an entire native retained suffix rather than selecting its characters separately. */
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
  it(`overlapping splits retain every character of the authored suffix together (captured split1002, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    const observed: string[][] = [];
    const act = (run: () => void) => {
      run();
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Literal seven-action minimum of the immutable split-only1002 history.
      act(() => b.enterBefore('w027')); observed.push(b.pars());
      expect(clean(b.pars())[1]).toBe(words(7, 20));
      expect(clean(b.pars())[2]).toBe(words(3, 27));
      act(() => net.offline(c));
      act(() => c.enterBefore('w022')); observed.push(c.pars());
      expect(clean(c.pars())[1]).toBe(words(2, 20));
      expect(clean(c.pars())[2]).toBe(words(8, 22));
      act(() => net.flush());
      act(() => net.offline(a));
      act(() => a.enterBefore('w024')); observed.push(a.pars());
      expect(clean(a.pars())[1]).toBe(words(4, 20));
      expect(clean(a.pars())[2]).toBe(words(3, 24));
      act(() => a.enterBefore('w025')); observed.push(a.pars());
      expect(clean(a.pars())[2]).toBe('w024');
      expect(clean(a.pars())[3]).toBe(words(2, 25));
      // replay() reconnects the remaining offline peers in creation order, using peer-first exchanges.
      act(() => net.online(a));
      act(() => net.online(c));
      const final = net.converged(), all = final.join(' '), tokens = all.split(/[\s$]+/);
      const expectedWords = Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`);
      expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(expectedWords);
      expect(tokens.filter(word => word === 'w025')).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w024'), tokens.indexOf('w024') + 4)).toEqual(['w024', 'w025', 'w026', 'w027']);
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
        `${words(6)} $a+b$ ${words(8, 7)} $c$ ${words(5, 15)}`,
        words(2, 20), words(2, 22), 'w024', words(2, 25), words(3, 27),
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
