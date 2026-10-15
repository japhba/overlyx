// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math } from './yjs-net';
const words = (n: number, from: number) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [par(text(words(6, 1) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')), par(text(words(10, 20) + ' ')), par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' '))] };
const resetSelections = (net: Net) => { for (const p of net.peers) p.view.dispatch(p.view.state.tr.setSelection(TextSelection.atStart(p.view.state.doc))); };
const joined = (p: { pars(): string[] }) => p.pars().join(' ');
describe('late insertion keeps its nearby anchor after competing paragraph moves', () => {
  it('keeps the middle of two concurrent splits in order while the coauthor types into their shared suffix', () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
    a.enterBefore('w011'); resetSelections(net); b.enterBefore('w009'); resetSelections(net); b.typeBefore('w013', 'Tb3 '); resetSelections(net);
    const final = net.converged().join(' '), got = final.split(/[\s$]+/);
    let last = -1;
    for (let i = 1; i <= 37; i++) {
      const word = `w${String(i).padStart(3, '0')}`, at = got.indexOf(word);
      expect(got.filter(w => w === word), word).toHaveLength(1);
      expect(at, word).toBeGreaterThan(last); last = at;
    }
    expect(final).toContain('w012 Tb3 w013');
    for (const p of net.peers) { p.view.destroy(); p.ydoc.destroy(); } net.server.destroy();
  });
  it('preserves an insertion split into a recreated run before an independent stale split', () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
    a.typeBefore('w002', 'Ta4 '); resetSelections(net); a.enterBefore('Ta4'); resetSelections(net); b.enterBefore('w005'); resetSelections(net);
    net.flush();
    for (const p of [a, b]) {
      expect(joined(p)).toContain('Ta4 w002');
      expect(joined(p).indexOf('Ta4')).toBeLessThan(joined(p).indexOf('w002'));
    }
    for (const p of net.peers) { p.view.destroy(); p.ydoc.destroy(); } net.server.destroy();
  });
  it('preserves the right anchor when the left word was deleted before a stale split', () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    a.select(a.find('w020'), a.find('w020') + 5); a.view.dispatch(a.view.state.tr.deleteSelection()); resetSelections(net); b.typeBefore('w021', 'Tb5 '); resetSelections(net); c.enterBefore('w024'); resetSelections(net);
    net.flush();
    for (const p of [a, b, c]) {
      expect(joined(p)).toContain('Tb5 w021');
      expect(joined(p)).not.toContain('w020 ');
    }
    for (const p of net.peers) { p.view.destroy(); p.ydoc.destroy(); } net.server.destroy();
  });
  it('keeps a copied insertion with its adjacent words after a later offline split', () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    net.offline(a); b.typeBefore('w017', 'Tb4 '); resetSelections(net); b.enterBefore('w013'); resetSelections(net);
    net.flush(); a.enterBefore('w015'); resetSelections(net); net.online(a); net.flush();
    for (const p of [a, b, c]) expect(joined(p)).toContain('w016 Tb4 w017');
    for (const p of net.peers) { p.view.destroy(); p.ydoc.destroy(); } net.server.destroy();
  });
  it('keeps an insertion between its words when another author copies the same suffix', () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    b.typeBefore('w018', 'Tb1 '); resetSelections(net); c.enterBefore('w016'); resetSelections(net); b.enterBefore('w016'); resetSelections(net);
    net.flush();
    for (const p of [a, b, c]) expect(joined(p)).toContain('w017 Tb1 w018');
    for (const p of net.peers) { p.view.destroy(); p.ydoc.destroy(); } net.server.destroy();
  });

  it('preserves the settled order of concurrent insertions at one boundary after an offline split', () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    a.typeBefore('w018', 'Ta2 '); resetSelections(net); b.typeBefore('w018', 'Tb2 '); resetSelections(net);
    net.offline(a); net.flush();
    for (const p of [b, c]) expect(joined(p)).toContain('Ta2 Tb2 w018');
    a.enterBefore('w013'); resetSelections(net); b.typeBefore('w010', 'Tb4 '); resetSelections(net);
    net.online(a); net.flush();
    for (const p of [a, b, c]) expect(joined(p)).toContain('Ta2 Tb2 w018');
    for (const p of net.peers) { p.view.destroy(); p.ydoc.destroy(); } net.server.destroy();
  });

  it('preserves order learned on reconnect before another stale split', () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    a.typeBefore('w010', 'Ta2 '); resetSelections(net); a.enterBefore('w028'); resetSelections(net); net.offline(b); net.flush();
    a.typeBefore('w010', 'Ta4 '); resetSelections(net); b.typeBefore('w010', 'Tb1 '); resetSelections(net); net.online(b); resetSelections(net);
    expect(joined(b)).toContain('Ta2 Tb1 w010');
    net.offline(b); b.typeBefore('w009', 'Tb2 '); resetSelections(net); c.enterBefore('Ta2'); resetSelections(net);
    net.online(b); net.flush();
    for (const p of [a, b, c]) expect(joined(p)).toContain('Ta2 Ta4 Tb1 w010');
    for (const p of net.peers) { p.view.destroy(); p.ydoc.destroy(); } net.server.destroy();
  });

});
