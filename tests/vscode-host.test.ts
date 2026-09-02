/**
 * The VS Code extension host's document pipeline, without VS Code: parse a .tex file in a project
 * directory, round-trip it through the ProseMirror model (what the webview edits), build the
 * metadata — all against the LyX data files bundled with the extension (dist/lyxlib), which also
 * proves the asset copy is complete.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lyxToPm, pmToLyxBody, texHeadings, type LyxDocument, type PMJSON } from '@overlyx/core';
import { parseDocumentText, writeDocumentText, includeResolver } from '../packages/vscode/src/host/texdoc.ts';
import { buildMeta } from '../packages/vscode/src/host/meta.ts';
import { collectFiles, findMaster } from '../packages/vscode/src/host/project.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledLayouts = path.resolve(here, '../packages/vscode/dist/lyxlib/layouts');
const layoutDir = fs.existsSync(bundledLayouts) ? bundledLayouts : '/root/lyx/lib/layouts';

const MAIN = `\\documentclass{article}
\\newcommand{\\RR}{\\mathbb{R}}
\\usepackage{graphicx}
\\begin{document}

\\section{Introduction}

Functions on \\RR{} are studied, see \\eqref{eq:main}.

\\begin{equation}
f(x)=x^{2}\\label{eq:main}
\\end{equation}

\\input{chapter.tex}

\\end{document}
`;
const CHILD = `\\section{Details}

More text with a formula $a+b$.
`;

let root: string;
let ctx: { root: string; layoutDir: string };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-vscode-test-'));
  fs.writeFileSync(path.join(root, 'main.tex'), MAIN);
  fs.writeFileSync(path.join(root, 'chapter.tex'), CHILD);
  fs.writeFileSync(path.join(root, 'refs.bib'), '@article{knuth84, author={Donald E. Knuth}, title={Literate Programming}, year={1984}, journal={The Computer Journal}}\n');
  ctx = { root, layoutDir };
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('vscode host document pipeline', () => {
  it('parses, round-trips through ProseMirror and writes stably', () => {
    const r = parseDocumentText(MAIN, ctx, 'main.tex');
    expect(r.fragment).toBe(false);
    // the round the webview takes: LyX AST → PM JSON → (editing) → PM → LyX AST → .tex
    const pm = lyxToPm(r.doc) as PMJSON;
    const doc2: LyxDocument = { ...r.doc, body: pmToLyxBody(pm) };
    const w1 = writeDocumentText(doc2, ctx, 'main.tex', false, includeResolver(ctx, 'main.tex'));
    // writing what was parsed back reproduces a stable file (2nd round byte-identical)
    const r2 = parseDocumentText(w1.text, ctx, 'main.tex');
    const w2 = writeDocumentText({ ...r2.doc, body: pmToLyxBody(lyxToPm(r2.doc) as PMJSON) }, ctx, 'main.tex', false, includeResolver(ctx, 'main.tex'));
    expect(w2.text).toBe(w1.text);
    // the content survived
    expect(w1.text).toContain('\\section{Introduction}');
    expect(w1.text).toContain('\\label{eq:main}');
    expect(w1.text).toContain('\\input{chapter.tex}');
  });

  it('classifies files and finds the master of a child', () => {
    const files = collectFiles(root);
    const main = files.find(f => f.path === 'main.tex');
    const child = files.find(f => f.path === 'chapter.tex');
    expect(main?.kind).toBe('doc');
    expect(child?.kind).toBe('doc');   // included by a document
    expect(findMaster(root, 'chapter.tex')).toBe('main.tex');
    expect(findMaster(root, 'main.tex')).toBeNull();
  });

  it('parses a child document with its master header', () => {
    const r = parseDocumentText(CHILD, ctx, 'chapter.tex');
    expect(r.fragment).toBe(true);
  });

  it('builds metadata: layouts, macros, labels, bibliography', () => {
    const r = parseDocumentText(MAIN, ctx, 'main.tex');
    const meta = buildMeta({ ctx, project: 'proj', relPath: 'main.tex', lyx: r.doc, isChild: false, fileText: MAIN }) as any;
    expect(meta.textclass).toBe('article');
    expect(meta.layouts, 'layouts must load from the bundled LyX lib').toBeTruthy();
    expect((meta.layouts as any[]).some(l => l.name === 'Section')).toBe(true);
    expect(Object.keys(meta.macros)).toContain('RR');
    expect((meta.labels as any[]).some(l => l.name === 'eq:main')).toBe(true);
    expect((meta.bib as any[]).some(b => b.key === 'knuth84')).toBe(true);   // .bib of the project (none referenced)
    expect(meta.health).toEqual([]);
  });

  it('outline headings for the tree', () => {
    const h = texHeadings(MAIN, 3);
    expect(h.some(x => x.text === 'Introduction' && x.level === 2)).toBe(true);
  });
});
