// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { Net, par, text, math } from './yjs-net';
import { MoveRepair } from '../packages/server/src/moves';
import { MOVES_MAP, MOVES_ORIGIN, decodeRecord, encodeRecord, protectMoves } from '../packages/core/src/moves';

it('retains legacy copied runs in a worker-persisted state until offline typing reconnects', () => {
  const net = new Net({ type: 'doc', content: [
    par(text('alpha beta gamma delta epsilon zeta '), math('x'), text(' eta theta')),
    par(text('closing')),
  ] });
  const a = net.peer('a', 100), b = net.peer('b', 200);
  b.enterBefore('zeta'); net.flush();
  const records = net.server.getMap(MOVES_MAP);
  net.server.transact(() => {
    for (const [key, value] of records) {
      const record = decodeRecord(key, value)!;
      record.protect = record.protect.filter(id => Y.getItem(net.server.store, id).deleted);
      delete record.joined;
      records.set(key, encodeRecord(record));
    }
  }, MOVES_ORIGIN);
  net.restart();
  for (const peer of net.peers) net.online(peer);
  net.flush();

  // Production docworker.Mirror installs protectMoves before loading the
  // main-thread state and persists its own encoding, without MoveRepair.
  const mirror = new Y.Doc({ gc: true });
  protectMoves(mirror);
  Y.applyUpdate(mirror, Y.encodeStateAsUpdate(net.server));
  net.server.on('update', update => Y.applyUpdate(mirror, update));
  net.offline(b);
  b.typeBefore('zeta', 'LATE ');
  a.remove('zeta '); net.flush();
  net.offline(a);
  const persisted = Y.encodeStateAsUpdate(mirror);
  net.server.destroy();
  net.server = new Y.Doc({ gc: true });
  net.repair = new MoveRepair(net.server);
  Y.applyUpdate(net.server, persisted, 'db');
  net.server.on('update', update => { for (const peer of net.peers) if (peer.online) peer.inbox.push(update); });
  for (const peer of net.peers) net.online(peer);
  const final = net.converged().join(' ');
  expect(final).not.toContain('zeta');
  expect(final.match(/\bLATE\b/g) ?? []).toHaveLength(1);
  expect(final).toContain('alpha beta gamma delta epsilon');
  expect(final).toContain('eta theta');
  expect(final).toContain('closing');
  for (const peer of net.peers) { expect(peer.formulas()).toEqual(['x']); peer.view.destroy(); peer.ydoc.destroy(); }
  net.server.destroy(); mirror.destroy();
});
