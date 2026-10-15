// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math } from './yjs-net';

const words = (n: number, from: number) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(6, 1) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
  par(text(words(10, 20) + ' ')),
  par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
] };
const act = (net: Net, fn: () => void) => {
  fn();
  for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
};

for (const pendingMoves of [false, true]) {
  it(`keeps repaired typing in a split suffix when its source paragraph is joined later (pending ${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200);
    try {
      // The same captured seed59 history in both models. A's queued split is
      // delivered first; B's individual typing updates repair into that kept
      // suffix before its queued stale join deletes the suffix's paragraph.
      act(net, () => b.typeBefore('w027', 'Tb6 '));
      act(net, () => b.joinAt('w030'));
      act(net, () => a.enterBefore('w024'));
      const paragraphs = net.converged(), final = paragraphs.join(' ');
      const tokens = final.split(/[\s$]+/);
      expect(tokens.filter(word => /^w\d{3}$/.test(word)))
        .toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
      expect(tokens.filter(word => word === 'Tb6')).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w026'), tokens.indexOf('w026') + 3)).toEqual(['w026', 'Tb6', 'w027']);
      expect(paragraphs.map(paragraph => paragraph.replace(/\s+/g, ' ').trim())).toEqual([
        `${words(6, 1)} $a+b$ ${words(8, 7)} $c$ ${words(5, 15)}`,
        words(4, 20),
        `${words(3, 24)} Tb6 ${words(7, 27)} $x^2$ ${words(4, 34)}`,
      ]);
      for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
      for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
        expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
        expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
      }
    } finally {
      for (const peer of net.peers) { peer.view.destroy(); peer.pendingMoves?.destroy(); peer.ydoc.destroy(); }
      net.server.destroy();
    }
  });
}
