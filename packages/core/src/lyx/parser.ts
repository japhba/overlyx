/**
 * LyX file parser — mirrors the reading rules of LyX's Lexer / Text::readParToken:
 *   - a line starting with "\" is a command token (first word) + rest-of-line argument
 *   - a text token runs to end-of-line or to the next backslash
 *   - empty lines are insignificant
 *   - text lines of one paragraph are concatenated verbatim (no separator)
 */
import type {
  Change, FontState, Inset, Item, LyxDocument, Paragraph, TabularCell, TabularInset, TabularRow, TextInset, LeafInset,
} from './ast.ts';
import { fontsEqual, changesEqual } from './ast.ts';

const FONT_TOKEN: Record<string, keyof FontState> = {
  '\\family': 'family', '\\series': 'series', '\\shape': 'shape', '\\size': 'size', '\\emph': 'emph',
  '\\numeric': 'numeric', '\\nospellcheck': 'nospellcheck', '\\bar': 'bar', '\\strikeout': 'strikeout',
  '\\xout': 'xout', '\\uuline': 'uuline', '\\uwave': 'uwave', '\\noun': 'noun', '\\color': 'color', '\\lang': 'lang',
};

class Reader {
  pos = 0;
  constructor(public lines: string[]) {}
  get done() { return this.pos >= this.lines.length; }
  peek(): string { return this.lines[this.pos]; }
  next(): string { return this.lines[this.pos++]; }
}

function splitToken(line: string): [string, string] {
  const sp = line.indexOf(' ');
  if (sp < 0) return [line, ''];
  return [line.slice(0, sp), line.slice(sp + 1)];
}

export function parseLyx(text: string): LyxDocument {
  if (text.startsWith('﻿')) text = text.slice(1);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // A file ending with "\n" yields a trailing empty element; drop exactly one.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const r = new Reader(lines);
  const doc: LyxDocument = { preamble: [], format: 0, header: { lines: [] }, body: [], trailer: [] };

  // preamble comment(s)
  while (!r.done && !r.peek().startsWith('\\lyxformat')) doc.preamble.push(r.next());
  if (!r.done) {
    const [, fmt] = splitToken(r.next());
    doc.format = parseInt(fmt, 10) || 0;
  }
  // \begin_document
  while (!r.done && r.peek() !== '\\begin_header') {
    const l = r.next();
    if (l !== '\\begin_document' && l !== '') doc.preamble.push(l);
  }
  if (!r.done) r.next(); // \begin_header
  while (!r.done && r.peek() !== '\\end_header') doc.header.lines.push(r.next());
  if (!r.done) r.next(); // \end_header
  while (!r.done && r.peek() !== '\\begin_body') r.next();
  if (!r.done) r.next(); // \begin_body
  doc.body = parseParagraphs(r);
  // consume \end_body / \end_document
  while (!r.done) {
    const l = r.next();
    if (l === '\\end_body' || l === '\\end_document' || l === '') continue;
    doc.trailer.push(l);
  }
  return doc;
}

/** Parse paragraphs until \end_inset / \end_body / \end_document (terminator is NOT consumed). */
export function parseParagraphs(r: Reader): Paragraph[] {
  const pars: Paragraph[] = [];
  let depth = 0;
  let cur: Paragraph | null = null;
  let font: FontState = {};
  let change: Change | undefined;
  // --- simulated writer state, used to detect "bare" font changes (language -> latex),
  // which LyX writes as a lone empty line (Font::lyxWriteChanges always starts with "\n").
  let ls: boolean | 'maybe' = true; // writer is at the start of a line ('maybe': after ".,;:!?" — true iff next char is ' ')
  let blanks = 0;         // consecutive empty lines read since the last non-empty line
  let afterFontLine = false;
  let lastText: string | null = null; // previous text line (for unexplained line breaks)
  let pos = 0;            // char position inside paragraph (insets count 1)

  const ensurePar = (): Paragraph => {
    if (!cur) { cur = { layout: 'Standard', depth, params: {}, items: [] }; pars.push(cur); }
    return cur;
  };
  const pushText = (t: string) => {
    if (!t) return;
    const p = ensurePar();
    const last = p.items[p.items.length - 1];
    if (last && last.kind === 'text' && fontsEqual(last.font, font) && changesEqual(last.change, change)) {
      last.text += t;
    } else {
      const it: Item = { kind: 'text', text: t, font: { ...font } };
      if (change) it.change = { ...change };
      p.items.push(it);
    }
    pos += t.length;
  };
  const pushItem = (it: Item) => { ensurePar().items.push(it); pos++; };
  const base = () => {
    const b: { font: FontState; change?: Change } = { font: { ...font } };
    if (change) b.change = { ...change };
    return b;
  };
  /** Account for blank lines before a token that the writer would prefix with "\n" iff at line start. */
  const bareChange = () => { if (cur && font.lang !== 'latex') font.lang = 'latex'; ls = true; };
  const account = (expectedIfLs: number, expectedIfNotLs: number) => {
    if (ls === 'maybe') ls = nextTextStartsWithSpace(r);
    const expected = ls ? expectedIfLs : expectedIfNotLs;
    if (cur && blanks > expected) bareChange();
    blanks = 0;
  };

  while (!r.done) {
    let line = r.peek();
    if (line === '') { r.pos++; blanks++; continue; }
    if (line[0] !== '\\') {
      const bs = line.indexOf('\\');
      const textPart = bs < 0 ? line : line.slice(0, bs);
      if (textPart) {
        account(0, 0);
        if (lastText !== null && blanks === 0 && ls !== true) {
          // consecutive text lines: is the line break explained by LyX's wrapping rules?
          const prev = lastText;
          const pc = prev[prev.length - 1];
          const explained = (BREAK_AFTER.has(pc) && textPart.startsWith(' ')) || BREAK_ALWAYS.has(pc) || prev.length > 500;
          if (!explained) bareChange();
        }
        pushText(textPart);
        lastText = textPart;
        const lc = textPart[textPart.length - 1];
        ls = BREAK_ALWAYS.has(lc) ? true : BREAK_AFTER.has(lc) ? 'maybe' : false;
        afterFontLine = false;
      }
      if (bs < 0) { r.pos++; continue; }
      // text followed by a command on the same line (e.g. "word\SpecialChar nobreakdash")
      line = line.slice(bs);
      r.lines[r.pos] = line;
      if (textPart) {
        // the pending break decision for BREAK_AFTER chars: writer breaks only if next char is ' '
        // (a token follows here, so no break was written; we stay mid-line)
        ls = false;
      }
    }
    const [tok, rest] = splitToken(line);
    switch (tok) {
      case '\\end_inset':
      case '\\end_body':
      case '\\end_document':
        return pars;
      case '\\begin_layout':
        r.pos++;
        cur = { layout: rest || 'Standard', depth, params: {}, items: [] };
        pars.push(cur);
        font = {}; change = undefined;
        ls = true; blanks = 0; afterFontLine = false; lastText = null; pos = 0;
        continue;
      case '\\end_layout':
        account(1, 0);
        r.pos++;
        if (cur && change) cur.endChange = { ...change };
        cur = null; font = {}; change = undefined; lastText = null; ls = true;
        continue;
      case '\\begin_deeper': r.pos++; depth++; blanks = 0; continue;
      case '\\end_deeper': r.pos++; depth = Math.max(0, depth - 1); blanks = 0; continue;
      case '\\begin_inset': {
        account(pos > 0 ? 1 : 0, 0);
        r.pos++;
        const inset = parseInset(r, rest);
        pushItem({ kind: 'inset', inset, ...base() });
        ls = true; blanks = -1; afterFontLine = false; lastText = null; // "\end_inset\n\n" always yields one blank
        continue;
      }
      case '\\backslash':
        account(1, 0);
        r.pos++; pushText('\\'); ls = true; lastText = null; afterFontLine = false;
        continue;
      case '\\SpecialChar':
      case '\\SpecialCharNoPassThru':
      case '\\IPAChar':
        account(0, 0);
        r.pos++; pushItem({ kind: 'special', token: tok, arg: rest, ...base() });
        ls = true; lastText = null; afterFontLine = false;
        continue;
      case '\\twohyphens':
      case '\\threehyphens':
        account(0, 0);
        r.pos++; pushItem({ kind: 'special', token: tok, arg: '', ...base() });
        ls = true; lastText = null; afterFontLine = false;
        continue;
      case '\\change_unchanged':
        account(1, 0);
        r.pos++; change = undefined; ls = true; lastText = null; afterFontLine = false;
        continue;
      case '\\change_inserted':
      case '\\change_deleted': {
        account(1, 0);
        r.pos++;
        const [a, t] = rest.split(/\s+/);
        change = { type: tok === '\\change_inserted' ? 'inserted' : 'deleted', author: Number(a), time: Number(t) };
        ls = true; lastText = null; afterFontLine = false;
        continue;
      }
      case '\\align': r.pos++; ensurePar().params.align = rest; blanks = 0; continue;
      case '\\noindent': r.pos++; ensurePar().params.noindent = true; blanks = 0; continue;
      case '\\labelwidthstring': r.pos++; ensurePar().params.labelwidthstring = rest; blanks = 0; continue;
      case '\\paragraph_spacing': r.pos++; ensurePar().params.paragraph_spacing = rest; blanks = 0; continue;
      case '\\leftindent': r.pos++; ensurePar().params.leftindent = rest; blanks = 0; continue;
      case '\\start_of_appendix': r.pos++; ensurePar().params.start_of_appendix = true; blanks = 0; continue;
    }
    const fk = FONT_TOKEN[tok];
    if (fk) {
      account(afterFontLine ? 0 : 1, 0);
      r.pos++;
      if (rest === 'default') delete font[fk]; else font[fk] = rest;
      ls = true; afterFontLine = true; lastText = null;
      continue;
    }
    // unknown token: preserve verbatim
    r.pos++; blanks = 0;
    pushItem({ kind: 'unknown', line, ...base() });
    ls = true; lastText = null;
  }
  return pars;
}

/** Look past change/font marks and blank lines: does the next text char start with a space? */
function nextTextStartsWithSpace(r: Reader): boolean {
  for (let j = r.pos + 1; j < r.lines.length; j++) {
    const l = r.lines[j];
    if (l === '') continue;
    if (l[0] !== '\\') return l.startsWith(' ');
    const tok = l.split(' ')[0];
    if (tok.startsWith('\\change_') || FONT_TOKEN[tok]) continue;
    return false;
  }
  return false;
}

const BREAK_AFTER = new Set(['.', '!', '?', ':', ';', ',', '؟', '؛', '،']);
const BREAK_ALWAYS = new Set(['—', '。', '！', '？', '：', '；', '，']);

function parseInset(r: Reader, first: string): Inset {
  const [name, arg] = splitToken(first);
  if (name === 'Formula') {
    const body: string[] = [];
    while (!r.done && r.peek() !== '\\end_inset') body.push(r.next());
    if (!r.done) r.next();
    const inline = arg !== '';
    if (!inline && body.length && body[body.length - 1] === '') body.pop();
    let latex = arg;
    if (body.length) latex += (inline ? '\n' : '') + body.join('\n');
    return { type: 'Formula', inline, latex };
  }
  if (name === 'FormulaMacro') {
    const body: string[] = [];
    while (!r.done && r.peek() !== '\\end_inset') body.push(r.next());
    if (!r.done) r.next();
    return { type: 'FormulaMacro', lines: body };
  }
  if (name === 'Tabular') return parseTabular(r);

  // generic: parameter lines until status / \begin_layout / \end_inset
  const params: string[] = [];
  while (!r.done) {
    const l = r.peek();
    if (l === '\\end_inset') {
      r.next();
      const leaf: LeafInset = { type: 'Leaf', name, arg, params };
      return leaf;
    }
    if (l.startsWith('status ') || l === '\\begin_layout' || l.startsWith('\\begin_layout ') || l === '\\begin_deeper') {
      let status: 'open' | 'collapsed' | undefined;
      if (l.startsWith('status ')) { status = l.slice(7).trim() === 'open' ? 'open' : 'collapsed'; r.next(); }
      // drop blank params (TextInsets never have significant blank param lines)
      const cleaned = params.filter(p => p !== '');
      const paragraphs = parseParagraphs(r);
      if (!r.done && r.peek() === '\\end_inset') r.next();
      const ti: TextInset = { type: 'Text', name, arg, params: cleaned, status, paragraphs };
      return ti;
    }
    if (l.startsWith('\\begin_inset')) {
      // inset directly inside an inset without paragraphs — unknown structure; keep raw
      return parseRaw(r, first, params);
    }
    if (l === '\\end_layout' || l === '\\end_body' || l === '\\end_document' || l === '\\end_deeper') {
      // an unterminated inset (a damaged file): end it here instead of swallowing the rest of
      // the document as "parameters" — the writer adds the missing \end_inset
      return { type: 'Leaf', name, arg, params };
    }
    params.push(r.next());
  }
  return { type: 'Leaf', name, arg, params };
}

function parseRaw(r: Reader, first: string, already: string[]): Inset {
  const lines = [...already];
  let depth = 1;
  while (!r.done) {
    const l = r.next();
    if (l.startsWith('\\begin_inset')) depth++;
    else if (l === '\\end_inset') { depth--; if (depth === 0) break; }
    lines.push(l);
  }
  return { type: 'Raw', firstLine: first, lines };
}

/* ------------------------------------------------------------- tabular */

function parseAttrs(tag: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /([\w:-]+)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out.push([m[1], m[2]]);
  return out;
}

function parseTabular(r: Reader): TabularInset {
  const tab: TabularInset = { type: 'Tabular', attrs: [], features: [], columns: [], rows: [] };
  let row: TabularRow | null = null;
  while (!r.done) {
    const l = r.peek();
    if (l === '\\end_inset') { r.next(); break; }
    if (l === '') { r.next(); continue; }
    if (l.startsWith('<lyxtabular')) { tab.attrs = parseAttrs(l); r.next(); continue; }
    if (l.startsWith('<features')) { tab.features = parseAttrs(l); r.next(); continue; }
    if (l.startsWith('<column')) { tab.columns.push({ attrs: parseAttrs(l) }); r.next(); continue; }
    if (l.startsWith('<row')) { row = { attrs: parseAttrs(l), cells: [] }; tab.rows.push(row); r.next(); continue; }
    if (l.startsWith('</row')) { row = null; r.next(); continue; }
    if (l.startsWith('</lyxtabular')) { r.next(); continue; }
    if (l.startsWith('<cell')) {
      const cell: TabularCell = { attrs: parseAttrs(l), paragraphs: [] };
      r.next();
      // expect \begin_inset Text
      while (!r.done && r.peek() === '') r.next();
      if (!r.done && r.peek().startsWith('\\begin_inset Text')) {
        r.next();
        cell.paragraphs = parseParagraphs(r);
        if (!r.done && r.peek() === '\\end_inset') r.next();
      }
      while (!r.done && !r.peek().startsWith('</cell')) r.next();
      if (!r.done) r.next();
      if (!row) { row = { attrs: [], cells: [] }; tab.rows.push(row); }
      row.cells.push(cell);
      continue;
    }
    r.next();
  }
  return tab;
}

export { Reader };
