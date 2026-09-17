/**
 * The source map of the source pane: the LaTeX writer records the character range of the .tex
 * text every top-level paragraph of the document was written to (`GET /tex?map=1`, core
 * `WriteTexResult.spans`). With it the pane knows *exactly* which paragraph a source offset
 * belongs to and where a paragraph starts in the source — cursor, selection and scrolling are
 * mirrored paragraph-exactly, and the word matching of sourcelocate.ts only has to find the
 * character *within* the paragraph, where a phrase cannot be confused with the same words
 * elsewhere in the document. While the user types in the source the spans are carried along
 * through the edits (`editRange` / `mapSpans`), so they stay valid until the next regeneration.
 * Pure text functions, tested without a browser.
 */
import { findSourceOffset, locateSourceCaret, type CursorContext, type LocateBlock } from './sourcelocate';

/** a top-level paragraph's range in the source text (null: the paragraph produced no output) */
export type Span = { start: number; end: number } | null;

export const lineOfOffset = (text: string, off: number): number => { let n = 0; const end = Math.min(off, text.length); for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) n++; return n; };
export const lineStart = (text: string, off: number): number => text.lastIndexOf('\n', Math.max(0, off - 1)) + 1;
/** the offset of the first character of line `line` (0-based; past the end: the text length) */
export function offsetOfLine(text: string, line: number): number {
  let off = 0;
  for (let n = 0; n < line; n++) { const nl = text.indexOf('\n', off); if (nl < 0) return text.length; off = nl + 1; }
  return off;
}

/** whether `spans` can describe a document with `childCount` top-level paragraphs */
export const spansFit = (spans: Span[] | null | undefined, childCount: number): spans is Span[] => !!spans && spans.length === childCount;

/**
 * The top-level paragraph a source offset belongs to: the one whose span contains it; in the gap
 * between two paragraphs (blank lines, `\begin{itemize}` / `\end{itemize}` lines) the following
 * paragraph when the offset's line begins an environment or is the line the next paragraph
 * starts on, else the preceding one. Before the first span: the first paragraph with a span;
 * after the last: the last. -1 when no paragraph has a span.
 */
export function spanIndexAt(spans: Span[], offset: number, text: string): number {
  let prev = -1, next = -1;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (!s) continue;
    if (offset >= s.start && offset <= s.end) return i;
    if (s.end < offset) prev = i;
    else if (next < 0) { next = i; break; }
  }
  if (prev < 0) return next;
  if (next < 0) return prev;
  const ls = lineStart(text, offset);
  const nextStart = spans[next]!.start;
  if (lineStart(text, nextStart) === ls) return next;
  if (/^\s*\\begin\b/.test(text.slice(ls, Math.min(nextStart, ls + 40)))) return next;
  return prev;
}

/** the position range the top-level paragraph `index` occupies: the spans' own text */
export const spanText = (text: string, span: { start: number; end: number }): string => text.slice(span.start, span.end);

/** The region two versions of a text differ in (common prefix / suffix); null when they are equal. */
export interface EditRange { from: number; oldTo: number; newTo: number }
export function editRange(oldText: string, newText: string): EditRange | null {
  if (oldText === newText) return null;
  const n = Math.min(oldText.length, newText.length);
  let from = 0;
  while (from < n && oldText.charCodeAt(from) === newText.charCodeAt(from)) from++;
  let suffix = 0;
  while (suffix < n - from && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)) suffix++;
  return { from, oldTo: oldText.length - suffix, newTo: newText.length - suffix };
}

/** An offset of the old text in the new one: unchanged before the edit, shifted after it, inside it clamped to the edit's start (`toEnd`: its end). */
export function mapOffset(off: number, e: EditRange | null, toEnd = false): number {
  if (!e) return off;
  if (off < e.from) return off;
  if (off > e.oldTo) return off + (e.newTo - e.oldTo);
  return toEnd ? e.newTo : e.from;
}

/**
 * The spans after an edit of the text: what was typed at the end of a paragraph (or inside it)
 * becomes part of it, what was typed right before a paragraph stays outside; a paragraph the edit
 * swallowed collapses to the edit's start.
 */
export function mapSpans(spans: Span[], e: EditRange | null): Span[] {
  if (!e) return spans;
  const delta = e.newTo - e.oldTo;
  return spans.map(s => {
    if (!s) return s;
    let start: number, end: number;
    if (s.start < e.from) start = s.start;
    else if (s.start >= e.oldTo) start = s.start + delta;
    else start = e.from;
    if (s.end < e.from) end = s.end;
    else if (s.end > e.oldTo) end = s.end + delta;
    else end = e.newTo;   // the edit touched the paragraph's end: it grows (or shrinks) with it
    return end < start ? { start, end: start } : { start, end };
  });
}

/**
 * The source offset of a document cursor whose top-level paragraph has span `span`: the words
 * before it (sourcelocate.ts) are searched within that paragraph's source only; when they are not
 * found there the paragraph's start. Always inside the span.
 */
export function sourceOffsetInSpan(text: string, span: { start: number; end: number }, ctx: CursorContext): number {
  const sub = spanText(text, span);
  const prev = ctx.prev === null || ctx.prev === undefined ? null : Math.max(0, Math.min(sub.length, ctx.prev - span.start));
  const off = findSourceOffset(sub, { ...ctx, prev });
  if (off === null) return span.start;
  return span.start + Math.max(0, Math.min(sub.length, off));
}

/**
 * The block (paragraph / formula) and character offset a source offset within `span` refers to,
 * among the blocks of that top-level paragraph: the words of the line before the caret, matched
 * inside the paragraph only. The first block at its start when the line has no usable words
 * (`\begin{align}`, `\item` alone, an empty line).
 */
export function locateInSpan(text: string, span: { start: number; end: number }, offset: number, blocks: LocateBlock[]): { index: number; offset: number } {
  if (!blocks.length) return { index: 0, offset: 0 };
  const sub = spanText(text, span);
  const rel = Math.max(0, Math.min(sub.length, offset - span.start));
  const line = lineOfOffset(sub, rel);
  const col = rel - lineStart(sub, rel);
  return locateSourceCaret(sub, line, col, blocks) ?? { index: 0, offset: 0 };
}

/**
 * The first brace that has no partner (comments and escaped braces skipped): its offset, or -1
 * when the braces balance — for telling the user where an unbalanced source goes wrong.
 */
export function unbalancedBraceAt(text: string, mask: Uint8Array): number {
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) continue;
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') stack.push(i);
    else if (c === '}') { if (!stack.length) return i; stack.pop(); }
  }
  return stack.length ? stack[0] : -1;
}
