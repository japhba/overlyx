/**
 * What an editor tells the server when it connects (the websocket's query parameters): the document,
 * and for a .tex or markdown document the CRDT model it holds it in — the server syncs no editor of
 * an older model (server ws.ts). An HTML page (a Y.Text of the file) and a whiteboard (a Y.Map of
 * objects) have no model. Every editor connects with these, and so does the server's own check after
 * a start (server selfcheck.ts): a deck that sent no model was held for a day (20 Oct 2026).
 */
import { isHtmlPath } from '../html/deliverable.ts';
import { MODEL } from './model.ts';

/** whether the document is held in a CRDT model (core collab/model.ts): .tex and markdown */
export function hasModel(docId: string): boolean {
  return !docId.endsWith('.board') && !isHtmlPath(docId);
}

export function connectParams(docId: string): Record<string, string> {
  return hasModel(docId) ? { doc: docId, model: String(MODEL) } : { doc: docId };
}

/**
 * A refused connection (no session, no access to the document) used to be a bare HTTP status before
 * the upgrade, which a browser cannot read — close code 1006, as for a network failure — so the editor
 * retried for ever and said "offline". An editor that handles refusals (client editor/connection.ts)
 * asks for them as close codes with these parameters: the server then accepts the upgrade and closes
 * it at once with CLOSE_SIGNED_OUT or CLOSE_NO_ACCESS (server ws.ts). Both are in y-websocket's
 * 4400–4499 range, after which it stops reconnecting — so an editor that does not ask (a bundle from
 * before 28 Nov 2026 in an open tab, the whiteboard) keeps getting the bare status and retrying.
 */
export const REFUSAL_PARAMS: Readonly<Record<string, string>> = { refusal: 'close' };
export const CLOSE_SIGNED_OUT = 4401, CLOSE_NO_ACCESS = 4403;
export const wantsRefusalClose = (params: URLSearchParams): boolean => params.get('refusal') === 'close';
