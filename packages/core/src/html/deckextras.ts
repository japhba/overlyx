/**
 * What an HTML deliverable needs besides its own files, given to the runtime with the page by the
 * servers that serve it (web: server deliverables.ts; VS Code: host/deliverables.ts): the entries
 * of the keys it cites and the macros of the .tex files it links (refs.ts says what for).
 */
import { parseBibtex, type BibEntry } from '../bib.ts';
import { macrosFromLatex } from '../macros.ts';
import { citedKeys, citeEntry, type CiteEntry, type CiteStyle } from './refs.ts';

/** MathJax's form of a macro: its definition, [definition, arguments] or [definition, arguments, default of the first] */
export type MathJaxMacro = string | [string, number] | [string, number, string];

/** links of a page: `<link rel="overlyx-macros" href="…">`, `<link rel="overlyx-bibliography" href="…">` */
export function pageLinks(html: string, rel: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const r = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (r?.toLowerCase() === rel && href) out.push(href[1] ?? href[2] ?? href[3]);
  }
  return out;
}

/** the citation style a page asks for: `<meta name="overlyx-citations" content="authoryear">` (numeric otherwise) */
export function pageCiteStyle(html: string): CiteStyle {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*["']?overlyx-citations\b/i.test(m[0])) continue;
    return /\bcontent\s*=\s*["']?\s*author/i.test(m[0]) ? 'authoryear' : 'numeric';
  }
  return 'numeric';
}

/** macros of LaTeX text (its \newcommand, \renewcommand, \def, \DeclareMathOperator …) in MathJax's form; `inputs`: the files it \input s */
export function mathJaxMacros(tex: string): { macros: Record<string, MathJaxMacro>; inputs: string[] } {
  const { macros, inputs } = macrosFromLatex(tex, 'file');
  const out: Record<string, MathJaxMacro> = {};
  for (const m of macros) {
    if (!/^[A-Za-z]+$/.test(m.name) || !m.def) continue;
    out[m.name] = m.args === 0 ? m.def : m.optional !== undefined ? [m.def, m.args, m.optional] : [m.def, m.args];
  }
  return { macros: out, inputs };
}

/** what the page's server gives the runtime with it (window.__OL) */
export interface DeckExtras { bib?: Record<string, CiteEntry>; citeStyle?: CiteStyle; macros?: Record<string, MathJaxMacro> }

/** how a server reads the project for `deckExtras` (paths relative to the project) */
export interface DeckIO {
  /** a text file of the project, or null */
  read(rel: string): string | null;
  /** the project's .bib files */
  bibFiles(): string[];
  /** the entries of a .bib file (a server caches them) */
  bibEntries?(rel: string): BibEntry[];
  /** `href` of the page at `pageRel`, relative to the project (null: outside it) */
  resolve(pageRel: string, href: string): string | null;
}

/**
 * What a page needs besides its own files: the entries of the keys it cites (from its
 * `overlyx-bibliography` links, else every .bib file of the project), its citation style, and the
 * macros of its `overlyx-macros` links (with the files they \input).
 */
export function deckExtras(html: string, pageRel: string, io: DeckIO): DeckExtras {
  const out: DeckExtras = {};
  const keys = citedKeys(html);
  if (keys.length || /class\s*=\s*["'][^"']*\bol-bibliography\b/.test(html)) {
    const style = pageCiteStyle(html);
    if (style !== 'numeric') out.citeStyle = style;
    const linked = pageLinks(html, 'overlyx-bibliography').map(h => io.resolve(pageRel, h)).filter((r): r is string => !!r);
    const files = linked.length ? linked : io.bibFiles();
    const want = new Set(keys);
    const bib: Record<string, CiteEntry> = {};
    for (const f of files) {
      if (!want.size) break;
      let entries: BibEntry[];
      try { entries = io.bibEntries ? io.bibEntries(f) : parseBibtex(io.read(f) ?? ''); } catch { continue; }
      for (const e of entries) if (want.has(e.key)) { bib[e.key] = citeEntry(e); want.delete(e.key); }
    }
    out.bib = bib;
  }
  const macroLinks = pageLinks(html, 'overlyx-macros');
  if (macroLinks.length) {
    const macros: Record<string, MathJaxMacro> = {};
    const seen = new Set<string>();
    const load = (rel: string | null, depth: number) => {
      if (!rel || seen.has(rel) || depth > 4) return;
      seen.add(rel);
      const text = io.read(rel);
      if (text === null) return;
      const r = mathJaxMacros(text);
      // (an \input file's macros first, as TeX reads them; the including file's win)
      for (const inp of r.inputs) load(io.resolve(rel, /\.\w+$/.test(inp) ? inp : inp + '.tex'), depth + 1);
      Object.assign(macros, r.macros);
    };
    for (const h of macroLinks) load(io.resolve(pageRel, h), 0);
    out.macros = macros;
  }
  return out;
}
