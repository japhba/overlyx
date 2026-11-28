/**
 * Typeset raw LaTeX objects of layout pages (packages/server/src/snippets.ts) for someone who may only
 * view the document: the document's own objects (what a build of it typesets), nothing the request
 * brings — a snippet runs in the project's build sandbox with its HOME, and a folder shared for viewing
 * is not confined to itself, so `\input{../private/…}` would read what the folder's viewer must not.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LYX_LAYOUTS } from './lyxlib';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-snippet-viewers-test');
rmSync(ROOT, { recursive: true, force: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.LYX_LAYOUT_DIR = LYX_LAYOUTS;
const P = join(ROOT, 'projects', 'jan', 'deck');
mkdirSync(join(P, 'private'), { recursive: true });
writeFileSync(join(P, 'private', 'notes.tex'), 'secret\n');
const TIKZ = String.raw`\tikz\draw[orange,thick] (0,0) circle (3mm);`;
const IN_GROUP = String.raw`\tikz\fill[blue] (0,0) rectangle (2mm,2mm);`;
writeFileSync(join(P, 'talk.tex'), String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\begin{olbox}{x=10mm,y=10mm,w=60mm,h=20mm}
Hello
\end{olbox}
\begin{olraw}{x=10mm,y=75mm,w=40mm,h=10mm}
${TIKZ}
\end{olraw}
\begin{olgroup}{step=2}
\begin{olraw}{x=60mm,y=75mm,w=10mm,h=10mm}
${IN_GROUP}
\end{olraw}
\end{olgroup}
\end{frame}
\end{document}
`);

const access = await import('../packages/server/src/access.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { manager } = await import('../packages/server/src/docs.ts');
const { snippetSvg, rawObjectsOf, SnippetRefused } = await import('../packages/server/src/snippets.ts');

createUser('jan', 'Jan', 'pw');
access.adoptProjects();

describe('snippets for viewers', () => {
  it('know the document\'s raw objects, also inside groups, as the editor sends them', async () => {
    const doc = await manager.open('jan/deck/talk.tex');
    expect([...rawObjectsOf(doc.toLyxDocument().body)].sort()).toEqual([IN_GROUP, TIKZ].sort());
  });

  it('refuse LaTeX the document does not hold, before anything is compiled', async () => {
    await expect(snippetSvg('jan/deck/talk.tex', String.raw`\input{../private/notes}`, 40, 10, { ownOnly: true })).rejects.toBeInstanceOf(SnippetRefused);
    await expect(snippetSvg('jan/deck/talk.tex', TIKZ + ' ', 40, 10, { ownOnly: true })).rejects.toBeInstanceOf(SnippetRefused);
  });
});
