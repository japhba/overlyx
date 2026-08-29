/**
 * Where the editor's cursor is in the generated LaTeX source (source pane): pure text matching,
 * so it can be tested without a browser. The paragraph text right before (or, at a paragraph
 * start, after) the cursor is searched in the source with newlines flattened to spaces (the file
 * may break lines anywhere inside a paragraph); characters the LaTeX writer escapes or rewrites
 * (& % $ # _ { } ~ ^ \ quotes, dashes, formulas...) end the usable text, and the phrase is
 * shortened word by word until it is found. Several occurrences: the one nearest to the
 * paragraph's own start, or to the previous position. Inside a formula the formula's current row
 * is searched instead.
 */

export interface CursorContext {
  /** paragraph text before the cursor; non-text children as a NUL character */
  before: string;
  /** paragraph text after the cursor */
  after: string;
  /** the paragraph's first words, to disambiguate repeated phrases (optional) */
  parStart?: string;
  /** the formula under the cursor: its LaTeX and the cursor's row (top-level cell row), when in math */
  formula?: { latex: string; row: number; display: boolean };
  /** the previously found source offset (a tie-breaker) */
  prev?: number | null;
}

/** characters that the writer does not emit verbatim: text after the last one is safe to search for */
const UNSAFE = /[^\p{L}\p{N}\s.,;:()?!]/gu;
const MAX_PHRASE = 48;
const MIN_PHRASE = 3;

const lineOf = (text: string, idx: number): number => { let n = 0; for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };

function occurrences(flat: string, phrase: string): number[] {
  const out: number[] = [];
  for (let i = flat.indexOf(phrase); i >= 0 && out.length < 50; i = flat.indexOf(phrase, i + 1)) out.push(i);
  return out;
}
const nearest = (cands: number[], to: number | null | undefined): number => to === null || to === undefined ? cands[0] : cands.reduce((a, b) => (Math.abs(b - to) < Math.abs(a - to) ? b : a));

/** the usable tail of `before` (after the last unsafe character), at most MAX_PHRASE chars, cut at a word boundary */
function safeTail(s: string): string {
  const parts = s.split(UNSAFE);
  let t = parts[parts.length - 1].replace(/\s+/g, ' ');
  if (t.length > MAX_PHRASE) { t = t.slice(-MAX_PHRASE); const sp = t.indexOf(' '); if (sp > 0) t = t.slice(sp + 1); }
  return t.replace(/^\s+/, '');
}
function safeHead(s: string): string {
  let t = s.split(UNSAFE)[0].replace(/\s+/g, ' ');
  if (t.length > MAX_PHRASE) { t = t.slice(0, MAX_PHRASE); const sp = t.lastIndexOf(' '); if (sp > 0) t = t.slice(0, sp); }
  return t.replace(/\s+$/, '');
}

/** phrases to try, longest first: the tail with leading words dropped one by one */
function tailPhrases(tail: string): string[] {
  const out: string[] = [];
  let t = tail;
  while (t.length >= MIN_PHRASE) { out.push(t); const sp = t.indexOf(' '); if (sp < 0) break; t = t.slice(sp + 1); }
  return out;
}
function headPhrases(head: string): string[] {
  const out: string[] = [];
  let t = head;
  while (t.length >= MIN_PHRASE) { out.push(t); const sp = t.lastIndexOf(' '); if (sp < 0) break; t = t.slice(0, sp); }
  return out;
}

/** the source offset of the cursor (or null) */
export function findSourceOffset(text: string, ctx: CursorContext): number | null {
  const flat = text.replace(/\n/g, ' ');
  // an anchor: where the paragraph starts in the source (its first words), else the previous position
  let anchor: number | null | undefined = ctx.prev;
  if (ctx.parStart) {
    for (const p of headPhrases(safeHead(ctx.parStart))) { const occ = occurrences(flat, p); if (occ.length) { anchor = nearest(occ, ctx.prev); break; } }
  }
  if (ctx.formula) {
    const f = ctx.formula;
    const lines = f.latex.split('\n').map(s => s.trim()).filter(Boolean);
    // rows of a display formula: the lines between \begin{...} / \[ and \end{...} / \]
    const body = lines.length > 2 && /^(\\begin|\\\[)/.test(lines[0]) ? lines.slice(1, -1) : lines;
    const rowText = body[Math.min(Math.max(0, f.row), body.length - 1)] ?? '';
    const cands = f.display ? [rowText, ...body.filter(l => l !== rowText)] : [f.latex.trim()];
    for (const c of cands) {
      if (c.length < 2) continue;
      const needle = f.display ? c : '$' + c + '$';
      const occ = occurrences(flat, needle);
      if (occ.length) return nearest(occ, anchor) + (f.display ? 0 : 1);
      if (!f.display) { const o2 = occurrences(flat, c); if (o2.length) return nearest(o2, anchor); }
    }
  }
  for (const p of tailPhrases(safeTail(ctx.before))) { const occ = occurrences(flat, p); if (occ.length) return nearest(occ, anchor) + p.length; }
  for (const p of headPhrases(safeHead(ctx.after))) { const occ = occurrences(flat, p); if (occ.length) return nearest(occ, anchor); }
  return anchor ?? null;
}

export function findSourceLine(text: string, ctx: CursorContext): { line: number; offset: number } | null {
  const off = findSourceOffset(text, ctx);
  return off === null ? null : { line: lineOf(text, off), offset: off };
}
