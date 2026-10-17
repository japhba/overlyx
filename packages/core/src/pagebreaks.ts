/**
 * Where the pages of a built PDF begin, for the editor's Pages view (client editor/plugins/pages.ts):
 * read from the build's SyncTeX file, which records every box TeX shipped out with the source line
 * it came from, and from the PDF's words (`pdftotext -bbox`) for the first words of each page and
 * its running head and foot. Pure text in, plain data out (the server and the tests feed it files).
 *
 * A page's text block is the page's tallest box nested in the shipped page (LaTeX's \@outputbox,
 * \textheight high), descended into while one child holds most of it; the running head and foot sit
 * outside it (pdfTeX records a vbox at its bottom, LuaTeX at its top: the lines in it tell which).
 * A line of text is an hbox in a vertical list holding no lines of its own, and its source line the
 * one most of its glyphs and glue came from (the hbox itself carries the line where the paragraph
 * ended). Floats and footnotes break source order: a page begins with the first of its
 * lines that does not come before the last line of the page before — a figure deferred to this page
 * from a paragraph before is not where the page begins; a paragraph running on from the page before is.
 * On a page of two (or more) columns, each column begins the same way, after the one before.
 */

/** a line of text in the PDF: its source line and its box, in TeX points from the page's top-left (v: baseline) */
export interface PdfLine { page: number; line: number; h: number; v: number; W: number; H: number; D: number }

/** a page's geometry and what LaTeX set around its text, in TeX points from the page's top-left */
export interface PageFrame {
  page: number;
  /** the paper (from the PDF; absent when its words were not read) */
  paperW?: number; paperH?: number;
  /** the text block */
  left: number; top: number; width: number; height: number;
  /** the running head and foot (the page number …), as words */
  header?: string; footer?: string;
}

/** where page `page` begins: in the paragraph of built-.tex line `line` (1-based) */
export interface PageStart {
  page: number;
  /** the column it begins (0-based; a page begins with its first): multi-column documents */
  column?: number;
  line: number;
  /** that paragraph's lines on earlier pages (0: the page begins with the paragraph) */
  before: number;
  /** its lines in all */
  total: number;
  /** the words of the page's first line, as the PDF has them (a hyphenated word's second half first) */
  words?: string[];
}

/** where TeX set a float (figure, table): the line of its \begin (1-based), the page, the column, top or bottom */
export interface PageFloat {
  line: number;
  page: number;
  column?: number;
  /** across the columns (figure*) */
  span?: boolean;
  at: 'top' | 'bottom' | 'middle';
}

export interface PageBreaks {
  pages: number;
  frames: PageFrame[];
  /** pages 2, 3, … (a page without text of the document — a float page, an included file — has none) */
  starts: PageStart[];
  /** the distance between the baselines of body text (pt), or null */
  lead: number | null;
  /** the width of a line of body text (pt; a column of a two-column page), or null */
  lineWidth: number | null;
  /** columns of text on a page (twocolumn: 2); `starts` then has where each column begins */
  columns: number;
  /** the floats of the built .tex, where TeX set them (when the .tex was given) */
  floats?: PageFloat[];
}

/** a word of a PDF page, in PDF points (bp) from the page's top-left */
export interface PdfWord { x0: number; y0: number; x1: number; y1: number; text: string }
export interface PdfPageWords { w: number; h: number; words: PdfWord[] }

const BP = 72 / 72.27;   // TeX pt → PDF bp

interface Box { kind: 'v' | 'h'; h: number; v: number; W: number; H: number; D: number; lines: number; children: Box[]; tally?: Map<number, number>; own?: number; nested?: boolean }

const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** `pdftotext -bbox` output: each page's size and words */
export function parsePdfWords(xhtml: string): PdfPageWords[] {
  const pages: PdfPageWords[] = [];
  const re = /<page width="([\d.]+)" height="([\d.]+)">|<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g;
  for (let m: RegExpExecArray | null; (m = re.exec(xhtml)); ) {
    if (m[1]) pages.push({ w: Number(m[1]), h: Number(m[2]), words: [] });
    else if (pages.length) pages[pages.length - 1].words.push({ x0: Number(m[3]), y0: Number(m[4]), x1: Number(m[5]), y1: Number(m[6]), text: unescape(m[7]) });
  }
  return pages;
}

/** the page boxes of a SyncTeX file for input `mainName` (the built .tex's file name) */
function parseSynctex(text: string, mainName: string): { pages: Map<number, Box>; main: number | null } {
  const lines = text.split('\n');
  let i = 0, unit = 1, mag = 1000, main: number | null = null;
  for (; i < lines.length && lines[i] !== 'Content:'; i++) {
    const l = lines[i];
    const inp = /^Input:(\d+):(.*)$/.exec(l);
    if (inp && main === null) { const p = inp[2].trim(); if (p === mainName || p.endsWith('/' + mainName)) main = Number(inp[1]); }
    const u = /^Unit:(\d+)/.exec(l); if (u) unit = Number(u[1]) || 1;
    const mg = /^Magnification:(\d+)/.exec(l); if (mg) mag = Number(mg[1]) || 1000;
  }
  const pt = (sp: string) => Number(sp) * unit / 65536 * (mag / 1000);
  const pages = new Map<number, Box>();
  let page = 0, root: Box | null = null;
  const stack: Box[] = [];
  /** the innermost open line candidate (an hbox right in a vertical list) */
  const lineStack: Box[] = [];
  const RE = /^([[(vhxkg$r])(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/;
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const c = l.charCodeAt(0);
    if (c === 123 /* { */) { page = Number(l.slice(1)); root = { kind: 'v', h: 0, v: 0, W: 0, H: 0, D: 0, lines: 0, children: [] }; stack.length = 0; stack.push(root); lineStack.length = 0; continue; }
    if (c === 125 /* } */) { if (root && page) pages.set(page, root); root = null; stack.length = 0; continue; }
    if (!root) continue;
    if (c === 93 /* ] */ || c === 41 /* ) */) {
      const b = stack.length > 1 ? stack.pop()! : null;
      if (b && lineStack[lineStack.length - 1] === b) {
        lineStack.pop();
        // a box holding lines of its own (a minipage, a table's cells, two columns) is not a line itself
        if (!b.nested) { b.lines = 1; const outer = lineStack[lineStack.length - 1]; if (outer) outer.nested = true; }
      }
      if (b) stack[stack.length - 1].lines += b.lines;
      continue;
    }
    const m = RE.exec(l);
    if (!m) continue;
    const tag = Number(m[2]), src = Number(m[3]);
    if (m[1] === '[' || m[1] === '(') {
      const b: Box = { kind: m[1] === '[' ? 'v' : 'h', h: pt(m[4]), v: pt(m[5]), W: pt(m[6] ?? '0'), H: pt(m[7] ?? '0'), D: pt(m[8] ?? '0'), lines: 0, children: [] };
      const parent = stack[stack.length - 1];
      parent.children.push(b);
      stack.push(b);
      if (b.kind === 'h' && parent.kind === 'v') { b.tally = new Map(); if (tag === main) b.own = src; lineStack.push(b); }
      continue;
    }
    // a glyph, kern, glue, formula, rule or void box: count its source line for the line it is in
    const cur = lineStack[lineStack.length - 1];
    if (cur && tag === main) cur.tally!.set(src, (cur.tally!.get(src) ?? 0) + 1);
  }
  // (a box's `lines`: summed into its parent as it closed, a line candidate counting once)
  return { pages, main };
}

/** the line a line box came from: most of its records', else its own */
function sourceLine(b: Box): number | null {
  let best: number | null = null, n = 0;
  for (const [l, k] of b.tally ?? []) if (k > n || (k === n && best !== null && l < best)) { best = l; n = k; }
  return best ?? b.own ?? null;
}

/** the text block: down from the page while one child box holds most of the height and the lines */
function bodyOf(root: Box): Box | null {
  let cur: Box | null = root.children.filter(c => c.kind === 'v').sort((a, b) => (b.H + b.D) - (a.H + a.D))[0] ?? null;
  for (let depth = 0; cur && depth < 6; depth++) {
    const kids: Box[] = cur.children.filter(c => c.kind === 'v' && c.lines > 0);
    const tall: Box | undefined = kids.sort((a, b) => (b.H + b.D) - (a.H + a.D))[0];
    // (most of the lines, or all but the head's and foot's few: a short last page has few lines in all)
    if (!tall || (tall.H + tall.D) < 0.7 * (cur.H + cur.D) || (tall.lines < 0.6 * cur.lines && cur.lines - tall.lines > 4)) break;
    cur = tall;
  }
  return cur;
}

/** the line boxes in a box, in order */
function linesIn(b: Box, out: Box[] = []): Box[] {
  for (const c of b.children) {
    if (c.lines === 1 && c.kind === 'h' && !c.nested && c.tally) out.push(c);
    else if (c.lines) linesIn(c, out);
  }
  return out;
}

const mode = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const n = new Map<number, number>();
  for (const x of xs) { const r = Math.round(x * 10) / 10; n.set(r, (n.get(r) ?? 0) + 1); }
  return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
};

/**
 * The pages of a build: `synctex` the file's text (gunzipped), `mainName` the built .tex's file name,
 * `bodyLine` the line of \begin{document} in it (lines up to there are the preamble's), `words` the
 * PDF's words when read, `tex` the built .tex (for where its floats went).
 */
export function pageBreaks(synctex: string, mainName: string, bodyLine = 0, words: PdfPageWords[] | null = null, tex: string | null = null): PageBreaks {
  const { pages } = parseSynctex(synctex, mainName);
  const nums = [...pages.keys()].sort((a, b) => a - b);
  const frames: PageFrame[] = [];
  const pageLines = new Map<number, PdfLine[]>();
  const leads: number[] = [], widths: number[] = [];
  // a vbox's v is its bottom in pdfTeX's SyncTeX and its top in LuaTeX's: told by where its lines are
  const bodies = new Map<number, { body: Box; lines: Box[] }>();
  let vIsTop: boolean | null = null;
  for (const p of nums) {
    const body = bodyOf(pages.get(p)!);
    if (!body) continue;
    const lines = linesIn(body);
    bodies.set(p, { body, lines });
    if (vIsTop === null && lines.length) vIsTop = body.v <= Math.min(...lines.map(l => l.v - l.H)) + 0.5;
  }
  // (the body text's leading and line width: the lines of floats — a long caption in \footnotesize — left out)
  const inFloat = floatRanges(tex);
  const bodyText = (line: number) => !inFloat.some(([a, b]) => line >= a && line <= b);
  for (const p of nums) {
    const got = bodies.get(p);
    if (!got) continue;
    const { body, lines } = got;
    const top = vIsTop ? body.v : body.v - body.H, bottom = top + body.H + body.D;
    const frame: PageFrame = { page: p, left: body.h, top, width: body.W, height: body.H + body.D };
    const ws = words?.[p - 1];
    if (ws) {
      frame.paperW = ws.w / BP; frame.paperH = ws.h / BP;
      const words = (pick: (y: number) => boolean) => ws.words.filter(w => pick((w.y0 + w.y1) / 2 / BP)).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).map(w => w.text).join(' ');
      const header = words(y => y < top - 1), footer = words(y => y > bottom + 1);
      if (header) frame.header = header.slice(0, 200);
      if (footer) frame.footer = footer.slice(0, 200);
    }
    frames.push(frame);
    const ls: PdfLine[] = [];
    for (const b of lines) {
      const line = sourceLine(b);
      if (line === null || line <= bodyLine) continue;
      ls.push({ page: p, line, h: b.h, v: b.v, W: b.W, H: b.H, D: b.D });
    }
    ls.sort((a, b) => a.v - b.v || a.h - b.h);
    for (let k = 1; k < ls.length; k++) if (ls[k].line === ls[k - 1].line && Math.abs(ls[k].h - ls[k - 1].h) < 1 && bodyText(ls[k].line)) leads.push(ls[k].v - ls[k - 1].v);
    // (a line from the text's left edge: list items stand indented, as narrower lines)
    for (const l of ls) if (l.W > 0 && bodyText(l.line) && Math.abs(l.h - body.h) < 1.5) widths.push(l.W);
    pageLines.set(p, ls);
  }
  // columns: lines of a column's width standing side by side in the text block (twocolumn's \@outputdblcol;
  // a figure* or the title over both columns is as wide as the block and counts with the first column)
  const lineWidth = mode(widths), f0 = frames[0];
  let columns = 1;
  if (lineWidth && f0 && f0.width > 1.6 * lineWidth) {
    const n = Math.max(2, Math.round(f0.width / lineWidth)), step = (f0.width - lineWidth) / (n - 1);
    const all = [...pageLines.values()].flat().filter(l => Math.abs(l.W - lineWidth) < 0.15 * lineWidth);
    const right = all.filter(l => l.h - f0.left > step / 2).length;
    if (right >= Math.max(3, 0.1 * all.length)) columns = n;
  }
  const colOf = (l: PdfLine): number => {
    if (columns === 1 || !f0 || !lineWidth || l.W > 1.3 * lineWidth) return 0;
    const step = (f0.width - lineWidth) / (columns - 1);
    return Math.min(columns - 1, Math.max(0, Math.round((l.h - (frames.find(f => f.page === l.page) ?? f0).left) / step)));
  };
  // a page's columns in reading order are the stretches of text (one per page with one column)
  const seg = (l: PdfLine) => (l.page - 1) * columns + colOf(l);
  // how many lines each paragraph has in each stretch
  const count = new Map<number, Map<number, number>>();
  for (const ls of pageLines.values()) for (const l of ls) { const m = count.get(l.line) ?? new Map<number, number>(); const k = seg(l); m.set(k, (m.get(k) ?? 0) + 1); count.set(l.line, m); }
  const starts: PageStart[] = [];
  let end = 0, firstSeg = true;
  for (const p of nums) {
    const lines = pageLines.get(p) ?? [];
    for (let c = 0; c < columns; c++) {
      const ls = columns === 1 ? lines : lines.filter(l => colOf(l) === c);
      if (!ls.length) continue;
      if (!firstSeg) {
        const flow = ls.filter(l => l.line >= end);
        const first = flow.length ? Math.min(...flow.map(l => l.line)) : null;
        if (first !== null) {
          const m = count.get(first)!, here = (p - 1) * columns + c;
          let before = 0, total = 0;
          for (const [q, k] of m) { total += k; if (q < here) before += k; }
          const start: PageStart = { page: p, line: first, before, total };
          if (columns > 1) start.column = c;
          const box = ls.filter(l => l.line === first).sort((a, b) => a.v - b.v)[0];
          const ws = words?.[p - 1];
          if (ws && box) {
            const top = (box.v - box.H) * BP - 1, bottom = (box.v + box.D) * BP + 1, left = box.h * BP - 1, right = (box.h + box.W) * BP + 1;
            const first = ws.words.filter(w => { const y = (w.y0 + w.y1) / 2, x = (w.x0 + w.x1) / 2; return y >= top && y <= bottom && x >= left && x <= right; })
              .sort((a, b) => a.x0 - b.x0).slice(0, 12).map(w => w.text);
            if (first.length) start.words = first;
          }
          starts.push(start);
        }
      }
      firstSeg = false;
      end = Math.max(end, ...ls.map(l => l.line));
    }
  }
  const out: PageBreaks = { pages: nums.length ? nums[nums.length - 1] : 0, frames, starts, lead: mode(leads), lineWidth, columns };
  if (tex) out.floats = floatsOf(tex, pageLines, frames, lineWidth, colOf);
  return out;
}

/** the float environments of the .tex: their first and last lines (1-based) */
function floatRanges(tex: string | null): [number, number][] {
  if (!tex) return [];
  const lines = tex.split('\n'), out: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const b = /^[^%]*\\begin\{(figure|table)(\*?)\}/.exec(lines[i]);
    if (!b) continue;
    let j = i;
    const close = '\\end{' + b[1] + b[2] + '}';
    while (j < lines.length - 1 && !lines[j].includes(close)) j++;
    out.push([i + 1, j + 1]);
    i = j;
  }
  return out;
}

/** the float environments of the .tex and where their lines are in the PDF */
function floatsOf(tex: string, pageLines: Map<number, PdfLine[]>, frames: PageFrame[], lineWidth: number | null, colOf: (l: PdfLine) => number): PageFloat[] {
  const out: PageFloat[] = [];
  const all = [...pageLines.values()].flat();
  for (const [a, z] of floatRanges(tex)) {
    const ls = all.filter(l => l.line >= a && l.line <= z);
    if (!ls.length) continue;
    const page = Math.min(...ls.map(l => l.page));
    const on = ls.filter(l => l.page === page);
    const f = frames.find(x => x.page === page);
    const top = Math.min(...on.map(l => l.v - l.H)), bottom = Math.max(...on.map(l => l.v + l.D));
    const at: PageFloat['at'] = !f ? 'middle' : top - f.top < 0.25 * f.height ? 'top' : f.top + f.height - bottom < 0.25 * f.height ? 'bottom' : 'middle';
    const fl: PageFloat = { line: a, page, at };
    const span = !!lineWidth && on.some(l => l.W > 1.3 * lineWidth);
    if (span) fl.span = true;
    else { const c = colOf(on[0]); if (c) fl.column = c; }
    out.push(fl);
  }
  return out;
}

