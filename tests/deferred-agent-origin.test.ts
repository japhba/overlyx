import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { PendingMoves } from '../packages/core/src/pendingmoves';
import { encodeRecord, MOVES_MAP } from '../packages/core/src/moves';
import { RemoteUpdates } from '../packages/client/src/editor/remoteupdates';

const record = (server: boolean, adopt: string[]) => encodeRecord({ t: 1, server, size: 0, protect: [], entries: [], adopt });

it('flushes a deferred agent after its remote dependency with an undo-tracked origin', () => {
  const server = new Y.Doc(), agent = new Y.Doc(), client = new Y.Doc();
  server.clientID = 1; agent.clientID = 3; client.clientID = 100;
  const REMOTE = Symbol('provider'), AGENT = 'agent-edit';
  server.getText('text').insert(0, 'X');
  const base = Y.encodeStateAsUpdate(server);
  Y.applyUpdate(client, base, REMOTE); Y.applyUpdate(agent, base, REMOTE);
  const moves = new PendingMoves(client); moves.enable();
  const beforeApply = vi.fn();
  const updates = new RemoteUpdates(client, moves, REMOTE, AGENT, beforeApply);
  const text = client.getText('text');
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([AGENT]) });
  const integrated: { origin: unknown; text: string }[] = [];
  client.on('afterTransaction', tr => { if (tr.changed.has(text)) integrated.push({ origin: tr.origin, text: text.toString() }); });
  try {
    const own = 'c100-pending';
    client.getMap(MOVES_MAP).set(own, record(false, []));
    expect(moves.waiting).toBe(true);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client), 'upload');
    expect(updates.receive(Y.encodeStateAsUpdate(server, Y.encodeStateVector(client)))).toBe(false);

    // Remote C is received first, but held while the local move awaits repair.
    const beforeC = Y.encodeStateVector(server);
    server.getText('text').insert(1, 'C');
    const cUpdate = Y.encodeStateAsUpdate(server, beforeC);
    expect(updates.receive(cUpdate)).toBe(false);
    Y.applyUpdate(agent, cUpdate, REMOTE);

    // The actual wire pattern: an agent insertion anchored to C, followed by
    // the same bytes as an ordinary sync update. A needs C to integrate.
    const beforeA = Y.encodeStateVector(agent);
    agent.getText('text').insert(2, 'A');
    const agentUpdate = Y.encodeStateAsUpdate(agent, beforeA);
    updates.receiveAgent(agentUpdate);
    expect(updates.receive(agentUpdate)).toBe(false);
    expect(text.toString()).toBe('X');
    expect(undo.undoStack).toHaveLength(0);
    expect(integrated).toEqual([]);
    expect(beforeApply).not.toHaveBeenCalled();

    Y.applyUpdate(server, agentUpdate, 'agent');
    const beforeAck = Y.encodeStateVector(server);
    server.getMap(MOVES_MAP).delete(own);
    server.getMap(MOVES_MAP).set('s00000001', record(true, [own]));
    expect(updates.receive(Y.encodeStateAsUpdate(server, beforeAck))).toBe(true);
    expect(moves.waiting).toBe(false);
    expect(beforeApply).toHaveBeenCalledTimes(1);
    expect(text.toString()).toBe('XCA');
    expect(client.store.pendingStructs).toBeNull();
    expect(client.getMap(MOVES_MAP).has(own)).toBe(false);
    expect(client.getMap(MOVES_MAP).has('s00000001')).toBe(true);
    expect(integrated).toEqual([{ origin: REMOTE, text: 'XC' }, { origin: AGENT, text: 'XCA' }]);
    expect(undo.undoStack).toHaveLength(1);

    undo.undo();
    expect(text.toString()).toBe('XC');
    expect(undo.undoStack).toHaveLength(0);
    expect(undo.redoStack).toHaveLength(1);
    undo.redo();
    expect(text.toString()).toBe('XCA');
    expect(undo.undoStack).toHaveLength(1);
    expect(beforeApply).toHaveBeenCalledTimes(1);
  } finally {
    updates.destroy(); moves.destroy(); undo.destroy();
    server.destroy(); agent.destroy(); client.destroy();
  }
});
