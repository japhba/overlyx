/**
 * Awareness (presence) states come from every client of a document — viewers included — and the
 * server relays them as they are. Code reading another client's state must not trust its shape: a
 * `cursor` that was not two Yjs relative positions made y-prosemirror's cursor plugin throw inside
 * the Yjs update handler, which left the receiving editor's binding out of step with the shared
 * document, and that editor's next keystroke saved a nearly empty document over the real one.
 * The server sanitizes every state before relaying it and the client sanitizes again before its
 * cursor plugin and presence list read it.
 */

/** Longest state (as JSON) that is relayed; margin ink streams strokes through awareness, so this is generous. */
export const MAX_AWARENESS_STATE_JSON = 256 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isId = (v: unknown): boolean => isObject(v) && isCount(v.client) && isCount(v.clock);

/** A `Y.RelativePosition` as `Y.relativePositionToJSON` writes it (and `Y.createRelativePositionFromJSON` reads it). */
export function isRelativePositionJSON(v: unknown): boolean {
  if (!isObject(v)) return false;
  if (v.type != null && !isId(v.type)) return false;
  if (v.item != null && !isId(v.item)) return false;
  if (v.tname != null && typeof v.tname !== 'string') return false;
  if (v.assoc != null && !Number.isSafeInteger(v.assoc)) return false;
  return v.type != null || v.item != null || v.tname != null;
}

/** y-prosemirror's cursor field: `{ anchor, head }`, both relative positions. */
export function isCursorState(v: unknown): boolean {
  return isObject(v) && isRelativePositionJSON(v.anchor) && isRelativePositionJSON(v.head);
}

function isUserState(v: unknown): boolean {
  return isObject(v) && typeof v.name === 'string' && typeof v.color === 'string'
    && (v.username == null || typeof v.username === 'string') && (v.avatar == null || typeof v.avatar === 'string');
}

/**
 * The state with the fields other clients read checked: a malformed `cursor` becomes null, a
 * malformed `user` is dropped (the client is then not listed as present). Anything that is not
 * an object is no state at all (null). Other fields pass unchanged.
 */
export function sanitizeAwarenessState(state: unknown): Record<string, unknown> | null {
  if (!isObject(state)) return null;
  let out = state;
  if (out.cursor != null && !isCursorState(out.cursor)) out = { ...out, cursor: null };
  if (out.user != null && !isUserState(out.user)) { out = { ...out }; delete out.user; }
  return out;
}
