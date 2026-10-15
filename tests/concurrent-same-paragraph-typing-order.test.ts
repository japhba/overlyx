// @vitest-environment happy-dom
/** A native copy of a draft must follow its winning left word within their shared paragraph. */
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
  it(`concurrent equal cuts keep a copied draft after its winning left word (captured split1014, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves });
    net.peer('a', 100);
    const b = net.peer('b', 200), c = net.peer('c', 300);
    const observed: string[][] = [];
    const act = (run: () => void) => {
      run();
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Literal four-action minimum of the immutable captured split1014 history.
      act(() => b.typeBefore('w006', 'Tb3 ')); observed.push(b.pars());
      expect(clean(b.pars())[0]).toMatch(/ w005 Tb3 w006 \$a\+b\$/);
      act(() => net.offline(c));
      act(() => c.enterBefore('w005')); observed.push(c.pars());
      expect(clean(c.pars())[0]).toBe(words(4));
      expect(clean(c.pars())[1]).toBe(`w005 w006 $a+b$ ${words(8, 7)} $c$ ${words(5, 15)}`);
      act(() => b.enterBefore('w005')); observed.push(b.pars());
      expect(clean(b.pars())[0]).toBe(words(4));
      expect(clean(b.pars())[1]).toBe(`w005 Tb3 w006 $a+b$ ${words(8, 7)} $c$ ${words(5, 15)}`);
      // replay() reconnects the offline author peer-first, then delivers B's queued typing and split.
      act(() => net.online(c));
      const final = net.converged(), all = final.join(' '), tokens = all.split(/[\s$]+/);
      const expectedWords = Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`);
      expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(expectedWords);
      expect(tokens.filter(word => word === 'Tb3')).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w004'), tokens.indexOf('w004') + 4)).toEqual(['w004', 'w005', 'Tb3', 'w006']);
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
        words(4), `w005 Tb3 w006 $a+b$ ${words(8, 7)} $c$ ${words(5, 15)}`,
        words(10, 20), `${words(4, 30)} $x^2$ ${words(4, 34)}`,
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
