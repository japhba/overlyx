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

/* ------------------------------------------------------------ the other direction: a source line → the document */

/** A block of the document as the locator sees it: a paragraph's text (non-text children as NUL) or a display formula's LaTeX. */
export interface LocateBlock { kind: 'text' | 'math'; text: string }

/** LaTeX of a source line reduced to the words the editor shows: commands, braces, labels, citations and formulas removed. */
export function plainWords(latex: string): string {
  return latex
    .replace(/(^|[^\\])%.*$/, '$1')
    .replace(/\\([%&$#_{}])/g, '$1')
    .replace(/\\ /g, ' ')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/\\(label|ref|eqref|cite[a-z]*|includegraphics|caption|footnote)\*?(\[[^\]]*\])?\{[^}]*\}/g, ' ')
    .replace(/\\[A-Za-z]+\*?(\[[^\]]*\])?/g, ' ')
    .replace(/[{}~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Where source line `line` (0-based) of `text` is in the document: the block with the longest
 * phrase of the line's words (a formula line is looked for in the display formulas' LaTeX). The
 * lines right after an empty or command-only line are tried too (a paragraph that starts on the
 * next line). Returns the block index and the offset of the phrase in it, or null.
 */
export function locateSourceLine(text: string, line: number, blocks: LocateBlock[]): { index: number; offset: number } | null {
  const lines = text.split('\n');
  const tryLine = (n: number): { index: number; offset: number } | null => {
    const raw = lines[n] ?? '';
    // a formula row: match the display formulas' LaTeX
    const row = raw.trim().replace(/\\\\$/, '').replace(/\\label\{[^}]*\}/g, '').trim();
    if (row.length >= 3 && /[\\^_=]/.test(row) && !/^\\(begin|end|section|subsection|item|caption|label)/.test(row)) {
      for (let i = 0; i < blocks.length; i++) if (blocks[i].kind === 'math' && blocks[i].text.includes(row)) return { index: i, offset: 0 };
    }
    const words = plainWords(raw);
    if (words.length < MIN_PHRASE) return null;
    const flatBlocks = blocks.map(b => (b.kind === 'text' ? b.text.replace(/\s+/g, ' ') : ''));
    const phrases = [...headPhrases(words.slice(0, MAX_PHRASE)), ...tailPhrases(words.slice(-MAX_PHRASE))].filter(p => p.length >= 4);
    // the block that *is* the line (a heading), then one that begins with its words (a paragraph's
    // first line), then one containing them — a short phrase such as a section title also occurs
    // inside other paragraphs
    const bare = flatBlocks.map(b => b.replace(/\u0000/g, '').trim());
    const boundary = (b: string, p: string) => !/[\p{L}\p{N}]/u.test(b.charAt(p.length));
    for (const p of phrases) {
      for (let i = 0; i < bare.length; i++) if (bare[i] === p) return { index: i, offset: 0 };
      for (let i = 0; i < bare.length; i++) if (bare[i].startsWith(p) && boundary(bare[i], p)) return { index: i, offset: 0 };
      if (p.length < 16) continue;   // a short phrase found *inside* a paragraph is no evidence — unless nothing longer matches
      for (let i = 0; i < flatBlocks.length; i++) { const at = flatBlocks[i].indexOf(p); if (at >= 0) return { index: i, offset: at }; }
    }
    for (const p of phrases) for (let i = 0; i < flatBlocks.length; i++) { const at = flatBlocks[i].indexOf(p); if (at >= 0) return { index: i, offset: at }; }
    return null;
  };
  for (let n = line; n < Math.min(lines.length, line + 4); n++) { const r = tryLine(n); if (r) return r; }
  return null;
}

/**
 * The caret of the source text (line + column, 0-based) → the block and the character offset in
 * it: the block by `locateSourceLine`, the offset by the words of the line before the column
 * (the longest tail of them that occurs in the block, nearest to where the line starts in it).
 * Formula blocks give offset 0 (the formula as a whole). Null when the line is not in the document.
 */
export function locateSourceCaret(text: string, line: number, col: number, blocks: LocateBlock[]): { index: number; offset: number } | null {
  const hit = locateSourceLine(text, line, blocks);
  if (!hit) return null;
  const b = blocks[hit.index];
  if (b.kind === 'math') return { index: hit.index, offset: 0 };
  const raw = (text.split('\n')[line] ?? '');
  const before = plainWords(raw.slice(0, col));
  const trailing = /\s$/.test(raw.slice(0, col));   // the caret stands after a space: the phrase ends at a word
  if (!before) return hit;
  let tail = before.length > MAX_PHRASE ? before.slice(-MAX_PHRASE) : before;
  if (tail.length === MAX_PHRASE) { const sp = tail.indexOf(' '); if (sp > 0) tail = tail.slice(sp + 1); }
  const inBlock = (p: string): number[] => occurrences(b.text, p);
  for (const p of tailPhrases(tail)) {
    const occ = inBlock(p);
    if (!occ.length) continue;
    const at = nearest(occ, hit.offset);
    let off = at + p.length;
    if (trailing && b.text.charAt(off) === ' ') off++;
    return { index: hit.index, offset: Math.min(off, b.text.length) };
  }
  return hit;
}
