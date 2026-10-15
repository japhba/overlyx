// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math } from './yjs-net';

const words = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(1, 6) + ' '), math('a+b'), text(' ' + words(7, 14) + ' '), math('c'), text(' ' + words(15, 19) + ' ')),
  par(text(words(20, 29) + ' ')),
  par(text(words(30, 33) + ' '), math('x^2'), text(' ' + words(34, 37) + ' ')),
] };
const clean = (paragraphs: string[]) => paragraphs.map(value => value.replace(/\s+/g, ' ').trim());
const labels = (paragraphs: string[]) => paragraphs.join(' ').split(/[\s$]+/).filter(value => /^(w\d{3}|Ta1|Ta3)$/.test(value));

for (const pendingMoves of [false, true]) for (const concurrentRepeatedCut of [false, true]) {
  it(`successive offline cuts keep a collected draft before its authored successor (captured1037, repeatedCut=${concurrentRepeatedCut}, pending=${pendingMoves})`, () => {
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
      // Literal seven- and nine-action minima of immutable captured split1037.
      net.offline(a); resetSelections();
      act(a, () => a.typeBefore('w036', 'Ta1 '));
      act(c, () => c.enterBefore('w025'));
      if (concurrentRepeatedCut) act(a, () => a.remove('w020 '));
      act(a, () => a.typeBefore('w030', 'Ta3 '));
      act(a, () => a.enterBefore('w030'));
      act(a, () => a.enterBefore('w034'));
      expect(clean(a.pars()).slice(2)).toEqual([
        'Ta3', `${words(30, 33)} $x^2$`, `${words(34, 35)} Ta1 ${words(36, 37)}`,
      ]);
      net.offline(c); resetSelections();
      if (concurrentRepeatedCut) {
        act(a, () => a.enterBefore('w025'));
        expect(clean(a.pars()).slice(1, 3)).toEqual([words(21, 24), words(25, 29)]);
      }
      net.online(a, 'server-first'); resetSelections();
      net.online(c, 'server-first'); resetSelections();
      const final = net.converged(), tokens = labels(final), all = final.join(' ');
      expect(tokens.filter(word => /^w\d{3}$/.test(word)), JSON.stringify(clean(final))).toEqual(words(1, 37).split(' ').filter(word => !concurrentRepeatedCut || word !== 'w020'));
      expect(tokens.filter(word => word === 'w020')).toHaveLength(concurrentRepeatedCut ? 0 : 1);
      expect(tokens.filter(word => word === 'Ta3')).toHaveLength(1);
      expect(tokens.filter(word => word === 'Ta1')).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w029'), tokens.indexOf('w029') + 3)).toEqual(['w029', 'Ta3', 'w030']);
      expect(tokens.slice(tokens.indexOf('w035'), tokens.indexOf('w035') + 3)).toEqual(['w035', 'Ta1', 'w036']);
      expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
        expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
        expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
      }
      expect(clean(final)).toEqual([
        `${words(1, 6)} $a+b$ ${words(7, 14)} $c$ ${words(15, 19)}`,
        words(concurrentRepeatedCut ? 21 : 20, 24), words(25, 29), 'Ta3', `${words(30, 33)} $x^2$`,
        `${words(34, 35)} Ta1 ${words(36, 37)}`,
      ]);
      const index = new Map(tokens.map((word, position) => [word, position]));
      for (const view of observed) {
        const surviving = view.filter(word => !concurrentRepeatedCut || word !== 'w020');
        for (let i = 1; i < surviving.length; i++) {
          expect(index.get(surviving[i]), `${surviving[i - 1]} before ${surviving[i]} in an actor's completed view`).toBeGreaterThan(index.get(surviving[i - 1])!);
        }
      }
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
