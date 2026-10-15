// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { Net, par, text, math } from './yjs-net';

const words = (n: number, from: number) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(6, 1) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
  par(text(words(10, 20) + ' ')),
  par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
] };

function ordered(paragraphs: string[], typed?: { word: string; left: string; right: string }) {
  const all = paragraphs.join(' '), tokens = all.split(/[\s$]+/);
  for (let i = 1; i <= 37; i++) {
    const word = `w${String(i).padStart(3, '0')}`;
    expect(tokens.filter(token => token === word), word).toHaveLength(1);
    if (i > 1) expect(tokens.indexOf(`w${String(i - 1).padStart(3, '0')}`)).toBeLessThan(tokens.indexOf(word));
  }
  expect(all.match(/\$([^$]+)\$/g)).toEqual(['$a+b$', '$c$', '$x^2$']);
  expect(all).toContain('w006 $a+b$ w007');
  expect(all).toContain('w014 $c$ w015');
  expect(all).toContain('w033 $x^2$ w034');
  if (typed) {
    expect(tokens.filter(token => token === typed.word)).toHaveLength(1);
    expect(all).toContain(`${typed.left} ${typed.word} ${typed.right}`);
  }
}

function close(net: Net) {
  for (const peer of net.peers) { peer.pendingMoves?.destroy(); peer.view.destroy(); peer.ydoc.destroy(); }
  net.server.destroy();
}

for (const pendingMoves of [false, true]) {
  it(`retains typing copied before a stale join recovers a split suffix (seed26, pending=${pendingMoves})`, () => {
    const net = new Net(content, { pendingMoves }), a = net.peer('a', 100), b = net.peer('b', 200);
    const typed = { word: 'Tb3', left: 'w028', right: 'w029' };
    try {
      // The captured minimal seed26 history; no delivery occurs between actions.
      b.typeBefore('w029', 'Tb3 ');
      ordered(b.pars(), typed); ordered(a.pars());
      a.enterBefore('w024');
      ordered(a.pars()); ordered(b.pars(), typed);
      b.joinAt('w030');
      ordered(b.pars(), typed); ordered(a.pars());
      const final = net.converged();
      ordered(final, typed);
      for (const peer of [a, b]) ordered(peer.pars(), typed);
      expect(a.pendingMoves?.waiting ?? false).toBe(false);
      expect(b.pendingMoves?.waiting ?? false).toBe(false);
    } finally { close(net); }
  });
}
