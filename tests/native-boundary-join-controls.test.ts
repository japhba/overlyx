// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { Net, par, text } from './yjs-net';
for (const batched of [false, true]) for (const pendingMoves of [false, true]) it(`joining a middle paragraph intentionally removes its earlier cut after another split (pending ${pendingMoves}, batched ${batched})`, () => {
  const net = new Net({ type: 'doc', content: [par(text('ALPHA BETA GAMMA DELTA EPSILON ')), par(text('END '))] }, { pendingMoves });
  const a = net.peer('a', 100);
  try {
    a.enterBefore('BETA'); if (!batched) net.flush();
    a.enterBefore('DELTA'); if (!batched) net.flush();
    expect(a.pars().map(value => value.trim())).toEqual(['ALPHA', 'BETA GAMMA', 'DELTA EPSILON', 'END']);
    a.joinAt('BETA');
    expect(net.converged().map(value => value.trim())).toEqual(['ALPHA BETA GAMMA', 'DELTA EPSILON', 'END']);
  } finally {
    a.view.destroy(); a.ydoc.destroy(); net.server.destroy();
  }
});
