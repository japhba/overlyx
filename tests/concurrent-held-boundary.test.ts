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
  it(`preserves Enter before placed typing when a stale join competes with the split (pending ${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    try {
      act(net, () => a.joinAt('w020'));
      net.flush();
      act(net, () => net.offline(c));
      act(net, () => c.joinAt('w030'));
      act(net, () => b.typeBefore('w018', 'Tb1 '));
      act(net, () => b.typeBefore('w019', 'Tb3 '));
      act(net, () => b.enterBefore('Tb3'));
      net.online(c);
      const paragraphs = net.converged(), final = paragraphs.join(' '), tokens = final.split(/[\s$]+/);
      expect(tokens.filter(word => /^w\d{3}$/.test(word)))
        .toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
      for (const word of ['Tb1', 'Tb3']) expect(tokens.filter(token => token === word)).toHaveLength(1);
      expect(paragraphs.map(paragraph => paragraph.replace(/\s+/g, ' ').trim())).toEqual([
        `${words(6, 1)} $a+b$ ${words(8, 7)} $c$ ${words(3, 15)} Tb1 w018`,
        `Tb3 ${words(15, 19)} $x^2$ ${words(4, 34)}`,
      ]);
      for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    } finally {
      for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
      net.server.destroy();
    }
  });
}
