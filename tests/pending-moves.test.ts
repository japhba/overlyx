import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { PendingMoves } from '../packages/core/src/pendingmoves';
import { encodeRecord, MOVES_MAP } from '../packages/core/src/moves';

const record = (server: boolean, adopt: string[]) => encodeRecord({ t: 1, server, size: 0, protect: [], entries: [], adopt });
function fixture(pruned = false) {
  const server = new Y.Doc(), client = new Y.Doc();
  server.clientID = 1; client.clientID = 100;
  const moves = server.getMap(MOVES_MAP);
  if (pruned) { moves.set('s00000001', record(true, [])); moves.delete('s00000001'); }
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server), 'remote');
  const helper = new PendingMoves(client); helper.enable();
  const own = (suffix: string) => {
    const key = `c100-${suffix}`;
    client.getMap(MOVES_MAP).set(key, record(false, []));
    return key;
  };
  const upload = () => Y.applyUpdate(server, Y.encodeStateAsUpdate(client), 'client');
  const diff = () => Y.encodeStateAsUpdate(server, Y.encodeStateVector(client));
  const close = () => { helper.destroy(); server.destroy(); client.destroy(); };
  return { server, client, moves, helper, own, upload, diff, close };
}

it('waits for canonical adoption rather than the raw local move echo', () => {
  const f = fixture();
  try {
    const key = f.own('raw'); f.upload();
    expect(f.helper.receive(f.diff())).toBeUndefined();
    expect(f.helper.waiting).toBe(true);
    f.moves.delete(key); f.moves.set('s00000001', record(true, [key]));
    const accepted = f.helper.receive(f.diff());
    expect(accepted).toBeDefined(); expect(f.helper.waiting).toBe(false);
    Y.applyUpdate(f.client, accepted!, 'remote');
    expect(f.client.getMap(MOVES_MAP).has(key)).toBe(false);
  } finally { f.close(); }
});

it('resolves a reused canonical repair key through its deleted predecessor in the document', () => {
  const f = fixture(true);
  try {
    const key = f.own('reused'); f.upload();
    f.moves.delete(key); f.moves.set('s00000001', record(true, [key]));
    const bytes = f.diff();
    const wire = Y.decodeUpdate(bytes).structs.find(struct => struct instanceof Y.Item && struct.content instanceof Y.ContentBinary) as Y.Item;
    expect(wire.origin).not.toBeNull();
    expect(wire.parent).toBeNull(); expect(wire.parentSub).toBeNull();
    const accepted = f.helper.receive(bytes);
    expect(accepted).toBeDefined(); expect(f.helper.waiting).toBe(false);
    Y.applyUpdate(f.client, accepted!, 'remote');
    expect(f.client.getMap(MOVES_MAP).has(key)).toBe(false);
    expect(f.client.getMap(MOVES_MAP).has('s00000001')).toBe(true);
  } finally { f.close(); }
});

it('resolves a reused canonical repair key through prior metadata still queued behind another move', () => {
  const f = fixture();
  try {
    const first = f.own('first'), second = f.own('second'); f.upload();
    f.moves.delete(first); f.moves.set('s00000001', record(true, [first]));
    const beforeReuse = f.diff();
    expect(f.helper.receive(beforeReuse)).toBeUndefined();
    expect(f.client.getMap(MOVES_MAP).has('s00000001')).toBe(false);
    f.moves.delete('s00000001');
    // A later packet omits the first packet's structs, as a websocket live update does.
    const previous = Y.encodeStateVector(f.server);
    f.moves.delete(second); f.moves.set('s00000001', record(true, [second]));
    const reused = Y.encodeStateAsUpdate(f.server, previous);
    const wire = Y.decodeUpdate(reused).structs.find(struct => struct instanceof Y.Item && struct.content instanceof Y.ContentBinary) as Y.Item;
    expect(wire.parent).toBeNull(); expect(wire.parentSub).toBeNull();
    const accepted = f.helper.receive(reused);
    expect(accepted).toBeDefined(); expect(f.helper.waiting).toBe(false);
    Y.applyUpdate(f.client, accepted!, 'remote');
    expect(f.client.getMap(MOVES_MAP).has(first)).toBe(false);
    expect(f.client.getMap(MOVES_MAP).has(second)).toBe(false);
    expect(f.client.getMap(MOVES_MAP).has('s00000001')).toBe(true);
  } finally { f.close(); }
});

it('does not accept a same-named binary record in a different map as a move acknowledgment', () => {
  const f = fixture();
  try {
    const key = f.own('other-map'); f.upload();
    f.server.getMap('other').set('s00000001', record(true, [key]));
    expect(f.helper.receive(f.diff())).toBeUndefined();
    expect(f.helper.waiting).toBe(true);
    f.moves.delete(key); f.moves.set('s00000001', record(true, [key]));
    const accepted = f.helper.receive(f.diff());
    expect(accepted).toBeDefined(); expect(f.helper.waiting).toBe(false);
    Y.applyUpdate(f.client, accepted!, 'remote');
    expect(f.client.getMap('other').has('s00000001')).toBe(true);
  } finally { f.close(); }
});

it('accepts the exact own move tombstone when its canonical adopt record was pruned before reconnect', () => {
  const f = fixture();
  try {
    const key = f.own('pruned'); f.upload();
    f.moves.delete(key); f.moves.set('s00000001', record(true, [key])); f.moves.delete('s00000001');
    const bytes = f.diff();
    expect(Y.decodeUpdate(bytes).structs.some(item => item instanceof Y.Item && item.content instanceof Y.ContentBinary)).toBe(false);
    const accepted = f.helper.receive(bytes);
    expect(accepted).toBeDefined(); expect(f.helper.waiting).toBe(false);
    Y.applyUpdate(f.client, accepted!, 'remote');
    expect(f.client.getMap(MOVES_MAP).has(key)).toBe(false);
    expect(f.client.getMap(MOVES_MAP).has('s00000001')).toBe(false);
  } finally { f.close(); }
});

it('keeps waiting through a raw echo and unrelated same-client delete sets', () => {
  const f = fixture();
  try {
    const key = f.own('protected');
    f.client.getMap('other').set('c100-protected', record(false, []));
    f.client.getText('text').insert(0, 'coauthor content');
    f.upload();
    expect(f.helper.receive(f.diff())).toBeUndefined();
    expect(f.helper.waiting).toBe(true);
    f.server.getMap('other').delete('c100-protected'); f.server.getText('text').delete(0, 16);
    expect(f.helper.receive(f.diff())).toBeUndefined(); expect(f.helper.waiting).toBe(true);
    expect(f.client.getMap(MOVES_MAP).has(key)).toBe(true);
    expect(f.client.getText('text').toString()).toBe('coauthor content');
    f.moves.delete(key); f.moves.set('s00000001', record(true, [key]));
    const accepted = f.helper.receive(f.diff());
    expect(accepted).toBeDefined(); expect(f.helper.waiting).toBe(false);
    Y.applyUpdate(f.client, accepted!, 'remote');
    expect(f.client.getText('text').toString()).toBe('');
    expect(f.client.getMap('other').has('c100-protected')).toBe(false);
  } finally { f.close(); }
});

it('releases deferred updates only after every pending move has an exact tombstone or canonical adoption', () => {
  const f = fixture();
  try {
    const first = f.own('first'), second = f.own('second'); f.upload();
    f.server.getText('remote').insert(0, 'held content');
    f.moves.delete(first); f.moves.set('s00000001', record(true, [first])); f.moves.delete('s00000001');
    const firstBytes = f.diff(), beforeSecond = Y.encodeStateVector(f.server);
    expect(f.helper.receive(firstBytes)).toBeUndefined(); expect(f.helper.waiting).toBe(true);
    expect(f.client.getMap(MOVES_MAP).has(first)).toBe(true);
    expect(f.client.getText('remote').toString()).toBe('');
    f.moves.delete(second); f.moves.set('s00000002', record(true, [second]));
    const accepted = f.helper.receive(Y.encodeStateAsUpdate(f.server, beforeSecond));
    expect(accepted).toBeDefined(); expect(f.helper.waiting).toBe(false);
    Y.applyUpdate(f.client, accepted!, 'remote');
    expect(f.client.getMap(MOVES_MAP).has(first)).toBe(false);
    expect(f.client.getMap(MOVES_MAP).has(second)).toBe(false);
    expect(f.client.getText('remote').toString()).toBe('held content');
  } finally { f.close(); }
});
