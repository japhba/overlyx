/**
 * LyX file writer — reproduces LyX's own output format byte-for-byte
 * (Paragraph::write, Font::lyxWriteChanges, Changes::lyxMarkChange, inset write()).
 */
import type { Change, FontState, Inset, LyxDocument, Paragraph, TabularInset } from './ast.ts';
import { FONT_KEYS, changesEqual } from './ast.ts';

const FONT_CMD: Record<keyof FontState, string> = {
  family: '\\family', series: '\\series', shape: '\\shape', size: '\\size', emph: '\\emph', numeric: '\\numeric',
  nospellcheck: '\\nospellcheck', bar: '\\bar', strikeout: '\\strikeout', xout: '\\xout', uuline: '\\uuline',
  uwave: '\\uwave', noun: '\\noun', color: '\\color', lang: '\\lang',
};

export function writeLyx(doc: LyxDocument): string {
  const out: string[] = [];
  for (const l of doc.preamble) out.push(l + '\n');
  out.push(`\\lyxformat ${doc.format}\n`);
  out.push('\\begin_document\n');
  out.push('\\begin_header\n');
  for (const l of doc.header.lines) out.push(l + '\n');
  out.push('\\end_header\n');
  out.push('\n\\begin_body\n');
  out.push(writeParagraphs(doc.body));
  out.push('\n\\end_body\n\\end_document\n');
  for (const l of doc.trailer) out.push(l + '\n');
  return out.join('');
}

/** Text::write — each paragraph starts with "\n\begin_layout" and ends with "\n\end_layout\n". */
export function writeParagraphs(pars: Paragraph[]): string {
  const out: string[] = [];
  let depth = 0;
  for (const p of pars) {
    if (p.depth > depth) { while (p.depth > depth) { out.push('\n\\begin_deeper'); depth++; } }
    else if (p.depth < depth) { while (p.depth < depth) { out.push('\n\\end_deeper'); depth--; } }
    out.push(writeParagraph(p));
  }
  for (; depth > 0; depth--) out.push('\n\\end_deeper');
  return out.join('');
}

function writeParams(p: Paragraph): string {
  const s: string[] = [];
  const pp = p.params;
  if (pp.paragraph_spacing) s.push('\\paragraph_spacing ' + pp.paragraph_spacing + '\n');
  if (pp.labelwidthstring) s.push('\\labelwidthstring ' + pp.labelwidthstring + '\n');
  if (pp.start_of_appendix) s.push('\\start_of_appendix\n');
  if (pp.noindent) s.push('\\noindent\n');
  if (pp.leftindent) s.push('\\leftindent ' + pp.leftindent + '\n');
  if (pp.align) s.push('\\align ' + pp.align + '\n');
  return s.join('');
}

function writeFontChanges(prev: FontState, cur: FontState): string {
  let s = '\n';
  for (const k of FONT_KEYS) {
    const a = prev[k], b = cur[k];
    if (a === b) continue;
    if (k === 'lang' && (b === undefined || b === 'latex')) {
      // "latex" pseudo-language (ERT & co.) is never written explicitly; inherited language
      // reverts are not expressible either ("\lang default" does not exist).
      continue;
    }
    s += FONT_CMD[k] + ' ' + (b ?? 'default') + '\n';
  }
  return s;
}

function writeChangeMark(c: Change | undefined): string {
  if (!c) return '\n\\change_unchanged\n';
  return `\n\\change_${c.type} ${c.author} ${c.time}\n`;
}

const BREAK_AFTER = new Set(['.', '!', '?', ':', ';', ',', '\u061F', '\u061B', '\u060C']);
const BREAK_ALWAYS = new Set(['\u2014', '\u3002', '\uFF01', '\uFF1F', '\uFF1A', '\uFF1B', '\uFF0C']);

function fontDiffers(a: FontState, b: FontState): boolean {
  for (const k of FONT_KEYS) {
    if (k === 'lang' && b[k] === undefined) continue;
    if (a[k] !== b[k]) return true;
  }
  return false;
}

export function writeParagraph(p: Paragraph): string {
  const out: string[] = [];
  out.push('\n\\begin_layout ' + p.layout + '\n');
  out.push(writeParams(p));
  let font: FontState = {};
  let change: Change | undefined;
  let column = 0;
  let pos = 0; // character position within paragraph (insets count as 1)

  for (const it of p.items) {
    if (!changesEqual(change, it.change)) {
      out.push(writeChangeMark(it.change));
      change = it.change;
      column = 0;
    }
    if (fontDiffers(font, it.font)) {
      out.push(writeFontChanges(font, it.font));
      const keepLang = font.lang;
      font = { ...it.font };
      if (font.lang === undefined && keepLang !== undefined) font.lang = keepLang;
      column = 0;
    }
    switch (it.kind) {
      case 'text': {
        const t = it.text;
        let buf = '';
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '\\') {
            buf += '\n\\backslash\n'; column = 0;
          } else if (BREAK_AFTER.has(c)) {
            if (i + 1 < t.length ? t[i + 1] === ' ' : nextCharIsSpace(p, it)) { buf += c + '\n'; column = 0; }
            else buf += c;
          } else if (BREAK_ALWAYS.has(c)) {
            buf += c + '\n'; column = 0;
          } else {
            if (column > 500) { buf += '\n'; column = 0; }
            buf += c; column++;
          }
        }
        out.push(buf);
        pos += t.length;
        break;
      }
      case 'special':
        out.push(it.token + (it.arg ? ' ' + it.arg : '') + '\n');
        pos++;
        break;
      case 'unknown':
        out.push(it.line + '\n');
        break;
      case 'inset':
        if (pos) out.push('\n');
        out.push('\\begin_inset ' + writeInset(it.inset) + '\n\\end_inset\n\n');
        column = 0;
        pos++;
        break;
    }
  }
  // A paragraph may end inside a change; LyX writes the running change up to size() and
  // then the "unchanged" mark is implied by \end_layout. (Changes::lyxMarkChange at i==size()
  // compares with lookupChange(size()) which is UNCHANGED unless the paragraph end is changed.)
  if (!changesEqual(change, p.endChange)) out.push(writeChangeMark(p.endChange));
  out.push('\n\\end_layout\n');
  return out.join('');
}

/** LyX checks the *next character in the paragraph* even across font changes. */
function nextCharIsSpace(p: Paragraph, it: { kind: string }): boolean {
  const idx = p.items.indexOf(it as any);
  const n = p.items[idx + 1];
  return !!n && n.kind === 'text' && n.text.startsWith(' ');
}

export function writeInset(ins: Inset): string {
  switch (ins.type) {
    case 'Formula':
      if (ins.inline) return 'Formula ' + ins.latex;
      return 'Formula \n' + ins.latex + '\n';
    case 'FormulaMacro':
      return 'FormulaMacro\n' + ins.lines.join('\n');
    case 'Leaf': {
      let s = ins.name + (ins.arg ? ' ' + ins.arg : '');
      for (const l of ins.params) s += '\n' + l;
      return s;
    }
    case 'Text': {
      let s = ins.name + (ins.arg ? ' ' + ins.arg : '') + '\n';
      for (const l of ins.params) s += l + '\n';
      if (ins.status) s += 'status ' + ins.status + '\n';
      s += writeParagraphs(ins.paragraphs);
      return s;
    }
    case 'Tabular':
      return writeTabular(ins);
    case 'Raw':
      return ins.firstLine + ins.lines.map(l => '\n' + l).join('');
  }
}

function attrs(a: [string, string][]): string {
  return a.map(([k, v]) => ` ${k}="${v}"`).join('');
}

function writeTabular(t: TabularInset): string {
  let s = 'Tabular\n';
  s += '<lyxtabular' + attrs(t.attrs) + '>\n';
  s += '<features' + attrs(t.features) + '>\n';
  for (const c of t.columns) s += '<column' + attrs(c.attrs) + '>\n';
  for (const r of t.rows) {
    s += '<row' + attrs(r.attrs) + '>\n';
    for (const c of r.cells) {
      s += '<cell' + attrs(c.attrs) + '>\n';
      s += '\\begin_inset Text\n';
      s += writeParagraphs(c.paragraphs);
      s += '\n\\end_inset\n';
      s += '</cell>\n';
    }
    s += '</row>\n';
  }
  s += '</lyxtabular>\n';
  return s;
}
