/**
 * LaTeX in HTML deliverables beyond formulas — what makes a deck feel like beamer: citations from
 * the project's BibTeX files (`\cite{key}`, natbib's `\citep` / `\citet` …) with a list of
 * references where the page has an element of class "ol-bibliography", the macros of a .tex file
 * of the project (`<link rel="overlyx-macros" href="…">`) in its formulas, and step-by-step reveals
 * (`data-step`, `data-steps`). Numbered equations and \ref / \eqref are MathJax's own (runtime/math.ts).
 *
 * The page's text keeps the LaTeX as written; the runtime renders it. The servers (web and VS Code)
 * hand the runtime what it needs with the page (deckextras.ts: the cited entries, the macros), the
 * editor sends entries cited later. (Nothing here imports the LyX parser: the runtime bundles it.)
 */
import type { BibEntry } from '../bib.ts';

/* ------------------------------------------------------------------ citations */

export type CiteStyle = 'numeric' | 'authoryear';

/** a citation command as written: `\citep[see][p.~5]{a,b}` */
export interface CiteMatch { cmd: string; pre: string; post: string; keys: string[]; index: number; src: string }

const CITE_SRC = String.raw`\\(cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|nocite|parencite|textcite|autocite)\*?(?:\[([^\]]*)\])?(?:\[([^\]]*)\])?\{([^}]*)\}`;
/** citation commands (a fresh RegExp each time: it is global) */
export const citeRegExp = (): RegExp => new RegExp(CITE_SRC, 'g');
/** a text has a citation command in it */
export const hasCite = (s: string): boolean => /\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|nocite|parencite|textcite|autocite)\*?[[{]/.test(s);

export function findCites(text: string): CiteMatch[] {
  const out: CiteMatch[] = [];
  for (const m of text.matchAll(citeRegExp())) {
    // natbib: one optional argument is the note after, two are before and after
    const two = m[3] !== undefined;
    out.push({ cmd: m[1], pre: two ? m[2] ?? '' : '', post: two ? m[3] ?? '' : m[2] ?? '', keys: m[4].split(',').map(k => k.trim()).filter(Boolean), index: m.index!, src: m[0] });
  }
  return out;
}

/** the keys a page cites, in the order of their first citation (comments, scripts and styles left out) */
export function citedKeys(html: string): string[] {
  const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const seen = new Set<string>();
  for (const c of findCites(text)) for (const k of c.keys) seen.add(k);
  return [...seen];
}

/** what the runtime needs of a bibliography entry */
export interface CiteEntry {
  key: string; type: string;
  /** the authors (or editors) as written in the file, "and"-separated */
  authors: string;
  /** "Knuth", "Knuth and Lamport", "Knuth et al." */
  short: string;
  year: string; title: string;
  /** journal, book title, publisher, school … — where it appeared */
  venue: string;
  volume?: string; number?: string; pages?: string; url?: string; doi?: string;
}

export function citeEntry(e: BibEntry | { key: string; type?: string; fields?: Record<string, string>; authorShort?: string; author?: string; year?: string; title?: string }): CiteEntry {
  const f = e.fields ?? {};
  const authors = f.author ?? f.editor ?? '';
  const venue = f.journal ?? f.journaltitle ?? f.booktitle ?? (e.type === 'phdthesis' || e.type === 'mastersthesis' ? f.school : undefined) ?? f.institution ?? f.publisher ?? f.howpublished ?? (f.eprint ? `arXiv:${f.eprint}` : '');
  const out: CiteEntry = {
    key: e.key, type: e.type ?? 'misc',
    authors: texToText(authors), short: texToText((e as BibEntry).authorShort ?? (e as { author?: string }).author ?? ''),
    year: e.year ?? (f.year ?? f.date ?? '').slice(0, 4), title: texToText(f.title ?? e.title ?? ''), venue: texToText(venue),
  };
  if (f.volume) out.volume = texToText(f.volume);
  if (f.number) out.number = texToText(f.number);
  if (f.pages) out.pages = texToText(f.pages).replace(/-+/g, '–');
  if (f.doi) out.doi = f.doi.trim();
  if (f.url) out.url = f.url.trim();
  return out;
}

const ACCENTS: Record<string, Record<string, string>> = {
  '"': { a: 'ä', o: 'ö', u: 'ü', e: 'ë', i: 'ï', A: 'Ä', O: 'Ö', U: 'Ü', y: 'ÿ' },
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', s: 'ś', z: 'ź', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', C: 'Ć', S: 'Ś' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', O: 'Ô' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
  c: { c: 'ç', C: 'Ç', s: 'ş', S: 'Ş' },
  v: { c: 'č', s: 'š', z: 'ž', r: 'ř', e: 'ě', n: 'ň', C: 'Č', S: 'Š', Z: 'Ž', R: 'Ř' },
  u: { a: 'ă', g: 'ğ', A: 'Ă' },
  '=': { a: 'ā', e: 'ē', o: 'ō', u: 'ū' },
  '.': { z: 'ż', Z: 'Ż', e: 'ė' },
  H: { o: 'ő', u: 'ű', O: 'Ő', U: 'Ű' },
  k: { a: 'ą', e: 'ę', A: 'Ą', E: 'Ę' },
};
const SYMBOLS: Record<string, string> = { ss: 'ß', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', l: 'ł', L: 'Ł', i: 'ı', '&': '&', '%': '%', '$': '$', '#': '#', _: '_' };

/** BibTeX field text as plain text: accents and dashes made characters, braces and font commands gone */
export function texToText(s: string): string {
  let t = s;
  // \"{o}, \"o, {\"o}, \c{c}, \v s
  t = t.replace(/\\(["'`^~=.])\s*\{?\\?([A-Za-z])\}?/g, (m, a: string, c: string) => ACCENTS[a]?.[c] ?? c);
  t = t.replace(/\\([cvuHk])\s*(?:\{([A-Za-z])\}|\s([A-Za-z]))/g, (m, a: string, c1?: string, c2?: string) => ACCENTS[a]?.[c1 ?? c2 ?? ''] ?? (c1 ?? c2 ?? ''));
  t = t.replace(/\\(ss|aa|AA|ae|AE|oe|OE|o|O|l|L|i)(?![A-Za-z])\s?/g, (m, n: string) => SYMBOLS[n] ?? '');
  t = t.replace(/\\([&%$#_])/g, (m, c: string) => SYMBOLS[c] ?? c);
  t = t.replace(/---/g, '—').replace(/--/g, '–').replace(/~/g, ' ').replace(/``|''/g, '"');
  t = t.replace(/\\(La)?TeX(?![A-Za-z])\s?/g, (m, la?: string) => (la ? 'LaTeX' : 'TeX'));
  // \emph{x}, \textit{x}, \url{x} …: their text; other commands go
  t = t.replace(/\\[A-Za-z]+\*?\s*/g, '').replace(/[{}]/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** "Last, First and First Last" → "First Last and First Last" (BibTeX's two name forms) */
export function authorNames(authors: string): string[] {
  if (!authors.trim()) return [];
  return authors.split(/\s+and\s+/i).map(a => {
    const p = a.trim();
    if (/^others$/i.test(p)) return 'et al.';
    const c = p.split(',').map(x => x.trim());
    return c.length >= 2 ? `${c.slice(1).join(' ')} ${c[0]}`.trim() : p;
  });
}

/** numbers of the cited keys in the order they are first cited (as `unsrt` numbers them) */
export function citeNumbers(keysInOrder: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of keysInOrder) if (!out.has(k)) out.set(k, out.size + 1);
  return out;
}

/** "1, 2, 3, 5" → "1–3, 5" */
function compress(ns: number[]): string {
  const s = [...new Set(ns)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j - i >= 2 ? `${s[i]}–${s[j]}` : j > i ? `${s[i]}, ${s[j]}` : String(s[i]));
    i = j + 1;
  }
  return parts.join(', ');
}

/**
 * The text a citation shows: numeric `[1, 3]` / `[see 1, p. 5]`, natbib's `Knuth [1]` (\citet);
 * author-year `Knuth (1984)` (\citet, \cite), `(Knuth, 1984; Lamport, 1994)` (\citep). A key the
 * bibliography lacks shows `?` (author-year: the key in bold, as LaTeX does — here plain).
 */
export function citeText(c: Pick<CiteMatch, 'cmd' | 'pre' | 'post' | 'keys'>, numbers: Map<string, number>, entries: Map<string, CiteEntry>, style: CiteStyle): string {
  if (c.cmd === 'nocite') return '';
  const note = (s: string) => {
    const pre = texToText(c.pre), post = texToText(c.post);
    return (pre ? pre + ' ' : '') + s + (post ? ', ' + post : '');
  };
  const who = (k: string) => entries.get(k)?.short || (entries.has(k) ? entries.get(k)!.key : '?');
  const year = (k: string) => entries.get(k)?.year || (entries.has(k) ? '' : '?');
  if (style === 'numeric') {
    const ns = c.keys.map(k => (entries.size && !entries.has(k) ? NaN : numbers.get(k) ?? NaN));
    const num = ns.some(n => Number.isNaN(n)) ? c.keys.map((k, i) => (Number.isNaN(ns[i]) ? '?' : String(ns[i]))).join(', ') : compress(ns);
    switch (c.cmd) {
      case 'citet': case 'textcite': return c.keys.map(k => `${who(k)} [${note(String(numbers.get(k) ?? '?'))}]`).join(', ');
      case 'citeauthor': return c.keys.map(who).join(', ');
      case 'citeyear': case 'citeyearpar': return c.keys.map(year).join(', ');
      case 'citealp': case 'citealt': return note(num);
      default: return `[${note(num)}]`;
    }
  }
  switch (c.cmd) {
    case 'citep': case 'parencite': case 'autocite': return `(${note(c.keys.map(k => `${who(k)}, ${year(k)}`).join('; '))})`;
    case 'citealp': return note(c.keys.map(k => `${who(k)}, ${year(k)}`).join('; '));
    case 'citealt': return note(c.keys.map(k => `${who(k)} ${year(k)}`).join('; '));
    case 'citeauthor': return c.keys.map(who).join(', ');
    case 'citeyear': return c.keys.map(year).join(', ');
    case 'citeyearpar': return `(${c.keys.map(year).join(', ')})`;
    default: return c.keys.map(k => `${who(k)} (${note(year(k))})`).join('; ');
  }
}

/** a reference of the list, in pieces (`em`: the title of a book, the journal): "D. Knuth. The TeXbook. Addison-Wesley, 1984." */
export function referencePieces(e: CiteEntry): { text: string; em?: boolean }[] {
  const names = authorNames(e.authors);
  const authors = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  const out: { text: string; em?: boolean }[] = [];
  if (authors) out.push({ text: authors + '. ' });
  const bookish = /^(book|phdthesis|mastersthesis|manual|techreport)$/.test(e.type);
  if (e.title) out.push(bookish ? { text: e.title, em: true } : { text: e.title }, { text: '. ' });
  if (e.venue) {
    out.push(bookish ? { text: e.venue } : { text: e.venue, em: true });
    const vol = e.volume ? `, ${e.volume}${e.number ? `(${e.number})` : ''}` : '';
    out.push({ text: `${vol}${e.pages ? `${vol ? ':' : ', '}${e.pages}` : ''}${e.year ? ', ' + e.year : ''}. ` });
  } else if (e.year) out.push({ text: e.year + '. ' });
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.trimEnd();
  return out;
}

/** the order of the list: numeric — by number; author-year — by authors, then year */
export function bibliographyOrder(keys: string[], numbers: Map<string, number>, entries: Map<string, CiteEntry>, style: CiteStyle): string[] {
  const ks = keys.filter(k => entries.has(k));
  if (style === 'numeric') return ks.sort((a, b) => (numbers.get(a) ?? 0) - (numbers.get(b) ?? 0));
  const sortName = (k: string) => { const e = entries.get(k)!; const first = authorNames(e.authors)[0] ?? e.key; return (first.split(' ').pop() ?? first).toLowerCase(); };
  return ks.sort((a, b) => sortName(a).localeCompare(sortName(b)) || (entries.get(a)!.year).localeCompare(entries.get(b)!.year));
}

/* ------------------------------------------------------------------ steps */

/** the step from which an object shows when presenting (html/steps.ts) */
export { stepOf } from './steps.ts';
