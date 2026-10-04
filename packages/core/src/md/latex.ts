/**
 * A markdown document made ready for the LaTeX writer (its PDF is built from LaTeX): images on the
 * web become links (LaTeX cannot include them), raw HTML is left out, code blocks name a language
 * the listings package knows (or none). The server and the VS Code extension write the result with
 * writeTex and build it with LuaLaTeX (markdown is UTF-8 through and through).
 */
import type { Item, LyxDocument, Paragraph } from '../lyx/ast.ts';

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
  copy.preamble = [];
  return copy;
}
