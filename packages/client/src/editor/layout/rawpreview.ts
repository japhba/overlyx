/**
 * Raw LaTeX objects of layout pages are shown as their compiled image: the server typesets the
 * snippet with the document's own preamble on a page of the object's size (POST
 * /api/docs/:id/snippet → an SVG, cached by content). Where no server can (offline, the VS Code
 * extension without a TeX installation) the object stays blank. Its source is available outside
 * the canvas in the page's LaTeX inspector and the object's double-click editor.
 */
import type { EditorView } from 'prosemirror-view';
import { API_BASE } from '../../api';

const cache = new Map<string, Promise<string | null>>();

export function rawPreview(view: EditorView, latex: string, w: number, h: number): Promise<string | null> {
  const docId = view.dom.dataset.docId;
  if (!docId || !latex.trim() || typeof fetch === 'undefined') return Promise.resolve(null);
  const key = `${docId}\u0000${w.toFixed(1)}\u0000${h.toFixed(1)}\u0000${latex}`;
  let p = cache.get(key);
  if (!p) {
    p = fetch(`${API_BASE}/api/docs/${encodeURIComponent(docId)}/snippet`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latex, w, h }),
    }).then(async r => {
      if (!r.ok) return null;
      const j = await r.json() as { url?: string };
      return j.url ? API_BASE + j.url : null;
    }).catch(() => null);
    cache.set(key, p);
    // a failure is retried the next time (the server may have been busy)
    void p.then(u => { if (!u) cache.delete(key); });
  }
  return p;
}
