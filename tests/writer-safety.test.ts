/**
 * The writer never produces LaTeX that cannot compile from a document the editor can make:
 * a caption of several paragraphs (Enter pressed in a caption) is one paragraph in \caption{…};
 * an aligned heading has its alignment around the command, not a \par inside its argument.
 *   npx vitest run tests/writer-safety.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { walkInsets, type TextInset } from '../packages/core/src/index.ts';

const hasPdflatex = (() => { try { execFileSync('pdflatex', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
function compile(text: string): void {
  if (!hasPdflatex) return;
  const dir = mkdtempSync(join(tmpdir(), 'overlyx-writer-safety-'));
  try {
    writeFileSync(join(dir, 'main.tex'), text);
    execFileSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: dir, stdio: 'ignore', timeout: 60000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('captions', () => {
  it('a caption of two paragraphs (Enter in the caption) is written as one: no blank line in \\caption{…}', () => {
    const src = '\\documentclass{article}\n\\begin{document}\n\\listoftables\n\\begin{table}\n\\caption{Maximum path lengths of sequential operations}\n\\begin{tabular}{cc}\na & b\\\\\n\\end{tabular}\n\\end{table}\n\\end{document}\n';
    const doc = parseTex(src).doc;
    const cap = [...walkInsets(doc.body)].map(x => x.inset).find(i => i.type === 'Text' && i.name === 'Caption') as TextInset;
    const p = cap.paragraphs[0];
    const text = p.items.find(it => it.kind === 'text')!;
    if (text.kind !== 'text') throw new Error('no text');
    cap.paragraphs = [
      { ...p, items: [{ ...text, text: 'Maximum path lengths' }] },
      { ...p, items: [{ ...text, text: 'of sequential operations' }] },
    ];
    const out = writeTex(doc).text;
    expect(out).toContain('\\caption{Maximum path lengths of sequential operations}');
    expect(out).not.toMatch(/\\caption\{[^}]*\n\s*\n/);
    compile(out);
  });
});

describe('aligned headings', () => {
  it('are written as {\\centering\\section{…}\\par}, compile, and read back aligned', () => {
    const src = '\\documentclass{article}\n\\begin{document}\n\\tableofcontents\n\\raggedleft\nSome text.\n\n\\section{Conclusions}\n\\label{sec:conclusions}\n\nMore text.\n\\end{document}\n';
    const out = writeTex(parseTex(src).doc).text;
    expect(out).toContain('{\\raggedleft\\section{Conclusions}\\label{sec:conclusions}\\par}');
    expect(out).not.toContain('\\section{\\protect\\begin');
    const back = parseTex(out).doc.body;
    expect(back.find(p => p.layout === 'Section')?.params.align).toBe('right');
    expect(writeTex(parseTex(out).doc).text).toBe(out);
    compile(out);
  });

  it('the old form, \\section{\\protect\\begin{center}…\\protect\\par\\end{center}}, still reads as an aligned heading', () => {
    const src = '\\documentclass{article}\n\\begin{document}\n\\section{\\protect\\begin{center}\nConclusions\\protect\n\\par\\end{center}}\\label{sec:c}\n\nText.\n\\end{document}\n';
    const body = parseTex(src).doc.body;
    expect(body[0].layout).toBe('Section');
    expect(body[0].params.align).toBe('center');
    expect(body[0].items.some(it => it.kind === 'text' && it.text.includes('Conclusions'))).toBe(true);
    expect(body).toHaveLength(2);
  });

  it('a run-in heading (\\paragraph) is not put in a group, where LaTeX would lose it', () => {
    const src = '\\documentclass{article}\n\\begin{document}\n\\centering\nSome text.\n\n\\paragraph*{Acknowledgments.}\nThanks.\n\\end{document}\n';
    const out = writeTex(parseTex(src).doc).text;
    expect(out).toContain('\n\\paragraph*{Acknowledgments.}');
    expect(out).not.toContain('{\\centering\\paragraph');
    compile(out);
  });
});
