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
