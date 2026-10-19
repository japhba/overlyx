// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math, expectTokens } from './yjs-net';

const words = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(1, 6) + ' '), math('a+b'), text(' ' + words(7, 14) + ' '), math('c'), text(' ' + words(15, 19) + ' ')),
  par(text(words(20, 29) + ' ')),
  par(text(words(30, 33) + ' '), math('x^2'), text(' ' + words(34, 37) + ' ')),
] };
const clean = (paragraphs: string[]) => paragraphs.map(value => value.replace(/\s+/g, ' ').trim());
const labels = (paragraphs: string[]) => paragraphs.join(' ').split(/[\s$]+/).filter(value => /^(w\d{3}|Ta3)$/.test(value));

for (const pendingMoves of [false, true]) {
  it(`a copied paragraph uses its latest native split endpoint for every word (capturedSplit22, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200);
    const observed: string[][] = [];
    const act = (actor: typeof a, run: () => void) => {
      run();
      if (!actor.inbox.length) observed.push(labels(actor.pars()));
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Literal four-action minimum of immutable captured split22.
      act(b, () => b.enterBefore('w009'));
      expect(clean(b.pars()).slice(0, 2)).toEqual([
        `${words(1, 6)} $a+b$ ${words(7, 8)}`, `${words(9, 14)} $c$ ${words(15, 19)}`,
      ]);
      act(a, () => a.enterBefore('w006'));
      act(a, () => a.typeBefore('w009', 'Ta3 '));
      act(a, () => a.enterBefore('w010'));
      expect(clean(a.pars()).slice(0, 3)).toEqual([
        words(1, 5), `w006 $a+b$ ${words(7, 8)} Ta3 w009`, `${words(10, 14)} $c$ ${words(15, 19)}`,
      ]);
      const final = net.converged(), tokens = labels(final), all = final.join(' ');
      expect(tokens.filter(word => /^w\d{3}$/.test(word)), JSON.stringify(clean(final))).toEqual(words(1, 37).split(' '));
      expect(tokens.filter(word => word === 'Ta3')).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w008'), tokens.indexOf('w008') + 3)).toEqual(['w008', 'Ta3', 'w009']);
      expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
        expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
        expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
      }
      // Keep the independent cuts before w006, w009, and w010; the typed
      // text remains beside its explicit right word w009.
      expectTokens(clean(final), [
        words(1, 5), `w006 $a+b$ ${words(7, 8)}`, 'Ta3 w009',
        `${words(10, 14)} $c$ ${words(15, 19)}`,
        words(20, 29), `${words(30, 33)} $x^2$ ${words(34, 37)}`,
      ]);
      const index = new Map(tokens.map((word, position) => [word, position]));
      for (const view of observed) for (let i = 1; i < view.length; i++) {
        expect(index.get(view[i]), `${view[i - 1]} before ${view[i]} in an actor's completed view`).toBeGreaterThan(index.get(view[i - 1])!);
      }
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
