// @vitest-environment happy-dom
/** A late draft follows its original words when competing joins relocate their entire paragraph. */
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
  it(`a relocated whole paragraph keeps a late draft beside its surviving original words (captured1019, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    const observed: string[][] = [];
    const act = (run: () => void) => {
      run();
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // The literal ten-action minimum of the immutable captured1019 history.
      act(() => a.enterBefore('w021')); observed.push(a.pars());
      expect(clean(a.pars())[1]).toBe('w020');
      expect(clean(a.pars())[2]).toBe(words(9, 21));
      act(() => net.offline(a));
      act(() => net.offline(b));
      act(() => b.joinAt('w030')); observed.push(b.pars());
      expect(clean(b.pars())).toHaveLength(2);
      expect(clean(b.pars())[1]).toBe(`${words(14, 20)} $x^2$ ${words(4, 34)}`);
      act(() => {
        const at = a.find('w023'); a.select(at, at + 5);
        a.view.dispatch(a.view.state.tr.deleteSelection());
      }); observed.push(a.pars());
      act(() => a.joinAt('w021')); observed.push(a.pars());
      expect(clean(a.pars())).toHaveLength(3);
      expect(clean(a.pars())[1]).toBe(`${words(3, 20)} ${words(6, 24)}`);
      act(() => net.offline(c));
      act(() => c.typeBefore('w023', 'Tc4 ')); observed.push(c.pars());
      // C's completed view fixes the draft's gap even though A later deletes its right word.
      expect(clean(c.pars())[1]).toBe(`${words(3, 20)} Tc4 ${words(7, 23)}`);
      act(() => net.online(c, 'peer-first'));
      act(() => net.online(b, 'server-first'));
      // replay() reconnects the remaining offline author using its default peer-first exchange.
      act(() => net.online(a));
      const final = net.converged(), all = final.join(' '), tokens = all.split(/[\s$]+/);
      const expectedWords = Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).filter(word => word !== 'w023');
      expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(expectedWords);
      expect(tokens).not.toContain('w023');
      expect(tokens.filter(word => word === 'Tc4')).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w022'), tokens.indexOf('w022') + 4)).toEqual(['w022', 'Tc4', 'w024', 'w025']);
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
        `${words(3, 20)} Tc4 ${words(10, 24)} $x^2$ ${words(4, 34)}`,
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
