// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Net, par, text } from './yjs-net';
import { MOVES_MAP, decodeRecord, encodeRecord } from '../packages/core/src/moves';

it('proven native cut metadata expires with the move history it describes', () => {
  const net = new Net({ type: 'doc', content: [par(text('ALPHA BETA GAMMA '))] });
  const a = net.peer('a', 100);
  try {
    a.enterBefore('BETA');
    expect(net.converged().map(value => value.trim())).toEqual(['ALPHA', 'BETA GAMMA']);
    const cuts = net.server.getMap<unknown>('move-cuts');
    expect(cuts.size).toBeGreaterThan(0);
    const timestamps = [...cuts.values()].map(value => {
      expect(Array.isArray(value)).toBe(true);
      return (value as number[])[0];
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue((Math.max(...timestamps) + 31 * 86400) * 1000);
    try {
      net.repair!.prune();
      expect(cuts.size).toBe(0);
      expect(net.server.getMap('moves').size).toBe(0);
      expect(net.converged().map(value => value.trim())).toEqual(['ALPHA', 'BETA GAMMA']);
    } finally { clock.mockRestore(); }
  } finally {
    a.remoteUpdates?.destroy(); a.pendingMoves?.destroy(); a.view.destroy(); a.ydoc.destroy(); net.server.destroy();
  }
});

it('legacy native records preserve independent cuts and an intentional later join after restart', () => {
  const net = new Net({ type: 'doc', content: [par(text('ALPHA BETA GAMMA DELTA EPSILON ')), par(text('END '))] });
  const a = net.peer('a', 100);
  const exchangeLegacy = () => {
    const records = a.ydoc.getMap(MOVES_MAP);
    a.ydoc.transact(() => {
      for (const [key, value] of records) {
        if (!key.startsWith('c')) continue;
        const record = decodeRecord(key, value)!;
        delete record.joined;
        records.set(key, encodeRecord(record));
      }
    });
    // One old-client update reaches the server without the newer operation
    // marker ever being visible to its map observer.
    a.outbox = [Y.mergeUpdates(a.outbox)];
    net.flush();
  };
  try {
    a.enterBefore('BETA'); exchangeLegacy();
    a.enterBefore('DELTA'); exchangeLegacy();
    expect(net.converged().map(value => value.trim())).toEqual(['ALPHA', 'BETA GAMMA', 'DELTA EPSILON', 'END']);
    net.restart(); net.online(a); net.flush();
    a.joinAt('BETA'); exchangeLegacy();
    expect(net.converged().map(value => value.trim())).toEqual(['ALPHA BETA GAMMA', 'DELTA EPSILON', 'END']);
  } finally {
    a.remoteUpdates?.destroy(); a.pendingMoves?.destroy(); a.view.destroy(); a.ydoc.destroy(); net.server.destroy();
  }
});
