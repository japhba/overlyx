/**
 * Arrows typed in a slide's text as it is retyped (edit.ts): -> →, <- ←, --> ⟶, <-- ⟵, <-> ↔, <--> ⟷
 * — the documents' rule table (core/arrows.ts; the user, 7 Nov 2026, also for slides "even if undo
 * there takes back the whole word"). The arrow replaces the typed characters in the text being
 * retyped, so it reaches the page's source as the character with the next commit. Backspace right
 * after gives back the keys typed, and they stay as typed; Ctrl/⌘+Z undoes the whole retyping, as for
 * any typing on a slide. Not in code (code, pre, kbd, samp) nor in formulas (their chips take no
 * typing); while suggesting, the tracked typing (review.ts) is left as typed.
 */
import { arrowFor, ARROWS } from '@overlyx/core/arrows.ts';

/** the arrow made last: where it is, and the keys behind it (what Backspace gives back) */
interface Made { node: Text; from: number; to: number; typed: string; at: number }
let made: Made | null = null;
/** characters put back by Backspace: they never become an arrow again */
let kept: { node: Text; from: number; to: number } | null = null;

/** typing in the retyped text `root` (its input event): the characters before the caret made an arrow — it replaces them */
export function arrowInput(e: InputEvent, root: HTMLElement): void {
  // (any other typing since: Backspace no longer gives the keys back)
  const prev = made;
  made = null;
  if (e.inputType !== 'insertText' || (e.data !== '>' && e.data !== '-') || e.isComposing) return;
  const sel = getSelection();
  const node = sel?.anchorNode;
  if (!sel || !sel.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return;
  const text = node as Text, end = sel.anchorOffset;
  if (!text.parentElement || text.parentElement.closest('code, pre, kbd, samp, [contenteditable="false"]')) return;
  if (text.data[end - 1] !== e.data) return;
  const hit = arrowFor(text.data.slice(Math.max(0, end - 4), end - 1), e.data);
  if (!hit) return;
  const start = end - hit.length;
  if (kept && kept.node === text && start < kept.to && kept.from < end) return;
  // an arrow made from the one just made (← then - is ⟵): Backspace gives back all the keys
  const prior = text.data.slice(start, end);
  const typed = prev && prev.node === text && prev.from === start && prior.startsWith(text.data.slice(prev.from, prev.to)) ? prev.typed + prior.slice(prev.to - prev.from) : prior;
  text.replaceData(start, hit.length, hit.arrow);
  sel.collapse(text, start + hit.arrow.length);
  made = { node: text, from: start, to: start + hit.arrow.length, typed, at: Date.now() };
}

/** Backspace right after an arrow was made in `root`: the typed keys back (they then stay). True when it did. */
export function arrowBackspace(root: HTMLElement): boolean {
  const m = made, sel = getSelection();
  if (!m || Date.now() - m.at > 10000 || !sel?.isCollapsed || sel.anchorNode !== m.node || sel.anchorOffset !== m.to || !root.contains(m.node)) return false;
  if (!ARROWS.has(m.node.data.slice(m.from, m.to))) return false;
  m.node.replaceData(m.from, m.to - m.from, m.typed);
  sel.collapse(m.node, m.from + m.typed.length);
  kept = { node: m.node, from: m.from, to: m.from + m.typed.length };
  made = null;
  return true;
}
