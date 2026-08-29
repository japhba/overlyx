/**
 * Cursor memory: where the user was in a document the last time it was open in this browser
 * (localStorage, per document), restored on the next load — like LyX's "cursor position on
 * reopen". Besides the offset, a bit of the paragraph text just before the cursor is kept so the
 * place can be found again when the document changed meanwhile (someone else edited it, git).
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';

export interface SavedCursor {
  /** document offset of the cursor (selection head) */
  pos: number;
  /** up to CTX_LEN characters of the paragraph before the cursor (non-text children as U+FFFC) */
  ctx: string;
}

const CTX_LEN = 40;
/** below this many characters of context, a text search would hit anywhere */
const MIN_SEARCH = 6;

const storageKey = (docId: string) => 'ol.cursor:' + docId;

/** the text of a textblock's direct children, positions aligned with the block's content offsets */
function flatText(block: PMNode): string {
  let s = '';
  block.forEach(ch => { s += ch.isText ? ch.text! : '￼'.repeat(ch.nodeSize); });
  return s;
}

export function cursorToSave(state: EditorState): SavedCursor {
  const $head = state.selection.$head;
  const ctx = $head.parent.isTextblock ? flatText($head.parent).slice(Math.max(0, $head.parentOffset - CTX_LEN), $head.parentOffset) : '';
  return { pos: $head.pos, ctx };
}

/**
 * Where a saved cursor points in `doc`: the same offset when the text before it still matches,
 * else the closest place in the document whose preceding text matches, else the offset itself
 * (clamped to the document).
 */
export function restoredCursorPos(doc: PMNode, saved: SavedCursor): number {
  const pos = Math.max(0, Math.min(saved.pos, doc.content.size));
  const ctx = saved.ctx;
  if (!ctx) return pos;
  try {
    const $p = doc.resolve(pos);
    if ($p.parent.isTextblock && flatText($p.parent).slice(0, $p.parentOffset).endsWith(ctx)) return pos;
  } catch { /* not a valid position: search */ }
  if (ctx.length < MIN_SEARCH) return pos;
  let best: number | null = null;
  doc.descendants((node, p) => {
    if (!node.isTextblock) return true;
    const t = flatText(node);
    for (let i = t.indexOf(ctx); i >= 0; i = t.indexOf(ctx, i + 1)) {
      const cand = p + 1 + i + ctx.length;
      if (best === null || Math.abs(cand - pos) < Math.abs(best - pos)) best = cand;
    }
    return false;
  });
  return best ?? pos;
}

export function readSavedCursor(docId: string): SavedCursor | null {
  try {
    const raw = localStorage.getItem(storageKey(docId));
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v?.pos === 'number' ? { pos: v.pos, ctx: typeof v.ctx === 'string' ? v.ctx : '' } : null;
  } catch { return null; }
}

export function writeSavedCursor(docId: string, state: EditorState): void {
  try { localStorage.setItem(storageKey(docId), JSON.stringify(cursorToSave(state))); } catch { /* storage full / disabled */ }
}
