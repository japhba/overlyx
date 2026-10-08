// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import { schema, lyxToPmNode, pmToLyxBody } from '@overlyx/core';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { layoutSources, sourceOnlyParagraph, layoutTableSpacing } from '../packages/client/src/editor/layout/source.ts';
import { PageView, RawView } from '../packages/client/src/editor/layout/nodeviews.ts';
import { LYX_LAYOUTS } from './lyxlib';

const opts = { layoutDir: LYX_LAYOUTS, localDirs: [] };
const TEX = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}[plain]
\begin{olbox}{x=8mm,y=18mm,w=144mm,h=56mm,font=6.5pt}
\setlength{\tabcolsep}{0.6mm} \setlength{\jot}{0.6pt}
\global\long\def\arraystretch{1.15}

Text \setlength{\parskip}{0pt} still prints.
\end{olbox}
\begin{olraw}{x=8mm,y=77mm,w=144mm,h=9mm}
\unsupportedpreviewcommand
\end{olraw}
\note{Speaker notes stay separate.}
\end{frame}
\end{document}
`;

describe('source outside layout pages', () => {
  it('uses the table spacing command in order and scopes it to its text box', () => {
    const tex = TEX.replace('Text \\setlength{\\parskip}{0pt} still prints.', String.raw`\begin{tabular}{ll}A&B\end{tabular}
\setlength{\tabcolsep}{2pt}
\begin{tabular}{ll}C&D\end{tabular}`);
    const doc = lyxToPmNode(parseTex(tex, opts).doc);
    const box = doc.firstChild!.firstChild!;
    const tables = layoutTableSpacing(box);
    expect(tables.map(t => t.mm)).toEqual([0.6, 2 * 25.4 / 72.27]);
    for (const t of tables) expect(box.nodeAt(t.pos)).toBe(t.node);
    const plain = lyxToPmNode(parseTex(tex.replace(/\\setlength\{\\tabcolsep\}\{[^}]+\}/g, ''), opts).doc);
    expect(layoutTableSpacing(plain.firstChild!.firstChild!)).toEqual([]);
  });

  it('collects spacing commands, body macros and raw objects, without changing the saved LaTeX', () => {
    const lyx = parseTex(TEX, opts).doc;
    const doc = lyxToPmNode(lyx);
    expect(layoutSources(doc.firstChild!).map(s => s.latex)).toEqual([
      String.raw`\setlength{\tabcolsep}{0.6mm}`, String.raw`\setlength{\jot}{0.6pt}`,
      String.raw`\global\long\def\arraystretch{1.15}`, String.raw`\setlength{\parskip}{0pt}`,
      '\\unsupportedpreviewcommand',
    ]);
    const saved = writeTex({ ...lyx, body: pmToLyxBody(doc) }, opts).text;
    expect(saved).toBe(writeTex(lyx, opts).text);
    expect(saved).toContain(String.raw`Text \setlength{\parskip}{0pt} still prints.`);
    expect(saved).toContain(String.raw`\note{Speaker notes stay separate.}`);
  });

  it('removes only source-only lines, keeping mixed text and intentional empty paragraphs', () => {
    const doc = lyxToPmNode(parseTex(TEX, opts).doc);
    const box = doc.firstChild!.firstChild!;
    expect(sourceOnlyParagraph(box.firstChild!)).toBe(true);
    expect(sourceOnlyParagraph(box.lastChild!)).toBe(false);
    expect(sourceOnlyParagraph(schema.nodes.paragraph.create())).toBe(false);
  });

  it('places the source inspector outside the page and outside the editor document', () => {
    const doc = lyxToPmNode(parseTex(TEX, opts).doc);
    const view = { state: { doc }, dom: document.createElement('div'), focus: vi.fn() } as unknown as EditorView;
    const page = new PageView(doc.firstChild!, view, () => 0);
    document.body.append(page.dom);
    const button = page.dom.querySelector<HTMLButtonElement>('.ol-page-source')!;
    expect(button.textContent).toBe('LaTeX (5)');
    expect(page.contentDOM.contains(button)).toBe(false);
    button.click();
    const dialog = document.querySelector<HTMLElement>('.ol-source-dialog')!;
    expect(page.dom.contains(dialog)).toBe(false);
    expect(dialog.textContent).toContain(String.raw`\setlength{\tabcolsep}{0.6mm}`);
    dialog.querySelector<HTMLButtonElement>('button')!.click();
    expect(document.querySelector('.ol-source-dialog')).toBeNull();
    expect(view.state.doc).toBe(doc);
    page.dom.remove();
  });

  it('never falls back to code on paper when a raw preview is unavailable', async () => {
    const doc = lyxToPmNode(parseTex(TEX, opts).doc);
    const raw = doc.firstChild!.child(1);
    const view = { dom: document.createElement('div') } as EditorView;
    const nodeView = new RawView(raw, view, () => undefined);
    await Promise.resolve();
    expect(nodeView.dom.textContent).toBe('');
    expect(nodeView.dom.querySelector('pre')).toBeNull();
    expect(nodeView.dom.classList.contains('ol-rendered')).toBe(false);
    expect(layoutSources(doc.firstChild!).some(s => s.latex.includes('unsupportedpreviewcommand'))).toBe(true);
  });
});
