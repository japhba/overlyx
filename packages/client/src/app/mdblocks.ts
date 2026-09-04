/**
 * Block structure of the markdown-lite the agent writes: fenced code, GFM tables, block quotes,
 * headings and horizontal rules are cut out line by line; everything else stays running text for
 * the inline pass (math, `code`, **bold**, links) — the transcript renders that text pre-wrapped,
 * so plain lines and list bullets keep their line breaks without any markup. Pure functions, no DOM.
 */

export type MdAlign = 'left' | 'center' | 'right' | null;

export type MdBlock =
  | { kind: 'text'; text: string }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'table'; align: MdAlign[]; head: string[]; rows: string[][] }
  | { kind: 'quote'; blocks: MdBlock[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'rule' };

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
/** a GFM delimiter row: cells of dashes with optional alignment colons, pipes optional at the ends */
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** The cells of a pipe row; `\|` is a literal pipe inside a cell. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function alignments(sep: string): MdAlign[] {
  return splitRow(sep).map(c => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
  });
}

const isTableRow = (line: string) => line.includes('|') && line.trim() !== '';

export function parseBlocks(text: string): MdBlock[] {
  const lines = text.split('\n');
  const out: MdBlock[] = [];
  let textLines: string[] = [];
  const flushText = () => {
    // trailing blank lines before a block element would double its margin
    while (textLines.length && textLines[textLines.length - 1].trim() === '') textLines.pop();
    if (textLines.length) out.push({ kind: 'text', text: textLines.join('\n') });
    textLines = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // a blank line right after a block element is the element's own spacing
    if (textLines.length === 0 && out.length && line.trim() === '' && out[out.length - 1].kind !== 'text') continue;

    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp('^\\s{0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      flushText();
      out.push({ kind: 'code', lang: fence[2], code: lines.slice(i + 1, j).join('\n') });
      i = j;   // the closing fence (or the end)
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const align = alignments(lines[i + 1]);
      if (align.length === head.length) {
        const rows: string[][] = [];
        let j = i + 2;
        for (; j < lines.length && isTableRow(lines[j]); j++) {
          const cells = splitRow(lines[j]);
          while (cells.length < head.length) cells.push('');
          rows.push(cells.slice(0, head.length));
        }
        flushText();
        out.push({ kind: 'table', align, head, rows });
        i = j - 1;
        continue;
      }
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      const inner = [quote[1]];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const q = QUOTE.exec(lines[j]);
        if (!q) break;
        inner.push(q[1]);
      }
      flushText();
      out.push({ kind: 'quote', blocks: parseBlocks(inner.join('\n')) });
      i = j - 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { flushText(); out.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); continue; }
    if (RULE.test(line)) { flushText(); out.push({ kind: 'rule' }); continue; }
    textLines.push(line);
  }
  flushText();
  return out;
}
