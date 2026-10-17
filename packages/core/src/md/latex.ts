/**
 * A markdown document made ready for the LaTeX writer (its PDF is built from LaTeX): images on the
 * web become links (LaTeX cannot include them), raw HTML is left out, code blocks name a language
 * the listings package knows (or none). The server and the VS Code extension write the result with
 * writeTex and build it with LuaLaTeX (markdown is UTF-8 through and through).
 *
 * The page is set by pandoc's variables in the YAML front matter, so the same file comes out alike
 * with `pandoc -o x.pdf`: `geometry` (geometry's options: `margin=2cm`, or a list), `papersize`
 * (`a4`, `letter`…), `fontsize` (`10pt`/`11pt`/`12pt`), `linestretch` and `header-includes` (LaTeX
 * for the preamble). Anything else in the front matter is left alone.
 */
import type { Header, Item, LyxDocument, Paragraph } from '../lyx/ast.ts';
import { setHeaderBlock } from '../lyx/ast.ts';

/** listings' names of the languages a fenced code block may name (others are set without highlighting) */
const LISTINGS_LANGUAGES: Record<string, string> = {
  python: 'Python', py: 'Python', java: 'Java', c: 'C', 'c++': 'C++', cpp: 'C++', bash: 'bash', sh: 'sh', shell: 'sh', perl: 'Perl', ruby: 'Ruby',
  php: 'PHP', r: 'R', matlab: 'Matlab', tex: 'TeX', latex: '[LaTeX]TeX', haskell: 'Haskell', lisp: 'Lisp', sql: 'SQL', html: 'HTML', xml: 'XML',
  fortran: 'Fortran', make: 'make', makefile: 'make', lua: 'Lua', octave: 'Octave', ocaml: '[Objective]Caml', erlang: 'erlang', gnuplot: 'Gnuplot', csharp: '[Sharp]C', 'c#': '[Sharp]C',
};

export function markdownForLatex(doc: LyxDocument): LyxDocument {
  const copy: LyxDocument = JSON.parse(JSON.stringify(doc));
  const fix = (pars: Paragraph[]) => {
    for (const p of pars) {
      p.items = p.items.flatMap((it): Item[] => {
        if (it.kind !== 'inset') return [it];
        const ins = it.inset;
        if (ins.type === 'Text' && ins.name === 'ERT') return [];
        if (ins.type === 'Leaf' && ins.name === 'Graphics') {
          const file = (ins.params.find(l => /^\tfilename /.test(l)) ?? '').replace(/^\tfilename /, '').trim();
          ins.params = ins.params.filter(l => !/^\t(link |special alt=)/.test(l));
          if (/^[a-z][a-z0-9+.-]*:/i.test(file)) return [{ ...it, inset: { type: 'Leaf', name: 'CommandInset', arg: 'href', params: ['LatexCommand href', 'name "[image]"', `target "${file.replace(/"/g, '')}"`, 'literal "true"'] } }];
        }
        if (ins.type === 'Text' && ins.name === 'listings') {
          ins.params = ins.params.map(l => l.replace(/^lstparams "language=([^",]*)"$/, (_m, lang: string) => {
            const known = LISTINGS_LANGUAGES[lang.toLowerCase()];
            return `lstparams "${known ? 'language=' + known : ''}"`;
          })).filter(l => !/^(indented|fence) /.test(l));
        }
        if (ins.type === 'Text') fix(ins.paragraphs);
        if (ins.type === 'Tabular') for (const r of ins.rows) for (const c of r.cells) fix(c.paragraphs);
        return [it];
      });
    }
  };
  fix(copy.body);
  pageFromFrontMatter(copy.header, frontMatterVars(copy.preamble));
  copy.preamble = [];
  return copy;
}

/**
 * The front matter's top-level keys (`---` … `---` / `...`): a value, a list (`[a, b]` or `- a` lines)
 * or a block (`|` / `>` and indented lines). Enough YAML for pandoc's variables; quotes are taken off.
 */
export function frontMatterVars(lines: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!/^---\s*$/.test(lines[0] ?? '')) return out;
  const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  let key: string | null = null, block = false;
  for (const line of lines.slice(1)) {
    if (/^(---|\.\.\.)\s*$/.test(line)) break;
    const top = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (top) {
      key = top[1]; block = false;
      const v = top[2].replace(/\s+#.*$/, '');
      if (v === '|' || v === '>' || v === '|-' || v === '>-') { out[key] = []; block = true; }
      else if (/^\[.*\]$/.test(v)) out[key] = v.slice(1, -1).split(',').map(unquote).filter(Boolean);
      else out[key] = v ? unquote(v) : [];
      continue;
    }
    if (!key || !Array.isArray(out[key])) continue;
    const arr = out[key] as string[];
    const item = block ? null : /^\s+-\s+(.*)$/.exec(line);
    // `- |`: a block of lines as the item (pandoc's header-includes)
    if (item && /^[|>]-?$/.test(item[1].trim())) { block = true; continue; }
    if (item) { arr.push(unquote(item[1])); continue; }
    const text = /^\s+(.*)$/.exec(line);
    // (a raw-LaTeX fence round them, as pandoc's examples write it, is not LaTeX)
    if (text && block && !/^```/.test(text[1])) arr.push(text[1]);
  }
  return out;
}

/** pandoc's page variables (see the top of the file) as the document's settings and preamble */
function pageFromFrontMatter(h: Header, vars: Record<string, string | string[]>): void {
  const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? v.split(/,\s*/) : []).map(x => x.trim()).filter(Boolean);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
  const set = (key: string, value: string) => {
    const i = h.lines.findIndex(l => l === '\\' + key || l.startsWith('\\' + key + ' '));
    if (i >= 0) h.lines[i] = `\\${key} ${value}`; else h.lines.push(`\\${key} ${value}`);
  };
  const paper = one(vars.papersize).toLowerCase().replace(/^us-?/, '').replace(/paper$/, '');
  if (/^([abc]\d|letter|legal|executive)$/.test(paper)) set('papersize', paper);
  const size = /^(\d+)\s*pt$/.exec(one(vars.fontsize));
  if (size) set('paperfontsize', size[1]);
  const stretch = Number(one(vars.linestretch));
  if (stretch > 0 && stretch < 5) set('spacing', `other ${stretch}`);
  const preamble: string[] = [];
  // only what LaTeX's own key=value syntax allows (no braces or backslashes: those belong in header-includes)
  const geometry = list(vars.geometry).filter(o => /^[\w.-]+(=[\w.\s-]+)?$/.test(o));
  if (geometry.length) preamble.push(`\\usepackage[${geometry.join(',')}]{geometry}`);
  preamble.push(...list(vars['header-includes']).filter(l => !/^\s*\\documentclass/.test(l)));
  if (preamble.length) setHeaderBlock(h, 'preamble', preamble);
}
