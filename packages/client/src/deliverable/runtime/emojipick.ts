/**
 * Right-click on an emoji in the text being retyped (edit.ts onContextMenu): that emoji is selected
 * and named to the editor, whose menu shows it in each emoji font (editor/emoji/deck.ts) and sets the
 * one clicked in place of the selection.
 */
import { emojiAt } from '@overlyx/core/emojifonts.ts';

export function emojiAtPointer(host: HTMLElement, x: number, y: number): string | null {
  const d = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
  let node: Node | null = null, off = 0;
  if (typeof d.caretRangeFromPoint === 'function') { const r = d.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
  else if (typeof d.caretPositionFromPoint === 'function') { const p = d.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset; } }
  if (!node || node.nodeType !== Node.TEXT_NODE || !host.contains(node)) return null;
  const text = (node as Text).data;
  const hit = emojiAt(text, off) ?? (off > 0 ? emojiAt(text, off - 1) : null);
  if (!hit) return null;
  const range = document.createRange();
  range.setStart(node, hit[0]); range.setEnd(node, hit[1]);
  const sel = getSelection();
  sel?.removeAllRanges(); sel?.addRange(range);
  return text.slice(hit[0], hit[1]);
}
