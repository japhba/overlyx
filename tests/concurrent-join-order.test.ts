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
const act = (net: Net, fn: () => void) => { fn(); for (const p of net.peers) p.view.dispatch(p.view.state.tr.setSelection(TextSelection.atStart(p.view.state.doc))); };
const ordered = (net: Net, deleted: number[] = []) => {
  const final = net.converged().join(' '), got = final.split(/[\s$]+/);
  let last = -1;
  for (let i = 1; i <= 37; i++) {
    const word = `w${String(i).padStart(3, '0')}`;
    if (deleted.includes(i)) { expect(got, word).not.toContain(word); continue; }
    expect(got.filter(w => w === word), word).toHaveLength(1);
    const at = got.indexOf(word);
    expect(at, word).toBeGreaterThan(last); last = at;
  }
  for (const p of net.peers) expect(p.formulas()).toEqual(['a+b', 'c', 'x^2']);
  for (const [left, formula, right] of [['w006', '$a+b$', 'w007'], ['w014', '$c$', 'w015'], ['w033', '$x^2$', 'w034']]) {
    expect(final.indexOf(left)).toBeLessThan(final.indexOf(formula));
    expect(final.indexOf(formula)).toBeLessThan(final.indexOf(right));
  }
  for (const p of net.peers) { p.view.destroy(); p.ydoc.destroy(); }
  net.server.destroy();
};

it('typing before a joined prefix keeps its gap when a stale earlier paragraph joins it', () => {
  const net = new Net(content, { pendingMoves: true }), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => net.offline(b));
  act(net, () => a.enterBefore('w026'));
  act(net, () => b.enterBefore('w033'));
  act(net, () => a.typeBefore('w020', 'Ta3 '));
  act(net, () => a.joinAt('w030'));
  act(net, () => b.joinAt('w020'));
  net.online(b);
  expect(net.converged().join(' ')).toContain('w019 Ta3 w020');
  ordered(net);
});

for (const restart of [false, true]) it(`a separately split typed paragraph stays between its joined source word anchors (${restart ? 'restarted' : 'live'} history)`, () => {
  const net = new Net(content, { pendingMoves: true }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  act(net, () => a.joinAt('w020'));
  act(net, () => a.enterBefore('w014'));
  net.flush();
  act(net, () => a.typeBefore('w026', 'Ta1 '));
  act(net, () => b.enterBefore('w026'));
  act(net, () => net.offline(c));
  act(net, () => c.enterBefore('w021'));
  net.flush();
  act(net, () => c.joinAt('w030'));
  act(net, () => b.enterBefore('Ta1'));
  net.online(c);
  net.converged();
  if (restart) {
    net.restart();
    for (const peer of net.peers) net.online(peer);
    act(net, () => a.typeBefore('w026', 'AFTER '));
  }
  const paragraphs = net.converged(), tokens = paragraphs.join(' ').split(/\s+/);
  expect(tokens.filter(word => word === 'Ta1')).toHaveLength(1);
  const gap = restart ? ['w025', 'Ta1', 'AFTER', 'w026'] : ['w025', 'Ta1', 'w026'];
  expect(tokens.slice(tokens.indexOf('w025'), tokens.indexOf('w025') + gap.length), JSON.stringify(paragraphs)).toEqual(gap);
  if (restart) expect(tokens.filter(word => word === 'AFTER')).toHaveLength(1);
  expect(paragraphs.find(paragraph => paragraph.includes('Ta1'))?.trim()).toBe('Ta1');
  ordered(net);
});

it('a canonical split response keeps every joined word before its formula while another author stays offline', () => {
  const net = new Net(content, { pendingMoves: true }), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.typeBefore('w022', 'Ta1 '));
  act(net, () => b.joinAt('w020'));
  act(net, () => a.typeBefore('w012', 'Ta2 '));
  act(net, () => b.joinAt('w030'));
  net.flush();
  act(net, () => a.typeBefore('Ta2', 'Ta6 '));
  act(net, () => net.offline(a));
  act(net, () => a.enterBefore('w022'));
  act(net, () => b.enterBefore('w019'));
  net.flush();
  const visible = b.pars().join(' ');
  expect(visible.split(/\s+/).filter(word => /^w\d{3}$/.test(word)))
    .toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`));
  expect(visible.indexOf('w033')).toBeLessThan(visible.indexOf('$x^2$'));
  expect(visible.indexOf('$x^2$')).toBeLessThan(visible.indexOf('w034'));
  act(net, () => b.typeBefore('w004', 'Tb5 '));
  net.online(a);
  ordered(net);
});

it('a later insertion before another typed word retains that order after the original right word was deleted', () => {
  const net = new Net(content, { pendingMoves: true }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  act(net, () => net.offline(b));
  act(net, () => a.typeBefore('w014', 'Ta2 '));
  act(net, () => c.remove('w014 '));
  act(net, () => a.typeBefore('Ta2', 'Ta3 '));
  net.flush();
  act(net, () => b.joinAt('w030'));
  act(net, () => b.enterBefore('w009'));
  net.online(b);
  const final = net.converged().join(' ');
  expect(final).toContain('w013 Ta3 Ta2');
  for (const word of ['Ta2', 'Ta3']) expect(final.split(/\s+/).filter(token => token === word)).toHaveLength(1);
  ordered(net, [14]);
});

it('splitting a joined tail twice keeps its preceding formula and both authored breaks', () => {
  const net = new Net(content, { pendingMoves: true }), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.joinAt('w030'));
  act(net, () => b.remove('w033 '));
  act(net, () => b.remove('w032 '));
  act(net, () => b.typeBefore('w034', 'Tb7 '));
  act(net, () => b.enterBefore('w036'));
  act(net, () => b.enterBefore('w035'));
  act(net, () => a.enterBefore('w025'));
  const paragraphs = net.converged(), final = paragraphs.join(' ');
  expect(final.indexOf('w031')).toBeLessThan(final.indexOf('Tb7'));
  expect(final.indexOf('Tb7')).toBeLessThan(final.indexOf('w034'));
  expect(paragraphs.find(paragraph => paragraph.includes('w035'))?.trim()).toBe('w035');
  expect(paragraphs.find(paragraph => paragraph.includes('w036'))?.trim()).toBe('w036 w037');
  ordered(net, [32, 33]);
});

for (const selected of [false, true]) it(`joining after a deleted paragraph end keeps concurrent text before the joined prefix (${selected ? 'selected' : 'direct'} deletion)`, () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.enterBefore('w018'));
  act(net, () => {
    if (!selected) { b.remove('w019 '); return; }
    const at = b.find('w019 '); b.select(at, at + 5); b.view.dispatch(b.view.state.tr.deleteSelection());
  });
  act(net, () => b.joinAt('w020'));
  act(net, () => a.typeBefore('w019', 'Ta7 '));
  const final = net.converged().join(' ');
  expect(final.indexOf('w018')).toBeLessThan(final.indexOf('Ta7'));
  expect(final.indexOf('Ta7')).toBeLessThan(final.indexOf('w020'));
  ordered(net, [19]);
});

it('a concurrent split keeps the joined prefix before the split suffix', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.enterBefore('w033'));
  act(net, () => a.joinAt('w030'));
  ordered(net);
});

it('splitting the first joined word keeps the preceding paragraph before the remaining words', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.joinAt('w020'));
  act(net, () => b.enterBefore('w021'));
  ordered(net);
});

it('an offline join keeps whole words typed before a concurrent split and all formula anchors', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  act(net, () => a.joinAt('w020'));
  net.flush();
  act(net, () => net.offline(c));
  act(net, () => c.joinAt('w030'));
  act(net, () => b.typeBefore('w018', 'Tb1 '));
  act(net, () => b.typeBefore('w019', 'Tb3 '));
  act(net, () => b.enterBefore('Tb3'));
  net.online(c);
  const final = net.converged().join(' ');
  expect(final).toContain('w017 Tb1 w018');
  expect(final).toContain('Tb3 w019');
  expect(net.converged().map(paragraph => paragraph.replace(/\s+/g, ' ').trim())).toEqual([
    `${words(6, 1)} $a+b$ ${words(8, 7)} $c$ ${words(3, 15)} Tb1 w018`,
    `Tb3 ${words(15, 19)} $x^2$ ${words(4, 34)}`,
  ]);
  ordered(net);
});

it('a formula follows the surviving left word when its deleted boundary was split again', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.enterBefore('w024'));
  act(net, () => b.joinAt('w030'));
  act(net, () => { const at = b.find('w033 '); b.select(at, at + 5); b.view.dispatch(b.view.state.tr.deleteSelection()); });
  net.send(a);
  act(net, () => a.enterBefore('w026'));
  net.send(b);
  const final = net.converged().join(' ');
  expect(final.indexOf('w032')).toBeLessThan(final.indexOf('$x^2$'));
  ordered(net, [33]);
});

it('typing in an offline joined run keeps its interior anchor through two stale splits', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.joinAt('w030'));
  act(net, () => net.offline(a));
  act(net, () => a.enterBefore('w033'));
  act(net, () => net.offline(b));
  act(net, () => b.enterBefore('w021'));
  act(net, () => b.typeBefore('w024', 'Tb6 '));
  net.online(a); net.online(b);
  const final = net.converged().join(' ');
  expect(final).toContain('w023 Tb6 w024');
  ordered(net);
});

it('a formula follows all joined words when a previously split prefix is split and rejoined again', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.typeBefore('w016', 'Tb1 ')); net.flush();
  act(net, () => b.joinAt('w030'));
  act(net, () => b.enterBefore('w016'));
  act(net, () => a.enterBefore('w014'));
  act(net, () => a.joinAt('w014'));
  act(net, () => a.enterBefore('Tb1'));
  net.send(b);
  act(net, () => b.joinAt('w020'));
  act(net, () => b.enterBefore('w014'));
  const final = net.converged().join(' ');
  expect(final.indexOf('w033')).toBeLessThan(final.indexOf('$x^2$'));
  expect(final.indexOf('w015')).toBeLessThan(final.indexOf('Tb1'));
  expect(final.indexOf('Tb1')).toBeLessThan(final.indexOf('w016'));
  ordered(net);
});

it('late typing before a deleted word keeps its anchor after the joined prefix was re-split', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.typeBefore('w016', 'Tb1 ')); net.flush();
  act(net, () => b.enterBefore('w016'));
  act(net, () => a.enterBefore('w014'));
  act(net, () => a.joinAt('w014'));
  act(net, () => a.enterBefore('Tb1'));
  act(net, () => net.offline(b));
  act(net, () => { const at = b.find('w019 '); b.select(at, at + 5); b.view.dispatch(b.view.state.tr.deleteSelection()); });
  act(net, () => b.joinAt('w020'));
  act(net, () => b.enterBefore('w014'));
  act(net, () => net.offline(a));
  act(net, () => a.typeBefore('w019', 'Ta7 '));
  net.online(a); net.online(b);
  const final = net.converged().join(' ');
  expect(final.indexOf('w018')).toBeLessThan(final.indexOf('Ta7'));
  expect(final.indexOf('Ta7')).toBeLessThan(final.indexOf('w020'));
  ordered(net, [19]);
});

it('a copied fragment uses the surviving continuation before its old distant right origin', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => { const at = b.find('w008 '); b.select(at, at + 5); b.view.dispatch(b.view.state.tr.deleteSelection()); });
  act(net, () => a.enterBefore('w014'));
  act(net, () => net.offline(b));
  act(net, () => { const at = a.find('w009 '); a.select(at, at + 5); a.view.dispatch(a.view.state.tr.deleteSelection()); });
  act(net, () => b.joinAt('w020'));
  act(net, () => b.enterBefore('w015'));
  act(net, () => a.enterBefore('w010'));
  net.online(b);
  ordered(net, [8, 9]);
});

it('a paragraph split from a joined-away block is ordered before its concurrent later suffix', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.joinAt('w030'));
  act(net, () => net.offline(a));
  act(net, () => a.enterBefore('w033'));
  net.send(b);
  net.online(a, 'server-first');
  act(net, () => b.enterBefore('w030'));
  act(net, () => a.enterBefore('w037'));
  ordered(net);
});

it('splitting a rejoined root paragraph keeps its earlier prefix before a concurrent suffix', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.enterBefore('w009'));
  act(net, () => b.joinAt('w009'));
  act(net, () => a.enterBefore('w014'));
  act(net, () => b.enterBefore('w018'));
  act(net, () => a.joinAt('w020'));
  act(net, () => a.enterBefore('w018'));
  ordered(net);
});

it('a concurrently joined prefix stays before typing at a later split paragraph start', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.joinAt('w020'));
  act(net, () => a.joinAt('w030'));
  act(net, () => net.offline(b));
  act(net, () => b.enterBefore('w035'));
  act(net, () => b.typeBefore('w035', 'Tb5 '));
  net.online(b);
  const final = net.converged().join(' ');
  expect(final.indexOf('w034')).toBeLessThan(final.indexOf('Tb5'));
  expect(final.indexOf('Tb5')).toBeLessThan(final.indexOf('w035'));
  ordered(net);
});

it('late typing inside a joined prefix retains its interior words after two authors split again', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.typeBefore('w021', 'Tb1 '));
  act(net, () => net.offline(a));
  act(net, () => { const at = a.find('w020 '); a.select(at, at + 5); a.view.dispatch(a.view.state.tr.deleteSelection()); });
  act(net, () => b.joinAt('w030'));
  act(net, () => a.typeBefore('w028', 'Ta6 '));
  act(net, () => b.enterBefore('w021'));
  act(net, () => a.joinAt('w021'));
  act(net, () => a.enterBefore('w028'));
  net.online(a);
  // (a's Enter before w028 stays: its paragraph ends after Ta6)
  const final = net.converged().join(' ').replace(/\s+/g, ' ');
  expect(final).toContain('w027 Ta6 w028');
  expect(final.indexOf('Tb1')).toBeLessThan(final.indexOf('w021'));
  ordered(net, [20]);
});

it('typing through a joined split copy keeps the original interior word gap', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.enterBefore('w030')); net.flush();
  act(net, () => a.enterBefore('w034'));
  act(net, () => b.joinAt('w030')); net.flush();
  act(net, () => b.enterBefore('w019'));
  act(net, () => a.typeBefore('w030', 'Ta3 '));
  act(net, () => b.joinAt('w030'));
  act(net, () => a.enterBefore('w032'));
  act(net, () => a.joinAt('Ta3'));
  act(net, () => a.typeBefore('w027', 'Ta6 '));
  const final = net.converged().join(' ');
  expect(final).toContain('w026 Ta6 w027');
  expect(final).toContain('w029 Ta3 w030');
  ordered(net);
});

it('text copied and collected while offline keeps its original gap beside joined words', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => net.offline(a));
  act(net, () => a.typeBefore('w018', 'Ta4 '));
  act(net, () => { const at = a.find('w020 '); a.select(at, at + 5); a.view.dispatch(a.view.state.tr.deleteSelection()); });
  act(net, () => b.joinAt('w030'));
  act(net, () => a.typeBefore('w028', 'Ta6 '));
  act(net, () => a.joinAt('w021'));
  act(net, () => a.enterBefore('w028'));
  net.online(a);
  const final = net.converged().join(' ').replace(/\s+/g, ' ');
  expect(final).toContain('w017 Ta4 w018');
  expect(final).toContain('w027 Ta6 w028');
  ordered(net, [20]);
});

it('a typed word copied before reconnect retains its source gap while a third author stays offline', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  act(net, () => a.joinAt('w030'));
  act(net, () => net.offline(b));
  act(net, () => b.typeBefore('w023', 'Tb2 '));
  act(net, () => b.enterBefore('w023'));
  act(net, () => c.joinAt('w020'));
  act(net, () => net.offline(c));
  net.online(b, 'server-first'); net.flush();
  const paragraphs = net.converged(), tokens = paragraphs.join(' ').split(/[\s$]+/);
  expect(tokens.slice(tokens.indexOf('w022'), tokens.indexOf('w022') + 3)).toEqual(['w022', 'Tb2', 'w023']);
  // every author's change holds: c joined w020 to the first paragraph, b broke before w023, a joined w030
  expect(paragraphs).toHaveLength(2);
  expect(paragraphs[0].trim().endsWith('w019 w020 w021 w022 Tb2')).toBe(true);
  expect(paragraphs[1].trim().startsWith('w023 ')).toBe(true);
  expect(paragraphs[1]).toContain('w029 w030');
  ordered(net);
});

it('typing within a split prefix keeps its word anchors when a stale author joins the paragraph', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.enterBefore('w026'));
  act(net, () => a.typeBefore('w022', 'Ta1 '));
  act(net, () => b.joinAt('w020'));
  const final = net.converged().join(' ');
  expect(final.indexOf('w021')).toBeLessThan(final.indexOf('Ta1'));
  expect(final.indexOf('Ta1')).toBeLessThan(final.indexOf('w022'));
  ordered(net);
});

it('typing follows joined word anchors even while those anchors follow a concurrent split', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => net.offline(b));
  act(net, () => a.enterBefore('w026'));
  act(net, () => b.typeBefore('w026', 'Tb2 '));
  act(net, () => a.typeBefore('w022', 'Ta1 '));
  net.flush();
  act(net, () => b.joinAt('w020'));
  net.online(b);
  const final = net.converged().join(' ');
  expect(final.indexOf('w021')).toBeLessThan(final.indexOf('Ta1'));
  expect(final.indexOf('Ta1')).toBeLessThan(final.indexOf('w022'));
  expect(final.indexOf('w025')).toBeLessThan(final.indexOf('Tb2'));
  expect(final.indexOf('Tb2')).toBeLessThan(final.indexOf('w026'));
  ordered(net);
});

it('a joined formula and its following words follow a concurrently moved paragraph suffix', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.enterBefore('w025'));
  act(net, () => b.remove('w030 '));
  act(net, () => b.joinAt('w031'));
  const final = net.converged().join(' '), got = final.split(/[\s$]+/);
  let last = -1;
  for (let i = 1; i <= 37; i++) {
    const word = `w${String(i).padStart(3, '0')}`;
    if (i === 30) { expect(got).not.toContain(word); continue; }
    expect(got.filter(w => w === word), word).toHaveLength(1);
    const at = got.indexOf(word); expect(at, word).toBeGreaterThan(last); last = at;
  }
  expect(final.indexOf('w033')).toBeLessThan(final.indexOf('$x^2$'));
  expect(final.indexOf('$x^2$')).toBeLessThan(final.indexOf('w034'));
  for (const p of net.peers) { p.view.destroy(); p.ydoc.destroy(); }
  net.server.destroy();
});

it('a joined prefix follows its split right anchor when both neighboring paragraphs were split', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.enterBefore('w025'));
  act(net, () => a.enterBefore('w031'));
  act(net, () => { const at = b.find('w030 '); b.select(at, at + 5); b.view.dispatch(b.view.state.tr.deleteSelection()); });
  act(net, () => b.joinAt('w031'));
  ordered(net, [30]);
});

it('joining a previously split prefix follows a concurrent second split of its next paragraph', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.enterBefore('w033'));
  act(net, () => a.typeBefore('w034', 'Ta8 '));
  net.flush();
  act(net, () => b.typeBefore('w033', 'Tb3 '));
  act(net, () => b.joinAt('Tb3'));
  act(net, () => a.enterBefore('Ta8'));
  const final = net.converged().join(' ');
  expect(final.indexOf('w032')).toBeLessThan(final.indexOf('Tb3'));
  expect(final.indexOf('Tb3')).toBeLessThan(final.indexOf('w033'));
  expect(final.indexOf('w033')).toBeLessThan(final.indexOf('Ta8'));
  ordered(net);
});

it('a later stale split keeps complete typed words before their original right anchor', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.enterBefore('w021'));
  act(net, () => b.typeBefore('w021', 'Tb1 '));
  act(net, () => a.joinAt('w021'));
  act(net, () => a.enterBefore('w022'));
  act(net, () => b.typeBefore('Tb1', 'Tb3 '));
  act(net, () => b.enterBefore('Tb3'));
  const final = net.converged().join(' ');
  const got = final.split(/\s+/), at = got.indexOf('w020');
  expect(got.slice(at, at + 4)).toEqual(['w020', 'Tb3', 'Tb1', 'w021']);
  ordered(net);
});

it('copied formulas follow a joined run repaired into a concurrently split paragraph', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.joinAt('w030'));
  act(net, () => a.enterBefore('w018'));
  act(net, () => b.joinAt('w020'));
  const final = net.converged().join(' ');
  expect(final.indexOf('w033')).toBeLessThan(final.indexOf('$x^2$'));
  expect(final.indexOf('$x^2$')).toBeLessThan(final.indexOf('w034'));
  ordered(net);
});

it('joining the previous paragraph stays before new text at the next paragraph start', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.joinAt('w030'));
  act(net, () => a.typeBefore('w030', 'Ta3 '));
  act(net, () => a.enterBefore('w032'));
  const final = net.converged().join(' ');
  expect(final).toContain('w029 Ta3 w030');
  ordered(net);
});

it('joining after receiving a concurrent split preserves the middle words and both formulas', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  act(net, () => b.joinAt('w020'));
  act(net, () => c.enterBefore('w013'));
  act(net, () => net.offline(c));
  act(net, () => net.receive(b));
  act(net, () => b.joinAt('w013'));
  net.online(c);
  const final = net.converged().join(' ');
  expect(final.indexOf('w014')).toBeLessThan(final.indexOf('$c$'));
  expect(final.indexOf('$c$')).toBeLessThan(final.indexOf('w015'));
  ordered(net);
});

it('typing into a joined split suffix keeps its last word whole before the following formula', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.joinAt('w030'));
  act(net, () => a.enterBefore('w028'));
  act(net, () => a.typeBefore('w031', 'Ta7 '));
  const final = net.converged().join(' ');
  expect(final).toContain('Ta7 w031 w032 w033 $x^2$');
  ordered(net);
});

it('an offline split and join keeps its source order after the intermediate paragraph was collected', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => net.offline(a));
  act(net, () => a.enterBefore('w026'));
  act(net, () => b.enterBefore('w033'));
  act(net, () => a.joinAt('w030'));
  net.online(a);
  ordered(net);
});

it('an empty concurrent paragraph does not block sorting the known split and joined text', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.enterBefore('w030'));
  act(net, () => b.joinAt('w030'));
  act(net, () => a.enterBefore('w026'));
  ordered(net);
});

it('deleting the joining boundary word keeps the later paragraph after the concurrent split suffix', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => net.offline(a));
  act(net, () => a.remove('w029 '));
  act(net, () => a.enterBefore('w025'));
  act(net, () => b.remove('w030 '));
  act(net, () => b.joinAt('w031'));
  net.online(a);
  ordered(net, [29, 30]);
});

it('a kept run follows an earlier joined copy in the same paragraph after offline split and join', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.enterBefore('w005'));
  act(net, () => net.offline(a));
  act(net, () => net.offline(b));
  act(net, () => b.enterBefore('w006'));
  act(net, () => b.joinAt('w006'));
  net.online(a); net.online(b);
  ordered(net);
});

it('text typed into a copied split paragraph follows its word anchors through a join and stale split', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.enterBefore('w034'));
  act(net, () => a.typeBefore('w037', 'Ta3 '));
  act(net, () => b.enterBefore('w036'));
  act(net, () => a.joinAt('w034'));
  const final = net.converged().join(' ');
  expect(final).toContain('w036 Ta3 w037');
  ordered(net);
});

it('each copied run part retains text inserted between its mapped anchors before the next part is placed', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  act(net, () => b.joinAt('w030'));
  act(net, () => c.typeBefore('w034', 'Tc2 '));
  act(net, () => b.enterBefore('w033'));
  net.flush();
  act(net, () => a.joinAt('w033'));
  act(net, () => b.enterBefore('w030'));
  const final = net.converged().join(' ');
  expect(final).toContain('Tc2 w034');
  ordered(net);
});

it('a typing update after a join keeps both original paragraph prefixes in order through a stale split', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => a.joinAt('w020'));
  act(net, () => b.enterBefore('w028'));
  act(net, () => a.typeBefore('w026', 'Ta7 '));
  const final = net.converged().join(' ');
  expect(final).toContain('w025 Ta7 w026');
  ordered(net);
});

it('two authors typing in the joined prefix retain their distinct word anchors after a stale suffix split', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.joinAt('w030'));
  act(net, () => net.offline(a));
  act(net, () => a.typeBefore('w025', 'Ta3 '));
  act(net, () => b.typeBefore('w021', 'Tb2 '));
  act(net, () => a.enterBefore('w033'));
  net.send(b); net.online(a);
  const final = net.converged().join(' ');
  expect(final).toContain('w020 Tb2 w021');
  expect(final).toContain('w024 Ta3 w025');
  ordered(net);
});

it('text typed at a concurrent split follows the prefix before its copied suffix', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.enterBefore('w022'));
  act(net, () => a.typeBefore('w022', 'Ta5 '));
  const final = net.converged().join(' ');
  expect(final).toContain('w021 Ta5');
  expect(final.indexOf('Ta5')).toBeLessThan(final.indexOf('w022'));
  ordered(net);
});

it('a joined copied suffix follows its original left word after a concurrent split of the next paragraph', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  act(net, () => b.enterBefore('w022'));
  act(net, () => net.flush());
  act(net, () => b.enterBefore('w031'));
  act(net, () => c.joinAt('w030'));
  ordered(net);
});

it('a joined middle interval stays before its source suffix through two competing earlier splits', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  act(net, () => b.joinAt('w030'));
  act(net, () => b.enterBefore('w012'));
  act(net, () => b.enterBefore('w028'));
  act(net, () => a.enterBefore('w012'));
  act(net, () => b.joinAt('w020'));
  act(net, () => net.offline(b));
  act(net, () => net.online(b));
  ordered(net);
});
