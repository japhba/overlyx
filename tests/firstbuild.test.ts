/**
 * The first build of a freshly imported paper resolves its citations and references: latexmk
 * stopped after the first pdflatex pass when TeX reported an error it recovered from (an undefined
 * macro), so bibtex never ran and every \cite / \ref was "??" until a second build (LoRA: 122 of
 * them; persona p1:F3). The build route (server export.ts) now runs latexmk with -f.
 *   npx vitest run tests/firstbuild.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-firstbuild-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const HAVE_LATEXMK = (() => { try { execFileSync('latexmk', ['-v'], { stdio: 'ignore' }); execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe('the first build', () => {
  it.skipIf(!HAVE_LATEXMK)('runs bibtex and the reruns although TeX reported an error: no "??"', async () => {
    const dir = join(ROOT, 'projects', 'u', 'p');
    writeFileSync(join(dir, 'paper.tex'), '\\documentclass{article}\n\\begin{document}\nAs shown by \\cite{smith2020}, this works \\undefinedmacro. See Section~\\ref{sec:x}.\n\\section{X}\\label{sec:x}\nText.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n');
    writeFileSync(join(dir, 'refs.bib'), '@article{smith2020, author={Smith, J.}, title={A title}, journal={J}, year={2020}}\n');
    const { buildPdf } = await import('../packages/server/src/export.ts');
    const r = await buildPdf('u/p/paper.tex');
    expect(r.pdfPath).toBeTruthy();
    const text = execFileSync('pdftotext', [r.pdfPath!, '-'], { encoding: 'utf8' });
    expect(text).toContain('[1]');            // the citation, numbered
    expect(text).toContain('Section 1');      // the reference
    expect(text).not.toContain('??');
    expect(r.log).toMatch(/Undefined control sequence/);   // the error is still reported
  }, 180_000);
});
