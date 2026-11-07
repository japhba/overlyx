/**
 * A markdown document made ready for the LaTeX writer (its PDF is built from LaTeX): images on the
 * web become links (LaTeX cannot include them), raw HTML is left out, code blocks name a language
 * the listings package knows (or none). The server and the VS Code extension write the result with
 * writeTex and build it with LuaLaTeX (markdown is UTF-8 through and through).
 *
 * The page and the type are set by the YAML front matter (md/typesetting.ts: pandoc's variables and
 * `headings`).
 */
import type { Item, LyxDocument, Paragraph } from '../lyx/ast.ts';
import { paramMap, quote, setHeaderBlock, unquote } from '../lyx/ast.ts';
import { mdTypesetting, applyTypesetting, typesettingPreamble, mdBodyFace, type LocalFont } from './typesetting.ts';
export { frontMatterVars } from './typesetting.ts';

/** listings' names of the languages a fenced code block may name (others are set without highlighting) */
const LISTINGS_LANGUAGES: Record<string, string> = {
  python: 'Python', py: 'Python', java: 'Java', c: 'C', 'c++': 'C++', cpp: 'C++', bash: 'bash', sh: 'sh', shell: 'sh', perl: 'Perl', ruby: 'Ruby',
  php: 'PHP', r: 'R', matlab: 'Matlab', tex: 'TeX', latex: '[LaTeX]TeX', haskell: 'Haskell', lisp: 'Lisp', sql: 'SQL', html: 'HTML', xml: 'XML',
  fortran: 'Fortran', make: 'make', makefile: 'make', lua: 'Lua', octave: 'Octave', ocaml: '[Objective]Caml', erlang: 'erlang', gnuplot: 'Gnuplot', csharp: '[Sharp]C', 'c#': '[Sharp]C',
};

/**
 * A link's text as LaTeX: markdown's is text (with its formulas as `$…$`), written as it is
 * (`literal`), so `_`, `#`, `%` … are escaped here — `[a_b.tex](a_b.tex)` gave "Missing $ inserted".
 */
function linkText(s: string): string {
  return s.split(/(\$[^$]+\$)/).map((part, i) => i % 2 ? part : part.replace(/[\\&_$%#{}^~]/g, ch =>
    ch === '\\' ? '\\textbackslash{}' : ch === '^' ? '\\^{}' : ch === '~' ? '\\textasciitilde{}' : '\\' + ch)).join('');
}

/** `fontFiles`: fonts the build has as files (Google fonts the server fetched), by name — loaded by file */
export function markdownForLatex(doc: LyxDocument, opts: { fontFiles?: Record<string, LocalFont> } = {}): LyxDocument {
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
        if (ins.type === 'Leaf' && ins.name === 'CommandInset' && ins.arg === 'href') {
          // (an autolink has no name: its address is the text)
          const p = paramMap(ins.params);
          const name = linkText(unquote(p.get('name')) || unquote(p.get('target')));
          ins.params = ins.params.map(l => l.startsWith('name ') ? 'name ' + quote(name) : l);
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
  // the typesetting the front matter sets (md/typesetting.ts): the settings again (idempotent — the parse
  // put them in the header already, but a model may come from elsewhere), and what the preamble needs
  const t = mdTypesetting(copy.preamble);
  const files = opts.fontFiles ?? {};
  applyTypesetting(copy.header, t);
  // (the styles are the preamble's below, before header-includes — the managed block must not set them again after it)
  copy.header.lines = copy.header.lines.filter(l => !l.startsWith('\\overlyx_styles ') && !l.startsWith('\\overlyx_includes '));
  // a font loaded by file (the preamble's) is not named in the header as well: LuaLaTeX would look for it by name
  // (nor one the preamble sets with \olmainfont: its weight, axes or features — md/typesetting.ts mdBodyFace)
  const main = mdBodyFace(t);
  for (const [key, name] of [['font_roman', t.mainfont], ['font_sans', t.sansfont], ['font_typewriter', t.monofont]] as const) {
    if (!name || !(files[name] || (key === 'font_roman' && main))) continue;
    const i = copy.header.lines.findIndex(l => l.startsWith(`\\${key} `));
    if (i >= 0) copy.header.lines[i] = `\\${key} "default" "default"`;
  }
  const preamble = typesettingPreamble(t, files);
  if (preamble.length) setHeaderBlock(copy.header, 'preamble', preamble);
  copy.preamble = [];
  return copy;
}
