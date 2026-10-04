/**
 * The writer never produces LaTeX that cannot compile from a document the editor can make:
 * a caption of several paragraphs (Enter pressed in a caption) is one paragraph in \caption{…};
 * an aligned heading has its alignment around the command, not a \par inside its argument; an
 * environment kept as raw LaTeX (titlepage, …) is never split across alignment environments or
 * font groups, and what is declared inside it ends with it.
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
/** Do the environments and braces of `text` nest (comments left out)? */
function nests(text: string): boolean {
  const stack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '%') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '\\') {
      const m = /^\\(begin|end)\{([^}]*)\}/.exec(text.slice(i, i + 100));
      if (!m) { i++; continue; }
      if (m[1] === 'begin') stack.push(m[2]); else if (stack.pop() !== m[2]) return false;
      i += m[0].length - 1;
      continue;
    }
    if (c === '{') stack.push('{');
    else if (c === '}' && stack.pop() !== '{') return false;
  }
  return stack.length === 0;
}

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

describe('environments kept as raw LaTeX', () => {
  const TITLEPAGE = '\\documentclass{article}\n\\begin{document}\n\nBody first.\n\n\\begin{titlepage}\n    \\centering\n    {\\Large A title\\par}\n\n    Bit flip (gate $X$).\n\\end{titlepage}\n\nAfter the title page.\n\n\\end{document}\n';

  it('a \\centering inside a titlepage stays inside it: no center environment splitting it, nothing after it centred', () => {
    const doc = parseTex(TITLEPAGE).doc;
    expect(doc.body.every(p => !p.params.align)).toBe(true);
    const out = writeTex(doc).text;
    expect(out).toContain('\\begin{titlepage}');
    expect(out).toContain('\\centering');
    expect(out).not.toContain('\\begin{center}');
    expect(nests(out)).toBe(true);
    expect(writeTex(parseTex(out).doc).text).toBe(out);
    compile(out);
  });

  it('an outer alignment around a raw environment is one alignment environment around all of it', () => {
    for (const src of [
      '\\documentclass{article}\n\\begin{document}\n\\begin{center}\n\\begin{titlepage}\nA title\n\nBit flip.\n\\end{titlepage}\n\\end{center}\nAfter.\n\\end{document}\n',
      '\\documentclass{article}\n\\begin{document}\n\\centering\nFirst.\n\n\\begin{titlepage}\nA title\n\nBit flip.\n\\end{titlepage}\n\nAfter.\n\\end{document}\n',
    ]) {
      const out = writeTex(parseTex(src).doc).text;
      expect(nests(out)).toBe(true);
      expect(writeTex(parseTex(out).doc).text).toBe(out);
      compile(out);
    }
  });

  it('a font size around a raw environment is not one group per paragraph across its \\begin and \\end', () => {
    const src = '\\documentclass{article}\n\\begin{document}\nText.\n\n{\\small\\begin{quotation} We compare.\n\nThen more.\n\\end{quotation}}\n\nAfter.\n\\end{document}\n';
    const out = writeTex(parseTex(src).doc).text;
    expect(nests(out)).toBe(true);
    compile(out);
  });

  it('a heading inside a raw environment stays raw: the theorem around it is not split', () => {
    const src = '\\documentclass{article}\n\\usepackage{amsthm}\n\\newtheorem{lemma}{Lemma}\n\\newenvironment{myproof}{\\par Proof.}{\\par}\n\\begin{document}\n\\begin{lemma}\nTrue.\n\n\\begin{myproof}\nWe begin.\n\n\\paragraph{Proof of (a).}\nBy the bound.\n\\end{myproof}\n\\end{lemma}\nAfter.\n\\end{document}\n';
    const out = writeTex(parseTex(src).doc).text;
    expect(out.match(/\\begin\{lemma\}/g)).toHaveLength(1);
    expect(nests(out)).toBe(true);
    compile(out);
  });

  it('\\setlength{…}{…} does not take the commands after it (and a float\'s \\end) into its raw LaTeX', () => {
    const src = '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nBefore.\n\n\\begin{table}[!ht]\n  \\caption{Models.}\n  \\centering\n  \\footnotesize\n  \\setlength{\\tabcolsep}{3.5pt}\n  \\resizebox{\\linewidth}{!}{%\n  \\begin{tabular}{ll}\n    a & b \\\\\n  \\end{tabular}}\n\\end{table}\n\nAfter the table.\n\\end{document}\n';
    const doc = parseTex(src).doc;
    expect(doc.body.map(p => p.items.some(it => it.kind === 'text' && it.text.includes('After the table')))).toEqual([false, false, true]);
    const out = writeTex(doc).text;
    expect(nests(out)).toBe(true);
    compile(out);
  });

  it('a tikzpicture inside a tikzpicture is read to its own end', () => {
    const src = '\\documentclass{article}\n\\usepackage{tikz}\n\\begin{document}\n\\begin{tikzpicture}\n\\node (A) {\\begin{tikzpicture}\\node {a};\\end{tikzpicture}};\n\\node[right of=A] {b};\n\\end{tikzpicture}\nAfter.\n\\end{document}\n';
    const out = writeTex(parseTex(src).doc).text;
    expect(nests(out)).toBe(true);
    compile(out);
  });

  it('an inline formula over commented lines keeps their line ends (joined, the comment swallows the rest)', () => {
    const src = '\\documentclass{article}\n\\usepackage{tikz}\n\\begin{document}\nThe state $\\begin{tikzpicture}[baseline]\n  \\node {a}; % a node\n  \\node {b};\n\\end{tikzpicture}$ here.\n\\end{document}\n';
    const out = writeTex(parseTex(src).doc).text;
    expect(out).toContain('% a node\n');
    expect(nests(out)).toBe(true);
    compile(out);
  });

  it('a control space at the end of an \\href text stays one ("…,}\\ }" in a bibliography)', () => {
    const src = '\\documentclass{article}\n\\usepackage{hyperref}\n\\begin{document}\nSee \\href {https://example.org/x.pdf} {\\emph {A title},\\ }and more.\n\\end{document}\n';
    const out = writeTex(parseTex(src).doc).text;
    expect(out).not.toContain('\\}');
    expect(nests(out)).toBe(true);
    compile(out);
  });
});
