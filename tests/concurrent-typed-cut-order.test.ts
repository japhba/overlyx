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
for (const pendingMoves of [false, true]) for (const scenario of [1037, 1027]) {
  it(`typed gaps survive native cuts and their canonical copies (captured split${scenario}, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    const observed: string[][] = [];
    const reset = () => { for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc))); };
    const act = (actor: typeof a, run: () => void) => { run(); if (!actor.inbox.length) observed.push(actor.pars()); reset(); };
    try {
      if (scenario === 1037) {
        // Literal five-action minimum of the preserved split-only1037 history.
        net.offline(a); reset();
        act(a, () => a.typeBefore('w036', 'Ta1 '));
        act(a, () => a.typeBefore('w030', 'Ta3 '));
        act(a, () => a.enterBefore('w030'));
        expect(clean(a.pars())[2]).toBe('Ta3');
        act(a, () => a.enterBefore('w034'));
        expect(clean(a.pars()).slice(2)).toEqual(['Ta3', `${words(30, 33)} $x^2$`, `${words(34, 35)} Ta1 ${words(36, 37)}`]);
        net.online(a); reset();
      } else {
        // Literal six-action minimum of the preserved split-only1027 history.
        net.offline(b); reset();
        act(a, () => a.typeBefore('w013', 'Ta2 '));
        net.flush(); reset();
        act(b, () => b.enterBefore('w007'));
        expect(clean(b.pars())[0]).toBe(`${words(1, 6)} $a+b$`);
        act(c, () => c.enterBefore('w003'));
        expect(clean(c.pars())[0]).toBe(words(1, 2));
        act(c, () => c.enterBefore('w011'));
        expect(clean(c.pars()).some(paragraph => paragraph === `${words(3, 6)} $a+b$ ${words(7, 10)}`)).toBe(true);
        net.online(b); reset();
      }
      const final = net.converged(), all = final.join(' '), tokens = all.split(/[\s$]+/);
      expect(tokens.filter(word => /^w\d{3}$/.test(word)), JSON.stringify(clean(final))).toEqual(words(1, 37).split(' '));
      const typed = scenario === 1037 ? ['Ta1', 'Ta3'] : ['Ta2'];
      for (const label of typed) expect(tokens.filter(word => word === label)).toHaveLength(1);
      if (scenario === 1037) {
        expect(tokens.slice(tokens.indexOf('w029'), tokens.indexOf('w029') + 3)).toEqual(['w029', 'Ta3', 'w030']);
        expect(tokens.slice(tokens.indexOf('w035'), tokens.indexOf('w035') + 3)).toEqual(['w035', 'Ta1', 'w036']);
        expect(clean(final)).toEqual([`${words(1, 6)} $a+b$ ${words(7, 14)} $c$ ${words(15, 19)}`, words(20, 29), 'Ta3', `${words(30, 33)} $x^2$`, `${words(34, 35)} Ta1 ${words(36, 37)}`]);
      } else {
        expect(tokens.slice(tokens.indexOf('w012'), tokens.indexOf('w012') + 3)).toEqual(['w012', 'Ta2', 'w013']);
        expect(clean(final)).toEqual([words(1, 2), `${words(3, 6)} $a+b$`, words(7, 10), `${words(11, 12)} Ta2 ${words(13, 14)} $c$ ${words(15, 19)}`, words(20, 29), `${words(30, 33)} $x^2$ ${words(34, 37)}`]);
      }
      expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
        expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`)); expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
      }
      const index = new Map(tokens.map((word, position) => [word, position]));
      for (const view of observed) {
        const seen = view.join(' ').split(/[\s$]+/).filter(word => /^w\d{3}$|^Ta[123]$/.test(word));
        for (let i = 1; i < seen.length; i++) expect(index.get(seen[i]), `${seen[i - 1]} before ${seen[i]} in an actor's completed view`).toBeGreaterThan(index.get(seen[i - 1])!);
      }
      for (const peer of net.peers) { expect(clean(peer.pars())).toEqual(clean(final)); expect(peer.formulas()).toEqual(['a+b', 'c', 'x^2']); expect(peer.pendingMoves?.waiting ?? false).toBe(false); }
    } finally {
      for (const peer of net.peers) { peer.remoteUpdates?.destroy(); peer.pendingMoves?.destroy(); peer.view.destroy(); peer.ydoc.destroy(); } net.server.destroy();
    }
  });
}
