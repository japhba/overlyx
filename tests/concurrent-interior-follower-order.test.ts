// @vitest-environment happy-dom
/** An interior text run must not inherit protection from an earlier native paragraph start. */
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
  it(`an interior draft follows its predecessor while actual native paragraph starts remain protected (captured join1018, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves });
    net.peer('a', 100);
    const b = net.peer('b', 200), c = net.peer('c', 300);
    const observed: string[][] = [];
    const act = (run: () => void) => {
      run();
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Literal six-action minimum of the immutable original join1018 history.
      act(() => net.offline(c));
      act(() => c.typeBefore('w015', 'Tc1 ')); observed.push(c.pars());
      expect(clean(c.pars())[0]).toBe(`${words(6)} $a+b$ ${words(8, 7)} $c$ Tc1 ${words(5, 15)}`);
      act(() => c.enterBefore('Tc1')); observed.push(c.pars());
      expect(clean(c.pars())[0]).toBe(`${words(6)} $a+b$ ${words(8, 7)} $c$`);
      expect(clean(c.pars())[1]).toBe(`Tc1 ${words(5, 15)}`);
      act(() => c.joinAt('Tc1')); observed.push(c.pars());
      // This intentional join removes the earlier cut before the draft.
      expect(clean(c.pars())).toHaveLength(3);
      expect(clean(c.pars())[0]).toBe(`${words(6)} $a+b$ ${words(8, 7)} $c$ Tc1 ${words(5, 15)}`);
      act(() => c.enterBefore('w014')); observed.push(c.pars());
      expect(clean(c.pars())[0]).toBe(`${words(6)} $a+b$ ${words(7, 7)}`);
      expect(clean(c.pars())[1]).toBe(`w014 $c$ Tc1 ${words(5, 15)}`);
      act(() => b.enterBefore('w015')); observed.push(b.pars());
      expect(clean(b.pars())[0]).toBe(`${words(6)} $a+b$ ${words(8, 7)} $c$`);
      expect(clean(b.pars())[1]).toBe(words(5, 15));
      // replay() reconnects C peer-first, then finalflush delivers B's independent cut.
      act(() => net.online(c));
      const final = net.converged(), all = final.join(' '), tokens = all.split(/[\s$]+/);
      const expectedWords = Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`);
      expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(expectedWords);
      expect(tokens.filter(word => word === 'Tc1')).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w014'), tokens.indexOf('w014') + 4)).toEqual(['w014', 'c', 'Tc1', 'w015']);
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
        `${words(6)} $a+b$ ${words(7, 7)}`, 'w014 $c$ Tc1', words(5, 15),
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
