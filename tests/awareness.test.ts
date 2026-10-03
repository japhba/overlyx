import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { sanitizeAwarenessState, isCursorState } from '../packages/core/src/awareness.ts';
import { sanitizeAwarenessUpdate } from '../packages/server/src/ws.ts';

const pos = (doc: Y.Doc) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(doc.getXmlFragment('prosemirror'), 0));

describe('awareness states are checked before other clients read them', () => {
  it('keeps a real y-prosemirror cursor and user', () => {
    const doc = new Y.Doc();
    const state = { user: { name: 'Ann', color: '#c00', username: 'ann', avatar: null }, cursor: { anchor: pos(doc), head: pos(doc) } };
    expect(isCursorState(state.cursor)).toBe(true);
    expect(sanitizeAwarenessState(state)).toBe(state);
  });

  it('turns a malformed cursor into null and drops a malformed user', () => {
    expect(sanitizeAwarenessState({ user: { name: 'Ann', color: '#c00' }, cursor: { para: 3, t: 1 } })).toEqual({ user: { name: 'Ann', color: '#c00' }, cursor: null });
    expect(sanitizeAwarenessState({ cursor: { anchor: {}, head: {} } })).toEqual({ cursor: null });
    expect(sanitizeAwarenessState({ cursor: { anchor: { item: { client: 'x', clock: 1 } }, head: { tname: 'prosemirror' } } })).toEqual({ cursor: null });
    expect(sanitizeAwarenessState({ user: 'Ann', ink: [1] })).toEqual({ ink: [1] });
    expect(sanitizeAwarenessState('nope')).toBeNull();
    expect(sanitizeAwarenessState([1, 2])).toBeNull();
  });

  it('the server relays a malformed cursor as null, keeps the rest, and never lets one client overwrite another', () => {
    const sender = new awarenessProtocol.Awareness(new Y.Doc());
    sender.setLocalState({ user: { name: 'bot', color: '#888' }, cursor: { para: 1, t: Date.now() } });
    const raw = awarenessProtocol.encodeAwarenessUpdate(sender, [sender.clientID]);
    const clean = sanitizeAwarenessUpdate(raw);
    expect(clean).not.toBeNull();
    const receiver = new awarenessProtocol.Awareness(new Y.Doc());
    awarenessProtocol.applyAwarenessUpdate(receiver, clean!, 'test');
    expect(receiver.getStates().get(sender.clientID)).toEqual({ user: { name: 'bot', color: '#888' }, cursor: null });
    // the same update claiming a client id that belongs to another connection is dropped
    expect(sanitizeAwarenessUpdate(raw, id => id === sender.clientID)).toBeNull();
    // garbage is ignored
    expect(sanitizeAwarenessUpdate(new Uint8Array([5, 1, 2]))).toBeNull();
  });
});
