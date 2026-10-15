// @vitest-environment happy-dom
/** A later typed update must not move an earlier joined formula/text after its stale right origin. */
import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { schema } from '@overlyx/core';
import { Net, par, text, math, parsOf } from './yjs-net';

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

it('a late typed word does not pull joined earlier words and their formula behind a moved later origin', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  try {
    // Exact targeted seed1004 shrink; no intermediate flush changes its deliveries.
    act(net, () => a.joinAt('w020'));
    act(net, () => c.enterBefore('w012'));
    act(net, () => a.remove('w030 '));
    act(net, () => net.offline(b));
    act(net, () => a.enterBefore('w016'));
    act(net, () => a.joinAt('w031'));
    act(net, () => net.offline(a));
    act(net, () => net.offline(c));
    act(net, () => c.enterBefore('w029'));
    act(net, () => net.online(a, 'server-first'));
    act(net, () => net.online(b, 'peer-first'));
    act(net, () => a.joinAt('w012'));
    act(net, () => b.enterBefore('w016'));
    act(net, () => b.typeBefore('w021', 'Tb9 '));
    // replay() reconnects any author still offline before checking convergence.
    act(net, () => net.online(c));
    const final = net.converged().join(' '), got = final.split(/[\s$]+/);
    let last = -1;
    for (let i = 1; i <= 37; i++) {
      const word = `w${String(i).padStart(3, '0')}`;
      if (i === 30) { expect(got).not.toContain(word); continue; }
      expect(got.filter(value => value === word), word).toHaveLength(1);
      const at = got.indexOf(word);
      expect(at, word).toBeGreaterThan(last); last = at;
    }
    expect(got.filter(value => value === 'Tb9')).toHaveLength(1);
    expect(final).toContain('w020 Tb9 w021');
    expect(final.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
    for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(`$${formula}$`));
      expect(final.indexOf(`$${formula}$`)).toBeLessThan(final.indexOf(right));
    }
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

it('a joined prefix and its formula remain before a concurrently split following interval', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  try {
    // Exact targeted seed72 shrink, preserving both synchronizations and the final stale split.
    act(net, () => b.joinAt('w020'));
    act(net, () => a.typeBefore('w012', 'Ta2 '));
    act(net, () => net.flush());
    act(net, () => b.joinAt('w030'));
    act(net, () => b.enterBefore('Ta2'));
    act(net, () => net.flush());
    act(net, () => a.typeBefore('Ta2', 'Ta6 '));
    act(net, () => a.joinAt('Ta6'));
    act(net, () => b.enterBefore('w019'));
    const final = net.converged().join(' '), got = final.split(/[\s$]+/);
    for (let i = 1; i <= 37; i++) {
      const word = `w${String(i).padStart(3, '0')}`;
      expect(got.filter(value => value === word), word).toHaveLength(1);
    }
    for (const typed of ['Ta2', 'Ta6']) expect(got.filter(value => value === typed), typed).toHaveLength(1);
    expect(final).toContain('w011 Ta6 Ta2 w012');
    for (const formula of ['a+b', 'c', 'x^2']) expect(final.match(/\$([^$]+)\$/g)?.filter(value => value === `$${formula}$`), formula).toHaveLength(1);
    let last = -1;
    for (let i = 1; i <= 37; i++) {
      const word = `w${String(i).padStart(3, '0')}`, at = got.indexOf(word);
      expect(at, word).toBeGreaterThan(last); last = at;
    }
    expect(final.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
    for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(`$${formula}$`));
      expect(final.indexOf(`$${formula}$`)).toBeLessThan(final.indexOf(right));
    }
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

it('joining a split paragraph follows the prior original word after a concurrent split of its predecessor', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  try {
    // Exact targeted seed1037 shrink; receiving B's inbox must not send its unsent join.
    act(net, () => b.joinAt('w020'));
    act(net, () => c.enterBefore('w013'));
    act(net, () => net.offline(c));
    act(net, () => net.receive(b));
    act(net, () => c.enterBefore('w008'));
    act(net, () => b.joinAt('w013'));
    act(net, () => net.online(c));
    const final = net.converged().join(' '), got = final.split(/[\s$]+/);
    for (let i = 1; i <= 37; i++) {
      const word = `w${String(i).padStart(3, '0')}`;
      expect(got.filter(value => value === word), word).toHaveLength(1);
    }
    expect(final.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
    for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(`$${formula}$`));
      expect(final.indexOf(`$${formula}$`)).toBeLessThan(final.indexOf(right));
    }
    let last = -1;
    for (let i = 1; i <= 37; i++) {
      const word = `w${String(i).padStart(3, '0')}`, at = got.indexOf(word);
      expect(at, word).toBeGreaterThan(last); last = at;
    }
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

it('a split after a formula-led word keeps that word before the next joined paragraph suffix', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
  try {
    // Exact eight-operation targeted seed1004 minimum for w015 before w016.
    act(net, () => a.joinAt('w020'));
    act(net, () => c.enterBefore('w012'));
    act(net, () => a.remove('w030 '));
    act(net, () => a.enterBefore('w016'));
    act(net, () => a.joinAt('w031'));
    act(net, () => net.flush());
    act(net, () => a.joinAt('w012'));
    act(net, () => b.enterBefore('w016'));
    const final = net.converged().join(' '), got = final.split(/[\s$]+/);
    for (let i = 1; i <= 37; i++) {
      const word = `w${String(i).padStart(3, '0')}`;
      if (i === 30) { expect(got).not.toContain(word); continue; }
      expect(got.filter(value => value === word), word).toHaveLength(1);
    }
    for (const formula of ['a+b', 'c', 'x^2']) expect(final.match(/\$([^$]+)\$/g)?.filter(value => value === `$${formula}$`), formula).toHaveLength(1);
    expect(got.indexOf('w015'), 'w015 before w016').toBeLessThan(got.indexOf('w016'));
    let last = -1;
    for (let i = 1; i <= 37; i++) {
      if (i === 30) continue;
      const word = `w${String(i).padStart(3, '0')}`, at = got.indexOf(word);
      expect(at, word).toBeGreaterThan(last); last = at;
    }
    expect(final.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
    for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(`$${formula}$`));
      expect(final.indexOf(`$${formula}$`)).toBeLessThan(final.indexOf(right));
    }
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});

it('a joined paragraph remains before its anchored empty sibling and split suffix', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  try {
    // Exact seven-operation targeted seed74 minimum; the first Enter creates an empty sibling.
    act(net, () => a.joinAt('w020'));
    act(net, () => b.enterBefore('w020'));
    act(net, () => b.joinAt('w030'));
    act(net, () => b.enterBefore('w018'));
    act(net, () => a.joinAt('w030'));
    act(net, () => net.flush());
    act(net, () => b.enterBefore('w018'));
    const paragraphs = net.converged(), final = paragraphs.join(' '), got = final.split(/[\s$]+/);
    expect(paragraphs.some(paragraph => paragraph.trim() === ''), 'authored empty paragraph survives').toBe(true);
    for (let i = 1; i <= 37; i++) {
      const word = `w${String(i).padStart(3, '0')}`;
      expect(got.filter(value => value === word), word).toHaveLength(1);
    }
    for (const formula of ['a+b', 'c', 'x^2']) expect(final.match(/\$([^$]+)\$/g)?.filter(value => value === `$${formula}$`), formula).toHaveLength(1);
    expect(got.indexOf('w017'), 'w017 before w018').toBeLessThan(got.indexOf('w018'));
    let last = -1;
    for (let i = 1; i <= 37; i++) {
      const word = `w${String(i).padStart(3, '0')}`, at = got.indexOf(word);
      expect(at, word).toBeGreaterThan(last); last = at;
    }
    expect(final.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
    for (const [left, formula, right] of [['w006', 'a+b', 'w007'], ['w014', 'c', 'w015'], ['w033', 'x^2', 'w034']]) {
      expect(final.indexOf(left)).toBeLessThan(final.indexOf(`$${formula}$`));
      expect(final.indexOf(`$${formula}$`)).toBeLessThan(final.indexOf(right));
    }
  } finally {
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});


for (const pendingMoves of [false, true]) {
  it(`a copied inline formula follows its repaired predecessor within the same paragraph (seed1020, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    const canonical: string[][] = [];
    net.server.on('afterTransaction', tr => {
      const changed = tr.changed.get(net.server.getMap('moves'));
      if (changed && [...changed].some(key => typeof key === 'string' && key.startsWith('s'))) {
        canonical.push(parsOf(yXmlFragmentToProseMirrorRootNode(net.server.getXmlFragment('prosemirror'), schema)));
      }
    });
    const ordered = (paragraphs: string[]) => {
      const all = paragraphs.join(' ').replace(/\s+/g, ' '), tokens = all.split(/[\s$]+/);
      let last = -1;
      for (let i = 1; i <= 37; i++) {
        const word = `w${String(i).padStart(3, '0')}`;
        expect(tokens.filter(token => token === word), word).toHaveLength(1);
        const at = tokens.indexOf(word);
        expect(at, word).toBeGreaterThan(last); last = at;
      }
      expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
      expect(all).toContain('w006 $a+b$ w007');
      expect(all).toContain('w014 $c$ w015');
      expect(all).toContain('w033 $x^2$ w034');
    };
    try {
      // Exact seven-action captured minimum, retaining the flush and C's send.
      act(net, () => c.joinAt('w030'));
      act(net, () => c.enterBefore('w016'));
      act(net, () => net.flush());
      act(net, () => c.enterBefore('w028'));
      act(net, () => net.send(c));
      act(net, () => b.joinAt('w020'));
      act(net, () => b.joinAt('w016'));
      expect(b.pars()).toHaveLength(1);
      ordered(b.pars());
      const final = net.converged();
      ordered(final);
      for (const peer of [a, b, c]) ordered(peer.pars());
      expect(canonical.length).toBeGreaterThanOrEqual(5);
      for (const response of canonical) ordered(response);
      for (const peer of [a, b, c]) expect(peer.pendingMoves?.waiting ?? false).toBe(false);
    } finally {
      for (const peer of net.peers) { peer.remoteUpdates?.destroy(); peer.pendingMoves?.destroy(); peer.view.destroy(); peer.ydoc.destroy(); }
      net.server.destroy();
    }
  });
}
