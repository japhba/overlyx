/**
 * Round-trip bugs found by running real arXiv projects through OverLyX (the pre-beta corpus run):
 * each repro is a minimal real-world file that compiled as downloaded and stopped compiling (or
 * lost content) after one parse → write. Each must survive parse → write → parse unchanged, and —
 * where pdflatex is installed — still compile.
 *   npx vitest run tests/corpus-repros.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { canonical } from '../packages/core/src/tex/preserve.ts';
import { walkInsets } from '../packages/core/src/index.ts';

const hasPdflatex = (() => { try { execFileSync('pdflatex', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** parse → write with the project's files readable (local .sty / .cls) */
function save(text: string, files: Record<string, string> = {}): string {
  const readFile = (name: string) => files[name];
  const p = parseTex(text, { readFile });
  return writeTex(p.doc, { readFile, fragment: p.fragment }).text;
}

/** the written text reads back as what was read, and writing it again changes nothing */
function expectStable(text: string, files: Record<string, string> = {}): string {
  const once = save(text, files);
  const readFile = (name: string) => files[name];
  expect(parseTex(once, { readFile }).doc.body.map(canonical)).toEqual(parseTex(text, { readFile }).doc.body.map(canonical));
  expect(save(once, files)).toBe(once);
  return once;
}

/** pdflatex compiles `text` (with `files` next to it); returns the log on failure */
function compiles(text: string, files: Record<string, string> = {}): string | true {
  const dir = mkdtempSync(join(tmpdir(), 'overlyx-corpus-repro-'));
  try {
    writeFileSync(join(dir, 'main.tex'), text);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    try {
      execFileSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: dir, stdio: 'ignore', timeout: 60000 });
      return true;
    } catch {
      const log = existsSync(join(dir, 'main.log')) ? readFileSync(join(dir, 'main.log'), 'utf8') : '';
      return log.split('\n').filter(l => l.startsWith('!')).join('\n') || 'pdflatex failed';
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('corpus round-trip repros', () => {
  it('a straight " stays a straight " (\\textquotedbl does not exist in the default OT1 encoding)', () => {
    const src = '\\documentclass{article}\n\\begin{document}\nThe result shows a low "intrinsic rank" during adaptation.\n\\end{document}\n';
    const out = expectStable(src);
    expect(out).toContain('a low "intrinsic rank" during');
    expect(out).not.toContain('\\textquotedbl');
    if (hasPdflatex) expect(compiles(out)).toBe(true);
  });

  it('natbib loaded by a style file of the project is not loaded again (option clash)', () => {
    const files = { 'mystyle.sty': '\\RequirePackage{natbib}\n', 'refs.bib': '@article{smith2020, author={Smith, J.}, title={T}, journal={J}, year={2020}}\n' };
    const src = '\\documentclass{article}\n\\usepackage{mystyle}\n\\begin{document}\nAs shown by \\citet{smith2020}, this works.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n';
    const out = expectStable(src, files);
    expect(out).not.toMatch(/\\usepackage\[[^\]]*\]\{natbib\}/);
    if (hasPdflatex) expect(compiles(out, files)).toBe(true);
  });

  it('natbib loaded by a class it cannot read is loaded only when it is not loaded yet', () => {
    // the class is not readable (as a journal class from TeX Live): the managed block guards
    const files = { 'myclass.cls': '\\NeedsTeXFormat{LaTeX2e}\\ProvidesClass{myclass}\\LoadClass{article}\\RequirePackage{natbib}\n' };
    const src = '\\documentclass{myclass}\n\\begin{document}\nAs shown by \\citet{smith2020}, this works.\n\\end{document}\n';
    const out = save(src);
    expect(out).toContain('\\@ifpackageloaded{natbib}{}{\\usepackage[authoryear]{natbib}}');
    if (hasPdflatex) expect(compiles(out, files)).toBe(true);
  });

  it('a $…$ inside \\text{…} inside inline math stays inside', () => {
    const src = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nWe start assuming it. Consider $F_j \\to 0 \\text{ strongly in $L^1(B_1)$}$.\\ Thus,\n\\[\n\ta = b,\n\t\\]\nand hence it converges.\n\\end{document}\n';
    const out = expectStable(src);
    expect(out).toContain('$F_j \\to 0 \\text{ strongly in $L^1(B_1)$}$');
    const formulas = [...walkInsets(parseTex(out).doc.body)].map(x => x.inset).filter(i => i.type === 'Formula');
    expect(formulas.map(f => (f as { latex: string }).latex)).toContain('$F_j \\to 0 \\text{ strongly in $L^1(B_1)$}$');
    if (hasPdflatex) expect(compiles(out)).toBe(true);
  });

  it('{\\centering … \\par} centres what it holds, not the headings after it', () => {
    const src = '\\documentclass{article}\n\\usepackage{tikz}\n\\begin{document}\n{\\centering\n\\begin{tikzpicture}\n\\node (a) at (0,0) {A};\n\\end{tikzpicture}\\par}\n\\medskip\n\n\\paragraph*{Acknowledgments.}\nThanks everyone.\n\n\\section{Next section}\nMore text here.\n\\end{document}\n';
    const out = expectStable(src);
    expect(out).toContain('\\paragraph*{Acknowledgments.}');
    expect(out).toContain('\\section{Next section}');
    expect(out.match(/\\begin\{center\}/g)).toHaveLength(1);
    const pars = parseTex(out).doc.body;
    expect(pars.filter(p => p.params.align === 'center')).toHaveLength(1);
    if (hasPdflatex) expect(compiles(out)).toBe(true);
  });

  it('the row under a \\multirow keeps its cells in their columns', () => {
    const src = '\\documentclass{article}\n\\usepackage{multirow}\n\\begin{document}\n\\begin{table}\n\\centering\n\\begin{tabular}{l|c|c|c|}\n\\hline\n  \\multirow{2}{*}{Group A}  & $X_{1}$ & 68.8 & 69.6 \\\\\n                            & $X_1, X_2$ & 73.4 & 73.3 \\\\\n\\hline\n\\end{tabular}\n\\end{table}\n\\end{document}\n';
    const out = expectStable(src);
    expect(out).toMatch(/\n *& \$X_1, X_2\$ & 73\.4 & 73\.3\\tabularnewline/);
    if (hasPdflatex) expect(compiles(out)).toBe(true);
  });

  it('what a file has under a \\multirow is kept there', () => {
    const src = '\\documentclass{article}\n\\usepackage{multirow}\n\\begin{document}\n\\begin{tabular}{ll}\n\\multirow{2}{*}{A} & 1 \\\\\nnote & 2 \\\\\n\\end{tabular}\n\\end{document}\n';
    const out = expectStable(src);
    expect(out).toContain('note & 2');
  });

  it('a \\providecommand in the body is written, not dropped', () => {
    const src = '\\documentclass{article}\n\\begin{document}\nText.\n\n\\providecommand{\\bysame}{\\leavevmode\\hbox to3em{\\hrulefill}\\thinspace}\nMore \\bysame{} text.\n\\end{document}\n';
    const out = expectStable(src);
    expect(out).toContain('\\providecommand{\\bysame}{\\leavevmode\\hbox to3em{\\hrulefill}\\thinspace}');
    if (hasPdflatex) expect(compiles(out)).toBe(true);
  });
});
