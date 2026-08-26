/**
 * Math model → LaTeX exactly as LyX writes it into .lyx files (a port of TeXMathStream in
 * LyX-file mode plus every InsetMath*::write). Goal: write(parse(x)) === x for anything LyX wrote.
 */
import type { Atom, Cell, Grid, Hull, Limits } from './ast';

const isAlpha = (c: string) => /^[A-Za-z]$/.test(c);

/** TeXMathStream (latex() == false): the pending-space and line-break bookkeeping. */
export class MathWriter {
  private buf: string[] = [];
  private pendingSpace = false;
  private canBreakLine = true;
  firstitem = false;
  textMode = false;

  /** operator<<(docstring) */
  s(str: string): this {
    if (!str) return this;
    // skip a leading '\n' if we already output one
    const first = str[0] !== '\n' || this.canBreakLine ? 0 : 1;
    if (str.length <= first) return this;
    if (this.pendingSpace) {
      const c = str[first];
      if (isAlpha(c)) this.buf.push(' ');
      else if (c === ' ' && this.textMode) this.buf.push('\\');
      this.pendingSpace = false;
    }
    const out = str.slice(first);
    this.buf.push(out);
    this.canBreakLine = out[out.length - 1] !== '\n';
    return this;
  }
  /** raw put (InsetMathChar::write uses the underlying stream) — but chars are gathered into strings by writeCell */
  raw(str: string): this { this.buf.push(str); if (str) this.canBreakLine = str[str.length - 1] !== '\n'; return this; }
  space(on: boolean) { this.pendingSpace = on; }
  hasPendingSpace() { return this.pendingSpace; }
  toString(): string { return this.buf.join('') + (this.pendingSpace ? ' ' : ''); }
  /** result without the trailing pending space (used when embedding) */
  text(): string { return this.buf.join(''); }
}

/** write(MathData const &, TeXMathStream &): runs of characters are written as one string */
export function writeCell(cell: Cell, os: MathWriter): void {
  os.firstitem = true;
  let s = '';
  for (const a of cell) {
    if (a.t === 'char') { s += a.c; continue; }
    if (s) { os.s(s); s = ''; }
    writeAtom(a, os);
    os.firstitem = false;
  }
  if (s) { os.s(s); os.firstitem = false; }
}

const writeLimits = (os: MathWriter, l: Limits) => { if (l === 'limits') { os.s('\\limits'); os.space(true); } else if (l === 'nolimits') { os.s('\\nolimits'); os.space(true); } };

const braced = (os: MathWriter, c: Cell) => { os.s('{'); writeCell(c, os); os.s('}'); };

function delimName(name: string): string {
  if (name.length === 1 && '<([.>)]/|'.includes(name)) return name;
  return '\\' + name + ' ';
}

export function writeAtom(a: Atom, os: MathWriter): void {
  switch (a.t) {
    case 'char': os.s(a.c); return;
    case 'sym': {
      os.s('\\' + a.n);
      if (a.n.length === 1 && !isAlpha(a.n[0])) return;
      os.space(true);
      writeLimits(os, a.limits);
      return;
    }
    case 'space': {
      if (a.n === '~') { os.s('~'); return; }
      if (a.n === 'hspace*{\\fill}') { os.s('\\hspace*{\\fill}'); return; }
      os.s('\\' + a.n);
      if (a.len !== undefined) os.s('{' + a.len + '}');
      else if (a.n.length > 1) os.space(true);
      return;
    }
    case 'kern': os.s('\\' + a.n + a.len + ' '); return;
    case 'script': {
      if (a.nuc.length) writeCell(a.nuc, os);
      else if (!os.firstitem) os.s('{}');
      // LyX 2.5 (InsetMathScript::writeMath) writes the superscript first
      if (a.up) { os.s('^{'); writeCell(a.up, os); os.s('}'); }
      if (a.down) { os.s('_{'); writeCell(a.down, os); os.s('}'); }
      writeLimits(os, a.limits);
      return;
    }
    case 'frac': {
      switch (a.kind) {
        case 'atop': os.s('{'); writeCell(a.c0, os); os.s('\\atop '); writeCell(a.c1, os); os.s('}'); return;
        case 'choose': case 'brace': case 'brack': os.s('{'); writeCell(a.c0, os); os.s('\\' + a.kind + ' '); writeCell(a.c1, os); os.s('}'); return;
        case 'over': os.s('\\frac{'); writeCell(a.c0, os); os.s('}{'); writeCell(a.c1, os); os.s('}'); return;
        case 'unitfrac':
          if (a.c2) { os.s('\\unitfrac['); writeCell(a.c2, os); os.s(']{'); writeCell(a.c0, os); os.s('}{'); writeCell(a.c1, os); os.s('}'); return; }
          break;
        case 'unit':
          if (a.c1.length || a.c2 !== undefined) { os.s('\\unit['); writeCell(a.c0, os); os.s(']{'); writeCell(a.c1, os); os.s('}'); }
          else { os.s('\\unit{'); writeCell(a.c0, os); os.s('}'); }
          return;
        case 'cfracleft': os.s('\\cfrac[l]{'); writeCell(a.c0, os); os.s('}{'); writeCell(a.c1, os); os.s('}'); return;
        case 'cfracright': os.s('\\cfrac[r]{'); writeCell(a.c0, os); os.s('}{'); writeCell(a.c1, os); os.s('}'); return;
        default: break;
      }
      os.s('\\' + a.kind); braced(os, a.c0); braced(os, a.c1);
      return;
    }
    case 'sqrt': {
      if (a.index) { os.s('\\sqrt['); writeCell(a.index, os); os.s(']{'); writeCell(a.body, os); os.s('}'); }
      else { os.s('\\sqrt{'); writeCell(a.body, os); os.s('}'); }
      return;
    }
    case 'delim': os.s('\\left' + delimName(a.l)); writeCell(a.body, os); os.s('\\right' + delimName(a.r)); return;
    case 'big': os.s('\\' + a.n + a.d); if (a.d[0] === '\\') os.space(true); return;
    case 'brace': os.s('{'); writeCell(a.body, os); os.s('}'); return;
    case 'font': case 'deco': case 'class': case 'ensuremath': case 'phantom': {
      const name = a.t === 'ensuremath' ? 'ensuremath' : a.n;
      os.s('\\' + name + '{');
      const tm = os.textMode;
      if (a.t === 'font') os.textMode = a.mode === 'text';
      writeCell(a.body, os);
      os.textMode = tm;
      os.s('}');
      if (a.t === 'deco' || a.t === 'class') writeLimits(os, a.limits);
      return;
    }
    case 'box': {
      os.s('\\' + a.n + '{');
      const tm = os.textMode; os.textMode = a.n !== 'boxed';
      writeCell(a.body, os);
      os.textMode = tm;
      os.s('}');
      return;
    }
    case 'makebox': {
      os.s('\\' + a.n);
      if (a.width.length) { os.s('['); writeCell(a.width, os); os.s(']'); }
      if (a.align.length) { os.s('['); writeCell(a.align, os); os.s(']'); }
      braced(os, a.body);
      return;
    }
    case 'oldfont': case 'style': os.s('{\\' + a.n + ' '); writeCell(a.body, os); os.s('}'); return;
    case 'color': {
      if (a.old) { os.s(a.color === 'normalcolor' ? '{\\normalcolor ' : '{\\color{' + a.color + '}'); writeCell(a.body, os); os.s('}'); }
      else { os.s('\\textcolor{' + a.color + '}{'); const tm = os.textMode; os.textMode = true; writeCell(a.body, os); os.textMode = tm; os.s('}'); }
      return;
    }
    case 'overset': case 'underset': os.s('\\' + a.t); braced(os, a.top); braced(os, a.body); return;
    case 'stackrel': os.s('\\stackrel'); if (a.bottom) { os.s('['); writeCell(a.bottom, os); os.s(']'); } braced(os, a.top); braced(os, a.body); return;
    case 'xarrow': os.s('\\' + a.n); if (a.opt && a.opt.length) { os.s('['); writeCell(a.opt, os); os.s(']'); } braced(os, a.body); return;
    case 'ref': os.s('\\' + a.n); if (a.opt) os.s('[' + a.opt + ']'); os.s('{' + a.label + '}'); return;
    case 'grid': writeGrid(a, os); return;
    case 'macro': {
      os.s('\\' + a.n);
      let first = true;
      // optional arguments: up to the last non-empty one
      let emptyOptFrom = 0;
      for (let i = 0; i < a.args.length && i < a.nopt; i++) if (a.args[i].length) emptyOptFrom = i + 1;
      for (let i = 0; i < a.args.length && i < emptyOptFrom; i++) {
        first = false;
        const c = a.args[i];
        const last = c[c.length - 1];
        let br = false;
        if (last && last.t === 'cmd' && /^[bB]ig+[lmr]?$/.test(last.n)) br = true;
        else if (c.length && c[0].t === 'script' && !c[0].nuc.length) br = true;
        else br = c.some(x => x.t === 'macro' && x.nopt > 0);
        os.s(br ? '[{' : '['); writeCell(c, os); os.s(br ? '}]' : ']');
      }
      for (let i = a.nopt; i < a.args.length; i++) {
        const c = a.args[i];
        if (c.length === 1 && c[0].t === 'char' && c[0].c.charCodeAt(0) < 128) { if (first) os.s(' '); writeCell(c, os); }
        else braced(os, c);
        first = false;
      }
      if (first) os.space(true);
      writeLimits(os, a.limits);
      return;
    }
    case 'cmd': {
      os.s('\\' + a.n);
      if (a.n.length !== 1 || isAlpha(a.n[0])) os.space(true);
      writeLimits(os, a.limits);
      return;
    }
    case 'hash': os.s(a.n); return;
    case 'comment': os.s('%' + a.text + '\n'); return;
    case 'env': os.s('\\begin{' + a.n + '}'); writeCell(a.body, os); os.s('\\end{' + a.n + '}'); return;
    case 'raw': os.s(a.latex); return;
  }
}

/** InsetMathGrid::write body: rows joined with ` & ` / `\\` */
function writeGridBody(g: Grid, os: MathWriter, hull?: Hull): void {
  const nrows = g.rows.length;
  for (let row = 0; row < nrows; row++) {
    const r = g.rows[row];
    if (r.hlines) { os.s('\\hline'.repeat(r.hlines) + ' '); }
    // do not write & and empty cells at the end of a line
    let lastcol = 0, emptyline = true, lastEoln = true;
    const multiOf = (col: number) => r.multi?.find(m => m.col === col);
    const partOfMulti = (col: number) => r.multi?.some(m => col > m.col && col < m.col + m.ncols);
    for (let col = 0; col < g.ncols; col++) {
      const c = r.cells[col] ?? [];
      const special = !!multiOf(col) || !!partOfMulti(col);
      if (lastEoln && (c.length || special)) lastEoln = false;
      if (c.length || special) { lastcol = col + 1; emptyline = false; }
    }
    for (let col = 0; col < g.ncols;) {
      let nccols = 1;
      if (col >= lastcol) { col++; continue; }
      const m = multiOf(col);
      if (m) { nccols = m.ncols; os.s('\\multicolumn{' + nccols + '}{' + m.align + '}{'); }
      writeCell(r.cells[col] ?? [], os);
      if (m) os.s('}');
      if (col + nccols < lastcol) os.s(' & ');
      col += nccols;
    }
    // end of line (InsetMathHull::eol / InsetMathGrid::eol)
    if (hull) {
      if (hullNumbered(hull)) {
        if (hull.labels[row]) os.s('\\label{' + hull.labels[row] + '}');
        if (hull.type !== 'multline') {
          if (hull.numberedRows[row] === false) os.s('\\nonumber ');
          else if (hull.numberedRows[row] === 'notag') os.s('\\notag ');
        }
      }
      lastEoln = false;
    }
    let eol = '';
    if (r.crskip) eol += '[' + r.crskip + ']';
    else if (r.nonewpage) eol += '*';
    if (row + 1 < nrows) { const c = g.rows[row + 1].cells[0]; if (c.length && c[0].t === 'char' && c[0].c === '[') eol += '{}'; }
    const skip = !eol && row + 1 === nrows && (nrows === 1 || !lastEoln);
    if (!skip) os.s('\\\\' + eol);
    if (!emptyline && nrows > 1) os.s('\n');
  }
  if (hull?.hlinesEnd) os.s('\\hline'.repeat(hull.hlinesEnd) + ' ');
}

function writeGrid(g: Grid, os: MathWriter): void {
  const env = g.env;
  if (env === 'cases') { os.s('\\begin{cases}\n'); writeGridBody(g, os); os.s('\\end{cases}'); return; }
  if (env === 'substack') { os.s('\\substack{'); writeGridBody(g, os); os.s('}\n'); return; }
  if (env === 'array' || env === 'subarray' || env === 'tabular') {
    os.s('\\begin{' + env + '}');
    if (g.valign === 't' || g.valign === 'b') os.s('[' + g.valign + ']');
    os.s('{' + (g.halign ?? 'c'.repeat(g.ncols)) + '}\n');
    writeGridBody(g, os);
    os.s('\\end{' + env + '}');
    return;
  }
  if (['aligned', 'gathered', 'lgathered', 'rgathered', 'split', 'alignedat', 'align'].includes(env)) {
    const suffix = env === 'align' && g.numbered === false ? '*' : '';
    os.s('\\begin{' + env + suffix + '}');
    const hasArg = env === 'alignedat';
    if (env !== 'split' && env !== 'align') {
      if (g.valign && g.valign !== 'c') os.s('[' + g.valign + ']');
      else if (!hasArg) { const c = g.rows[0]?.cells[0]; if (c && c.length && c[0].t === 'char' && c[0].c === '[') os.s('[]'); }
    }
    if (hasArg) os.s('{' + Math.floor((g.ncols + 1) / 2) + '}');
    writeGridBody(g, os);
    os.s('\\end{' + env + suffix + '}\n');
    return;
  }
  // AMS matrices (matrix, pmatrix, bmatrix, …, smallmatrix, CD)
  os.s('\\begin{' + env + '}');
  writeGridBody(g, os);
  os.s('\\end{' + env + '}');
}

const hullNumbered = (h: Hull) => h.type !== 'simple' && h.type !== 'none' && h.numberedRows.some(n => n === true || n === 'notag') || (h.type !== 'simple' && h.type !== 'none' && h.type !== 'equation' && h.numberedRows.length > 0 && numberedType(h));

/** InsetMathHull::numberedType: whether the environment is a numbered one (any row numbered) */
function numberedType(h: Hull): boolean {
  if (h.type === 'simple' || h.type === 'none' || h.type === 'unknown') return false;
  return h.numberedRows.some(n => n === true);
}

/** InsetMathHull::write for the LyX file: header, rows, footer */
export function writeFormula(h: Hull): string {
  const os = new MathWriter();
  const n = numberedType(h);
  const star = n ? '' : '*';
  const name = h.type;
  switch (h.type) {
    case 'simple':
      os.s('$'); if (!h.rows[0].cells[0].length) os.s(' ');
      writeGridBody(h, os, h);
      os.s('$');
      return os.text() + (os.hasPendingSpace() ? ' ' : '');
    case 'equation':
      os.s('\n'); os.s(n ? '\\begin{equation}\n' : '\\[\n');
      writeGridBody(h, os, h);
      os.s('\n'); os.s(n ? '\\end{equation}\n' : '\\]\n');
      return os.text();
    case 'eqnarray': case 'align': case 'flalign': case 'gather': case 'multline':
      os.s('\n'); os.s('\\begin{' + name + star + '}\n');
      writeGridBody(h, os, h);
      os.s('\n'); os.s('\\end{' + name + star + '}\n');
      return os.text();
    case 'alignat': case 'xalignat':
      os.s('\n'); os.s('\\begin{' + name + star + '}{' + Math.floor((h.ncols + 1) / 2) + '}\n');
      writeGridBody(h, os, h);
      os.s('\n'); os.s('\\end{' + name + star + '}\n');
      return os.text();
    case 'xxalignat':
      os.s('\n'); os.s('\\begin{' + name + '}{' + Math.floor((h.ncols + 1) / 2) + '}\n');
      writeGridBody(h, os, h);
      os.s('\n'); os.s('\\end{' + name + '}\n');
      return os.text();
    default:
      writeCell(h.rows[0].cells[0], os);
      return os.toString();
  }
}

/** The LaTeX of one cell (for the editor, previews and tests). */
export function writeCellLatex(cell: Cell): string {
  const os = new MathWriter();
  writeCell(cell, os);
  return os.text();
}
