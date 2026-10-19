// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math } from './yjs-net';

const words = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const first = `${words(1, 6)} $a+b$ ${words(7, 14)} $c$ ${words(15, 19)}`;
const third = `${words(30, 33)} $x^2$ ${words(34, 37)}`;
const content = { type: 'doc', content: [
  par(text(words(1, 6) + ' '), math('a+b'), text(' ' + words(7, 14) + ' '), math('c'), text(' ' + words(15, 19) + ' ')),
  par(text(words(20, 29) + ' ')),
  par(text(words(30, 33) + ' '), math('x^2'), text(' ' + words(34, 37) + ' ')),
] };
const clean = (paragraphs: string[]) => paragraphs.map(value => value.replace(/\s+/g, ' ').trim());
const tokens = (paragraphs: string[]) => paragraphs.join(' ').split(/[\s$]+/).filter(Boolean);

for (const pendingMoves of [false, true]) {
  it(`an interior kept prefix follows its formula without inventing a cut (capturedJoin12, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200);
    const observed: string[][] = [];
    const act = (run: () => void, actor?: typeof a) => {
      run();
      if (actor && actor.inbox.length === 0) observed.push(tokens(actor.pars()));
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Literal six-action minimum of the immutable captured join12 history.
      act(() => b.enterBefore('w008'), b);
      expect(clean(b.pars())).toEqual([
        `${words(1, 6)} $a+b$ w007`, `${words(8, 14)} $c$ ${words(15, 19)}`, words(20, 29), third,
      ]);
      act(() => net.flush());
      act(() => b.joinAt('w008'), b);
      // This join intentionally cancels the first cut before w008.
      expect(clean(b.pars())).toEqual([first, words(20, 29), third]);
      act(() => net.offline(b));
      act(() => b.enterBefore('w019'), b);
      expect(clean(b.pars())).toEqual([
        `${words(1, 6)} $a+b$ ${words(7, 14)} $c$ ${words(15, 18)}`, 'w019', words(20, 29), third,
      ]);
      act(() => a.enterBefore('w006'), a);
      expect(clean(a.pars())).toEqual([
        words(1, 5), 'w006 $a+b$ w007', `${words(8, 14)} $c$ ${words(15, 19)}`, words(20, 29), third,
      ]);
      net.online(b);
      const final = net.converged(), all = tokens(final);
      expect(all.filter(word => /^w\d{3}$/.test(word))).toEqual(words(1, 37).split(' '));
      expect(final.join(' ').match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
        expect(all.slice(all.indexOf(left), all.indexOf(left) + 3)).toEqual([left, formula, right]);
      }
      // Retain the independent cuts before w006 and w019. Recreating an
      // interior run before w019 must keep w015–18 with their preceding c.
      expect(clean(final)).toEqual([
        words(1, 5), `w006 $a+b$ ${words(7, 14)} $c$ ${words(15, 18)}`, 'w019', words(20, 29), third,
      ]);
      const index = new Map(all.map((word, position) => [word, position]));
      for (const view of observed) {
        const count = new Map<string, number>();
        for (const word of view) count.set(word, (count.get(word) ?? 0) + 1);
        const anchors = view.filter(word => index.has(word) && count.get(word) === 1);
        for (let i = 1; i < anchors.length; i++) expect(index.get(anchors[i]), `${anchors[i - 1]} before ${anchors[i]} in an actor's completed view`).toBeGreaterThan(index.get(anchors[i - 1])!);
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
