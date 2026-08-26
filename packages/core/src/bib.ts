/** Minimal BibTeX parser: enough for citation pickers and author-year display. */

export interface BibEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
  /** "Author et al." style short author list */
  authorShort: string;
  year: string;
  title: string;
}

export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const strings = new Map<string, string>();
  let i = 0;
  const n = text.length;
  while (i < n) {
    const at = text.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    const m = /^([A-Za-z]+)\s*([{(])/.exec(text.slice(i));
    if (!m) continue;
    const type = m[1].toLowerCase();
    const open = m[2];
    const close = open === '{' ? '}' : ')';
    i += m[0].length;
    // read until matching close
    let depth = 1;
    let j = i;
    while (j < n && depth > 0) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === close && open === '(' && depth === 1) { depth = 0; break; }
      if (depth > 0) j++;
    }
    const body = text.slice(i, j);
    i = j + 1;
    if (type === 'comment' || type === 'preamble') continue;
    if (type === 'string') {
      const sm = /^\s*([^=\s]+)\s*=\s*([\s\S]*)$/.exec(body);
      if (sm) strings.set(sm[1].toLowerCase(), parseValue(sm[2], strings));
      continue;
    }
    const comma = body.indexOf(',');
    if (comma < 0) continue;
    const key = body.slice(0, comma).trim();
    const fields = parseFields(body.slice(comma + 1), strings);
    const authors = fields.author ?? fields.editor ?? '';
    entries.push({
      key, type, fields,
      authorShort: shortAuthors(authors),
      year: (fields.year ?? fields.date ?? '').replace(/[^0-9]/g, '').slice(0, 4) || (fields.year ?? ''),
      title: cleanTex(fields.title ?? ''),
    });
  }
  return entries;
}

function parseFields(s: string, strings: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    const m = /^\s*,?\s*([A-Za-z0-9_\-:.+/]+)\s*=\s*/.exec(s.slice(i));
    if (!m) break;
    const name = m[1].toLowerCase();
    i += m[0].length;
    // value: sequence of {..} | ".." | number | identifier joined with #
    let value = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '{') {
        let depth = 0; let j = i;
        for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') { depth--; if (!depth) break; } }
        value += s.slice(i + 1, j); i = j + 1;
      } else if (c === '"') {
        let j = i + 1; let depth = 0;
        for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; else if (s[j] === '"' && !depth) break; }
        value += s.slice(i + 1, j); i = j + 1;
      } else {
        const t = /^([A-Za-z0-9_\-:.+/]+)/.exec(s.slice(i));
        if (!t) break;
        value += /^\d+$/.test(t[1]) ? t[1] : (strings.get(t[1].toLowerCase()) ?? t[1]);
        i += t[0].length;
      }
      const hash = /^\s*#\s*/.exec(s.slice(i));
      if (hash) { i += hash[0].length; continue; }
      break;
    }
    out[name] = value.replace(/\s+/g, ' ').trim();
    const nx = /^\s*,/.exec(s.slice(i));
    if (nx) i += nx[0].length; else break;
  }
  return out;
}

function parseValue(s: string, strings: Map<string, string>): string {
  const f = parseFields('x = ' + s, strings);
  return f.x ?? '';
}

export function cleanTex(s: string): string {
  return s.replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}]/g, '').replace(/~/g, ' ').replace(/\s+/g, ' ').trim();
}

function shortAuthors(a: string): string {
  if (!a) return '';
  const parts = a.split(/\s+and\s+/i).map(p => lastName(p.trim())).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] + ' and ' + parts[1];
  return parts[0] + ' et al.';
}

function lastName(p: string): string {
  p = cleanTex(p);
  if (p.includes(',')) return p.split(',')[0].trim();
  const w = p.split(' ').filter(Boolean);
  // "von Last" handling: take from the first lowercase particle onwards, else the last word
  const idx = w.findIndex((x, i) => i > 0 && /^[a-z]/.test(x));
  return idx >= 0 ? w.slice(idx).join(' ') : (w[w.length - 1] ?? '');
}

export function citeLabel(e: BibEntry, style: 'authoryear' | 'numerical' = 'authoryear', index?: number): string {
  if (style === 'numerical') return `[${index ?? '?'}]`;
  return `${e.authorShort || e.key}${e.year ? ', ' + e.year : ''}`;
}
