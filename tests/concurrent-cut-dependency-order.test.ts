// @vitest-environment happy-dom
/** Restoring one original cut must preserve later cuts and a typed word's native right gap. */
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math } from './yjs-net';

const words = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(6) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
  par(text(words(10, 20) + ' ')),
  par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
] };
const clean = (paragraphs: string[]) => paragraphs.map(paragraph => paragraph.replace(/\s+/g, ' ').trim());

for (const pendingMoves of [false, true]) {
  it(`overlapping restored cuts keep their original dependencies and a typed right gap (captured1002 second minimum, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    const observed: string[][] = [];
    const act = (run: () => void) => {
      run();
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Literal twelve-action minimum of the same immutable full1002 history.
      act(() => a.joinAt('w020')); observed.push(a.pars());
      act(() => a.enterBefore('w014')); observed.push(a.pars());
      act(() => net.flush());
      act(() => b.enterBefore('w026')); observed.push(b.pars());
      expect(clean(b.pars())[1]).toMatch(/ w025$/);
      expect(clean(b.pars())[2]).toBe(words(4, 26));
      act(() => net.offline(c));
      act(() => c.enterBefore('w021')); observed.push(c.pars());
      expect(clean(c.pars())[1]).toMatch(/ w020$/);
      expect(clean(c.pars())[2]).toMatch(/^w021 /);
      act(() => net.flush());
      act(() => c.joinAt('w030')); observed.push(c.pars());
      act(() => {
        const at = a.find('w024'); a.select(at, at + 5);
        a.view.dispatch(a.view.state.tr.deleteSelection());
      }); observed.push(a.pars());
      act(() => c.enterBefore('w025')); observed.push(c.pars());
      expect(clean(c.pars())[2]).toBe(words(4, 21));
      expect(clean(c.pars())[3]).toBe(`${words(9, 25)} $x^2$ ${words(4, 34)}`);
      act(() => b.typeBefore('w019', 'Tb3 ')); observed.push(b.pars());
      act(() => b.enterBefore('Tb3')); observed.push(b.pars());
      expect(clean(b.pars())[1]).toBe(`w014 $c$ ${words(4, 15)}`);
      expect(clean(b.pars())[2]).toMatch(/^Tb3 w019 w020 /);
      // replay() reconnects the remaining offline author using its default peer-first exchange.
      act(() => net.online(c));
      const final = net.converged(), all = final.join(' '), tokens = all.split(/[\s$]+/);
      const expectedWords = Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).filter(word => word !== 'w024');
      expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(expectedWords);
      expect(tokens).not.toContain('w024');
      expect(tokens.filter(word => word === 'Tb3')).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w018'), tokens.indexOf('w018') + 4)).toEqual(['w018', 'Tb3', 'w019', 'w020']);
      expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
        expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
        expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
      }
      const finalIndex = new Map(tokens.map((word, index) => [word, index]));
      for (const paragraphs of observed) {
        const seen = paragraphs.join(' ').split(/[\s$]+/).filter(word => finalIndex.has(word));
        for (let i = 1; i < seen.length; i++) expect(finalIndex.get(seen[i]), `${seen[i - 1]} before ${seen[i]} in an actor's completed view`).toBeGreaterThan(finalIndex.get(seen[i - 1])!);
      }
      expect(clean(final)).toEqual([
        `${words(6)} $a+b$ ${words(7, 7)}`,
        `w014 $c$ ${words(4, 15)}`,
        'Tb3 w019 w020', words(3, 21), 'w025',
        `${words(8, 26)} $x^2$ ${words(4, 34)}`,
      ]);
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

for (const pendingMoves of [false, true]) {
  it(`a headless draft typed after its cut stays with the original right word (captured1002 final minimum, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    const observed: string[][] = [];
    const act = (run: () => void) => {
      run();
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Literal thirteen-action minimum of the same immutable full1002 history.
      act(() => a.joinAt('w020')); observed.push(a.pars());
      act(() => a.enterBefore('w014')); observed.push(a.pars());
      act(() => net.flush());
      act(() => b.enterBefore('w026')); observed.push(b.pars());
      expect(clean(b.pars())[1]).toMatch(/ w025$/);
      expect(clean(b.pars())[2]).toBe(words(4, 26));
      act(() => net.offline(c));
      act(() => c.enterBefore('w021')); observed.push(c.pars());
      expect(clean(c.pars())[1]).toMatch(/ w020$/);
      expect(clean(c.pars())[2]).toMatch(/^w021 /);
      act(() => net.flush());
      act(() => c.joinAt('w030')); observed.push(c.pars());
      act(() => {
        const at = a.find('w024'); a.select(at, at + 5);
        a.view.dispatch(a.view.state.tr.deleteSelection());
      }); observed.push(a.pars());
      act(() => c.enterBefore('w025')); observed.push(c.pars());
      expect(clean(c.pars())[2]).toBe(words(4, 21));
      expect(clean(c.pars())[3]).toBe(`${words(9, 25)} $x^2$ ${words(4, 34)}`);
      act(() => b.typeBefore('w019', 'Tb3 ')); observed.push(b.pars());
      act(() => b.enterBefore('Tb3')); observed.push(b.pars());
      expect(clean(b.pars())[1]).toBe(`w014 $c$ ${words(4, 15)}`);
      expect(clean(b.pars())[2]).toMatch(/^Tb3 w019 w020 /);
      act(() => c.typeBefore('w025', 'Tc2 ')); observed.push(c.pars());
      // C typed on the right side after its cut; it has not received A's deletion yet.
      expect(clean(c.pars())[2]).toBe(words(4, 21));
      expect(clean(c.pars())[3]).toBe(`Tc2 ${words(9, 25)} $x^2$ ${words(4, 34)}`);
      // replay() reconnects the remaining offline author using its default peer-first exchange.
      act(() => net.online(c));
      const final = net.converged(), all = final.join(' '), tokens = all.split(/[\s$]+/);
      const expectedWords = Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).filter(word => word !== 'w024');
      expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(expectedWords);
      expect(tokens).not.toContain('w024');
      expect(tokens.filter(word => word === 'Tb3')).toHaveLength(1);
      expect(tokens.filter(word => word === 'Tc2')).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w023'), tokens.indexOf('w023') + 4)).toEqual(['w023', 'Tc2', 'w025', 'w026']);
      expect(tokens.slice(tokens.indexOf('w018'), tokens.indexOf('w018') + 4)).toEqual(['w018', 'Tb3', 'w019', 'w020']);
      expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
        expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
        expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
      }
      const finalIndex = new Map(tokens.map((word, index) => [word, index]));
      for (const paragraphs of observed) {
        const seen = paragraphs.join(' ').split(/[\s$]+/).filter(word => finalIndex.has(word));
        for (let i = 1; i < seen.length; i++) expect(finalIndex.get(seen[i]), `${seen[i - 1]} before ${seen[i]} in an actor's completed view`).toBeGreaterThan(finalIndex.get(seen[i - 1])!);
      }
      expect(clean(final)).toEqual([
        `${words(6)} $a+b$ ${words(7, 7)}`,
        `w014 $c$ ${words(4, 15)}`,
        'Tb3 w019 w020', words(3, 21), 'Tc2 w025',
        `${words(8, 26)} $x^2$ ${words(4, 34)}`,
      ]);
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

const longHeadlessWord = 'Tc2' + 'z'.repeat(300);

for (const pendingMoves of [false, true]) {
  it(`a long headless draft stays whole on the right of its original cut (captured1002 long insertion, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    const observed: string[][] = [];
    const act = (run: () => void) => {
      run();
      for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
    };
    try {
      // Same literal thirteen operations; only the final headless draft exceeds 256 characters.
      act(() => a.joinAt('w020')); observed.push(a.pars());
      act(() => a.enterBefore('w014')); observed.push(a.pars());
      act(() => net.flush());
      act(() => b.enterBefore('w026')); observed.push(b.pars());
      expect(clean(b.pars())[1]).toMatch(/ w025$/);
      expect(clean(b.pars())[2]).toBe(words(4, 26));
      act(() => net.offline(c));
      act(() => c.enterBefore('w021')); observed.push(c.pars());
      expect(clean(c.pars())[1]).toMatch(/ w020$/);
      expect(clean(c.pars())[2]).toMatch(/^w021 /);
      act(() => net.flush());
      act(() => c.joinAt('w030')); observed.push(c.pars());
      act(() => {
        const at = a.find('w024'); a.select(at, at + 5);
        a.view.dispatch(a.view.state.tr.deleteSelection());
      }); observed.push(a.pars());
      act(() => c.enterBefore('w025')); observed.push(c.pars());
      expect(clean(c.pars())[2]).toBe(words(4, 21));
      expect(clean(c.pars())[3]).toBe(`${words(9, 25)} $x^2$ ${words(4, 34)}`);
      act(() => b.typeBefore('w019', 'Tb3 ')); observed.push(b.pars());
      act(() => b.enterBefore('Tb3')); observed.push(b.pars());
      expect(clean(b.pars())[1]).toBe(`w014 $c$ ${words(4, 15)}`);
      expect(clean(b.pars())[2]).toMatch(/^Tb3 w019 w020 /);
      act(() => c.typeBefore('w025', longHeadlessWord + ' ')); observed.push(c.pars());
      // C typed on the right side after its cut; it has not received A's deletion yet.
      expect(clean(c.pars())[2]).toBe(words(4, 21));
      expect(clean(c.pars())[3]).toBe(`${longHeadlessWord} ${words(9, 25)} $x^2$ ${words(4, 34)}`);
      // replay() reconnects the remaining offline author using its default peer-first exchange.
      act(() => net.online(c));
      const final = net.converged(), all = final.join(' '), tokens = all.split(/[\s$]+/);
      const expectedWords = Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).filter(word => word !== 'w024');
      expect(tokens.filter(word => /^w\d{3}$/.test(word))).toEqual(expectedWords);
      expect(tokens).not.toContain('w024');
      expect(tokens.filter(word => word === 'Tb3')).toHaveLength(1);
      expect(tokens.filter(word => word === longHeadlessWord), `complete 303-character draft: ${JSON.stringify(clean(final))}`).toHaveLength(1);
      expect(tokens.slice(tokens.indexOf('w023'), tokens.indexOf('w023') + 4)).toEqual(['w023', longHeadlessWord, 'w025', 'w026']);
      expect(tokens.slice(tokens.indexOf('w018'), tokens.indexOf('w018') + 4)).toEqual(['w018', 'Tb3', 'w019', 'w020']);
      expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
        expect(all.indexOf(left)).toBeLessThan(all.indexOf(`$${formula}$`));
        expect(all.indexOf(`$${formula}$`)).toBeLessThan(all.indexOf(right));
      }
      const finalIndex = new Map(tokens.map((word, index) => [word, index]));
      for (const paragraphs of observed) {
        const seen = paragraphs.join(' ').split(/[\s$]+/).filter(word => finalIndex.has(word));
        for (let i = 1; i < seen.length; i++) expect(finalIndex.get(seen[i]), `${seen[i - 1]} before ${seen[i]} in an actor's completed view`).toBeGreaterThan(finalIndex.get(seen[i - 1])!);
      }
      expect(clean(final)).toEqual([
        `${words(6)} $a+b$ ${words(7, 7)}`,
        `w014 $c$ ${words(4, 15)}`,
        'Tb3 w019 w020', words(3, 21), `${longHeadlessWord} w025`,
        `${words(8, 26)} $x^2$ ${words(4, 34)}`,
      ]);
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
