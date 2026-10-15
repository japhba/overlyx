// @vitest-environment happy-dom
/** A draft's right anchor must be settled before a competing copy is rejected. */
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
  it(`a draft stays in its original gap when its right word is resolved later (captured split58, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves });
    const a = net.peer('a', 100), b = net.peer('b', 200);
    const observed: string[][] = [];
    const act = (run: () => void, actor?: typeof a) => {
      run();
      if (actor && actor.inbox.length === 0) observed.push(actor.pars());
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Literal eight-action minimum of the immutable original split58 history.
      act(() => a.typeBefore('w022', 'Ta1 '), a);
      act(() => a.typeBefore('Ta1', 'Ta3 '), a);
      act(() => net.flush());
      expect(clean(b.pars())[1]).toBe(`w020 w021 Ta3 Ta1 ${words(8, 22)}`);
      act(() => b.typeBefore('w028', 'Tb4 '), b);
      expect(clean(b.pars())[1]).toBe(`w020 w021 Ta3 Ta1 ${words(6, 22)} Tb4 w028 w029`);
      act(() => b.enterBefore('Ta3'), b);
      expect(clean(b.pars()).slice(1, 3)).toEqual(['w020 w021', `Ta3 Ta1 ${words(6, 22)} Tb4 w028 w029`]);
      act(() => a.typeBefore('w034', 'Ta4 '), a);
      act(() => a.typeBefore('Ta1', 'Ta5 '), a);
      expect(clean(a.pars())[1]).toBe(`w020 w021 Ta3 Ta5 Ta1 ${words(8, 22)}`);
      act(() => a.enterBefore('w029'), a);
      expect(clean(a.pars()).slice(1, 3)).toEqual([`w020 w021 Ta3 Ta5 Ta1 ${words(7, 22)}`, 'w029']);

      const final = net.converged(), all = final.join(' '), tokens = all.split(/[\s$]+/);
      const expectedWords = Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`);
      expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(expectedWords);
      expect(tokens.filter(word => /^T[a-b]\d+$/.test(word))).toEqual(['Ta3', 'Ta5', 'Ta1', 'Tb4', 'Ta4']);
      expect(tokens.slice(tokens.indexOf('w027'), tokens.indexOf('w027') + 3)).toEqual(['w027', 'Tb4', 'w028']);
      expect(tokens.slice(tokens.indexOf('Ta3'), tokens.indexOf('Ta3') + 4)).toEqual(['Ta3', 'Ta5', 'Ta1', 'w022']);
      expect(tokens.slice(tokens.indexOf('w033'), tokens.indexOf('w033') + 4)).toEqual(['w033', 'x^2', 'Ta4', 'w034']);
      expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
        expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
        expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
      }
      const finalIndex = new Map(tokens.map((word, index) => [word, index]));
      for (const paragraphs of observed) {
        const seen = paragraphs.join(' ').split(/[\s$]+/).filter(word => /^(w\d{3}|T[a-b]\d+)$/.test(word) && finalIndex.has(word));
        for (let i = 1; i < seen.length; i++) expect(finalIndex.get(seen[i]), `${seen[i - 1]} before ${seen[i]} in an actor's completed view`).toBeGreaterThan(finalIndex.get(seen[i - 1])!);
      }
      expect(clean(final)).toEqual([
        `${words(6)} $a+b$ ${words(8, 7)} $c$ ${words(5, 15)}`,
        'w020 w021', `Ta3 Ta5 Ta1 ${words(6, 22)} Tb4 w028`, 'w029',
        `${words(4, 30)} $x^2$ Ta4 ${words(4, 34)}`,
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
