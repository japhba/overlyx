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
function check(net: Net, deleted: number[], inserted: string[], adjacency: string[][]): string {
  try {
    for (const peer of net.peers) if (!peer.online) net.online(peer);
    const final = net.converged().join(' '), tokens = final.split(/[\s$]+/);
    const expected = Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).filter((_, i) => !deleted.includes(i + 1));
    for (const token of [...expected, ...inserted]) expect(tokens.filter(word => word === token), `${token} in ${final}`).toHaveLength(1);
    for (const i of deleted) expect(tokens).not.toContain(`w${String(i).padStart(3, '0')}`);
    expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(expected);
    for (const sequence of adjacency) {
      const at = tokens.indexOf(sequence[0]);
      expect(tokens.slice(at, at + sequence.length)).toEqual(sequence);
    }
    for (const peer of net.peers) expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
    for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
      expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
    }
    return final;
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
}

it('keeps a complete late insertion beside a deleted join boundary through a stale join', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  act(net, () => c.joinAt('w030'));
  act(net, () => c.enterBefore('w016'));
  act(net, () => net.flush());
  act(net, () => c.enterBefore('w028'));
  act(net, () => b.typeBefore('w030', 'Tb2 '));
  act(net, () => net.send(c));
  act(net, () => {
    const at = a.find('w030 ');
    a.select(at, at + 5);
    a.view.dispatch(a.view.state.tr.deleteSelection());
  });
  act(net, () => b.joinAt('w020'));
  check(net, [30], ['Tb2'], [['w029', 'Tb2', 'w031']]);
});

it('keeps a joined formula before its tail when an offline author splits both adjacent paragraphs', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => net.offline(a));
  act(net, () => a.enterBefore('w014'));
  act(net, () => a.enterBefore('w025'));
  act(net, () => {
    const at = b.find('w030 ');
    b.select(at, at + 5);
    b.view.dispatch(b.view.state.tr.deleteSelection());
  });
  act(net, () => b.joinAt('w031'));
  act(net, () => net.offline(b));
  act(net, () => a.enterBefore('w036'));
  act(net, () => b.enterBefore('w034'));
  net.online(b, 'server-first');
  act(net, () => b.joinAt('w020'));
  check(net, [30], [], []);
});

it('a joined prefix remains before its formula when concurrent typing was inserted beside both split boundaries', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => net.offline(a));
  act(net, () => a.typeBefore('w033', 'Ta7 '));
  act(net, () => b.enterBefore('w033'));
  act(net, () => a.typeBefore('w034', 'Ta8 '));
  act(net, () => net.flush());
  net.online(a, 'peer-first');
  act(net, () => b.typeBefore('w033', 'Tb3 '));
  act(net, () => b.joinAt('Tb3'));
  act(net, () => a.enterBefore('Ta8'));
  const final = check(net, [], ['Ta7', 'Ta8', 'Tb3'], [['Ta8', 'w034']]);
  for (const word of ['Ta7', 'Tb3']) {
    expect(final.indexOf('w032')).toBeLessThan(final.indexOf(word));
    expect(final.indexOf(word)).toBeLessThan(final.indexOf('w033'));
  }
});
