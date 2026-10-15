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

for (const pending of [false, true]) it(`text typed into a retained split run survives a stale join (pending=${pending})`, () => {
  const net = new Net(content, { pendingMoves: pending }), a = net.peer('a', 100), b = net.peer('b', 200);
  const act = (fn: () => void) => { fn(); for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc))); };
  try {
    act(() => a.enterBefore('w013'));
    act(() => b.joinAt('w030'));
    act(() => a.enterBefore('w026'));
    act(() => a.typeBefore('w020', 'Ta2 '));
    const paragraphs = net.converged(), final = paragraphs.join(' '), tokens = final.split(/[\s$]+/);
    expect(tokens.filter(token => token === 'Ta2'), JSON.stringify(paragraphs)).toHaveLength(1);
    expect(tokens.slice(tokens.indexOf('w019'), tokens.indexOf('w019') + 3)).toEqual(['w019', 'Ta2', 'w020']);
    expect(tokens.filter(token => /^w\d{3}$/.test(token))).toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
    expect(final.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
    for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
      expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
    }
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});
