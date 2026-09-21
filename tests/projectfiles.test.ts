/**
 * Which .tex files of a project are documents (opened in the document editor) and which are plain
 * LaTeX sources (opened as text): \begin{document}, inclusion from a document's body — and the
 * settings line OverLyX writes, which marks a fragment edited on its own (a plan, notes) as a
 * document although no master includes it. Without that rule such a file, written by the VS Code
 * extension and pushed to the server, opened in the text editor on the web.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(process.env.OVERLYX_SCRATCH ?? os.tmpdir(), 'overlyx-projectfiles-'));
process.env.OVERLYX_DATA_DIR = path.join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = path.join(ROOT, 'projects');
const { listProjects, isDocumentFile, findMaster } = await import('../packages/server/src/projects.ts');
const { hasSettingsLine } = await import('../packages/core/src/tex/preamble.ts');

const P = path.join(ROOT, 'projects', 'paper');
beforeAll(() => {
  fs.mkdirSync(P, { recursive: true });
  fs.writeFileSync(path.join(P, 'main.tex'), '\\documentclass{article}\n\\input{macros}\n% a comment quoting \\begin{document} does not count\n\\begin{document}\n\\input{chapter}\n\\end{document}\n');
  fs.writeFileSync(path.join(P, 'chapter.tex'), '\\section{Chapter}\nText.\n');
  fs.writeFileSync(path.join(P, 'macros.tex'), '\\newcommand{\\RR}{\\mathbb{R}}\n');
  fs.writeFileSync(path.join(P, 'preamble.tex'), '\\usepackage{amsmath}\n');
  // a fragment OverLyX saved on its own (a plan, notes): no \begin{document}, nobody includes it
  fs.writeFileSync(path.join(P, 'plan.tex'), '%% overlyx-settings: {"textclass":"article"}\n\n\\section{Plan}\n\\begin{itemize}\n\\item first\n\\end{itemize}\n');
  fs.writeFileSync(path.join(P, 'notes.tex'), '\\section{Loose notes}\nNot written by OverLyX.\n');
  fs.writeFileSync(path.join(P, 'refs.bib'), '@article{k, title={T}}\n');
});
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

const kinds = () => Object.fromEntries((listProjects().find(p => p.name === 'paper')?.files ?? []).map(f => [f.path, f.kind]));

describe('project file classification', () => {
  it('documents: \\begin{document}, children of a document body, fragments OverLyX wrote', () => {
    const k = kinds();
    expect(k['main.tex']).toBe('doc');
    expect(k['chapter.tex']).toBe('doc');   // \input from the body
    expect(k['plan.tex']).toBe('doc');      // settings line: OverLyX saved it as a document
    expect(k['macros.tex']).toBe('tex');    // preamble \input
    expect(k['preamble.tex']).toBe('tex');
    expect(k['notes.tex']).toBe('tex');     // a hand-written fragment nobody includes stays plain text
    expect(k['refs.bib']).toBe('bib');
  });

  it('isDocumentFile agrees (the text-file API refuses documents)', () => {
    expect(isDocumentFile('paper', 'plan.tex')).toBe(true);
    expect(isDocumentFile('paper', 'chapter.tex')).toBe(true);
    expect(isDocumentFile('paper', 'macros.tex')).toBe(false);
    expect(isDocumentFile('paper', 'notes.tex')).toBe(false);
    expect(isDocumentFile('paper', 'refs.bib')).toBe(false);
  });

  it('the settings line does not make a fragment a master', () => {
    expect(findMaster('paper', 'plan.tex')).toBeNull();
    expect(findMaster('paper', 'chapter.tex')).toBe('main.tex');
  });

  it('hasSettingsLine: at the top of a fragment or inside the managed block, not mid-line', () => {
    expect(hasSettingsLine('%% overlyx-settings: {"textclass":"article"}\n\\section{A}\n')).toBe(true);
    expect(hasSettingsLine('\\documentclass{article}\n%% OverLyX ---\n  %% overlyx-settings: {}\n%% end OverLyX ---\n')).toBe(true);
    expect(hasSettingsLine('The marker %% overlyx-settings: appears mid-line only.\n')).toBe(false);
    expect(hasSettingsLine('')).toBe(false);
  });
});
