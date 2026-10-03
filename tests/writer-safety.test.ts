/**
 * The writer never produces LaTeX that cannot compile from a document the editor can make:
 * a caption of several paragraphs (Enter pressed in a caption) is one paragraph in \caption{…}.
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
