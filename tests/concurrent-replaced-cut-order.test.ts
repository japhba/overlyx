// @vitest-environment happy-dom
/** A creator's later join can replace a split container while preserving its earlier left cut. */
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math } from './yjs-net';

const words = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(6) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
  par(text(words(10, 20) + ' ')), par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
] };
const clean = (pars: string[]) => pars.map(value => value.replace(/\s+/g, ' ').trim());
const labels = (pars: string[]) => pars.join(' ').split(/[\s$]+/).filter(value => /^(?:w\d{3}|Tc[23])$/.test(value));

for (const pendingMoves of [false, true]) it(`a replaced split container retains its original boundary and paragraph order (captured1033, pending=${pendingMoves})`, () => {
  const net = new Net(content, { pendingMoves });
  const a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  const observed: string[][] = [];
  const act = (peer: typeof a, run: () => void) => {
    run();
    if (!peer.inbox.length) {
      const seen = labels(peer.pars()), counts = new Map<string, number>();
      for (const word of seen) counts.set(word, (counts.get(word) ?? 0) + 1);
      observed.push(seen.filter(word => counts.get(word) === 1));
    }
    for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
  };
  try {
    // Literal fourteen-action minimum of the immutable captured1033 history.
    net.offline(a);
    act(c, () => c.joinAt('w030'));
    net.offline(c);
    net.online(a, 'server-first');
    act(c, () => { const at = c.find('w028'); c.select(at, at + 'w028 '.length); c.view.dispatch(c.view.state.tr.deleteSelection()); });
    act(a, () => a.joinAt('w020'));
    act(c, () => c.typeBefore('w010', 'Tc2 '));
    act(a, () => a.enterBefore('w033'));
    act(c, () => c.typeBefore('w010', 'Tc3 '));
    act(a, () => a.enterBefore('w029'));
    act(c, () => c.enterBefore('w010'));
    net.offline(a);
    act(a, () => a.enterBefore('w023'));
    act(a, () => a.joinAt('w033'));
    expect(clean(a.pars())[1]).toBe(words(6, 23));
    expect(clean(a.pars())[2]).toBe(`${words(5, 29)} $x^2$ ${words(4, 34)}`);
    net.online(a); net.online(c);
    const final = net.converged(), all = final.join(' '), tokens = labels(final);
    expect(tokens.filter(word => /^w\d{3}$/.test(word)), JSON.stringify(clean(final))).toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).filter(word => word !== 'w028'));
    expect(tokens.filter(word => word === 'Tc2')).toHaveLength(1);
    expect(tokens.filter(word => word === 'Tc3')).toHaveLength(1);
    expect(tokens.slice(tokens.indexOf('w009'), tokens.indexOf('w009') + 4)).toEqual(['w009', 'Tc2', 'Tc3', 'w010']);
    expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
    for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
      expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
      expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
    }
    const positions = new Map(tokens.map((word, index) => [word, index]));
    for (const seen of observed) {
      const surviving = seen.filter(word => positions.has(word));
      for (let i = 1; i < surviving.length; i++) expect(positions.get(surviving[i]), `${surviving[i - 1]} before ${surviving[i]} in an actor's completed view`).toBeGreaterThan(positions.get(surviving[i - 1])!);
    }
    expect(clean(final)).toEqual([
      `${words(6)} $a+b$ ${words(3, 7)} Tc2 Tc3`,
      `${words(5, 10)} $c$ ${words(8, 15)}`,
      words(5, 23), `${words(5, 29)} $x^2$ ${words(4, 34)}`,
    ]);
    for (const peer of [a, b, c]) {
      expect(clean(peer.pars())).toEqual(clean(final));
      expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']);
      expect(peer.pendingMoves?.waiting ?? false).toBe(false);
    }
  } finally {
    for (const p of net.peers) { p.remoteUpdates?.destroy(); p.pendingMoves?.destroy(); p.view.destroy(); p.ydoc.destroy(); }
    net.server.destroy();
  }
});
