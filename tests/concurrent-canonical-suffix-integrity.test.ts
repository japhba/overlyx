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
const labels = (paragraphs: string[]) => paragraphs.join(' ').split(/[\s$]+/).filter(value => /^(w\d{3}|Tb2)$/.test(value));

for (const pendingMoves of [false, true]) {
  it(`a restored canonical suffix keeps whole words across nested offline cuts (captured1019, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    const observed: string[][] = [];
    const resetSelections = () => {
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    const act = (actor: typeof a, run: () => void) => {
      run();
      if (!actor.inbox.length) observed.push(labels(actor.pars()));
      resetSelections();
    };
    try {
      // Literal nine-action minimum of the immutable captured split1019.
      act(a, () => a.enterBefore('w015'));
      net.offline(c); resetSelections();
      act(a, () => a.enterBefore('w008'));
      act(a, () => a.enterBefore('w005'));
      expect(clean(a.pars()).slice(0, 4)).toEqual([
        words(1, 4), `${words(5, 6)} $a+b$ w007`, `${words(8, 14)} $c$`, words(15, 19),
      ]);
      act(c, () => c.enterBefore('w003'));
      act(c, () => c.enterBefore('w004'));
      expect(clean(c.pars()).slice(0, 3)).toEqual([
        words(1, 2), 'w003', `${words(4, 6)} $a+b$ ${words(7, 14)} $c$ ${words(15, 19)}`,
      ]);
      act(b, () => b.typeBefore('w003', 'Tb2 '));
      net.flush(); resetSelections();
      act(a, () => a.enterBefore('Tb2'));
      expect(clean(a.pars()).slice(0, 3)).toEqual([
        words(1, 2), `Tb2 ${words(3, 4)}`, `${words(5, 6)} $a+b$ w007`,
      ]);
      net.online(c, 'server-first'); resetSelections();
      const final = net.converged(), tokens = labels(final), all = final.join(' ');
      expect(tokens.filter(word => /^w\d{3}$/.test(word)), JSON.stringify(clean(final))).toEqual(words(1, 37).split(' '));
      expect(tokens.filter(word => word === 'Tb2')).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w002'), tokens.indexOf('w002') + 4)).toEqual(['w002', 'Tb2', 'w003', 'w004']);
      expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
        expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
        expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
      }
      expectTokens(clean(final), [
        words(1, 2), 'Tb2 w003', 'w004', `${words(5, 6)} $a+b$ w007`,
        `${words(8, 14)} $c$`, words(15, 19), words(20, 29), `${words(30, 33)} $x^2$ ${words(34, 37)}`,
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
