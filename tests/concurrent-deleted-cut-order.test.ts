// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math } from './yjs-net';

const words = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const first = `${words(1, 6)} $a+b$ ${words(7, 14)} $c$ ${words(15, 19)}`;
const content = { type: 'doc', content: [
  par(text(words(1, 6) + ' '), math('a+b'), text(' ' + words(7, 14) + ' '), math('c'), text(' ' + words(15, 19) + ' ')),
  par(text(words(20, 29) + ' ')),
  par(text(words(30, 33) + ' '), math('x^2'), text(' ' + words(34, 37) + ' ')),
] };
const clean = (paragraphs: string[]) => paragraphs.map(value => value.replace(/\s+/g, ' ').trim());
const tokens = (paragraphs: string[]) => paragraphs.join(' ').split(/[\s$]+/).filter(Boolean);

for (const pendingMoves of [false, true]) {
  it(`a deleted split anchor keeps its original next side after a later split (captured80, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200);
    const observed: string[][] = [];
    const act = (run: () => void, actor?: typeof a) => {
      run();
      if (actor && actor.inbox.length === 0) observed.push(actor.pars());
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Literal nine-action minimum of the immutable captured80 history.
      act(() => net.offline(a));
      act(() => b.joinAt('w030'), b);
      act(() => net.offline(b));
      act(() => b.enterBefore('w033'), b);
      expect(clean(b.pars())).toEqual([first, words(20, 32), `w033 $x^2$ ${words(34, 37)}`]);
      act(() => {
        const at = a.find('w033'); a.select(at, at + 5);
        a.view.dispatch(a.view.state.tr.deleteSelection());
      }, a);
      act(() => net.online(a, 'server-first'));
      act(() => net.online(b, 'peer-first'));
      act(() => b.enterBefore('w031'), b);
      // The later Enter is before w031; the earlier Enter's deleted w033
      // still leaves its formula and following text on their authored side.
      expect(clean(b.pars())).toEqual([first, words(20, 30), words(31, 32), `$x^2$ ${words(34, 37)}`]);
      act(() => b.typeBefore('w034', 'Tb4 '), b);
      const final = net.converged(), all = tokens(final);
      expect(all.filter(word => /^w\d{3}$/.test(word))).toEqual(words(1, 37).split(' ').filter(word => word !== 'w033'));
      expect(all).not.toContain('w033');
      expect(all.filter(word => word === 'Tb4')).toHaveLength(1);
      expect(all.slice(all.indexOf('w032'), all.indexOf('w032') + 4)).toEqual(['w032', 'x^2', 'Tb4', 'w034']);
      expect(final.join(' ').match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      expect(clean(final)).toEqual([first, words(20, 30), words(31, 32), `$x^2$ Tb4 ${words(34, 37)}`]);
      const index = new Map(all.map((word, position) => [word, position]));
      for (const view of observed) {
        const seen = tokens(view), count = new Map<string, number>();
        for (const word of seen) count.set(word, (count.get(word) ?? 0) + 1);
        const anchors = seen.filter(word => index.has(word) && count.get(word) === 1);
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
