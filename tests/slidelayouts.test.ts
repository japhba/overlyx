/**
 * "New slide" layouts of layout decks (client editor/layout/slidelayouts.ts): the deck's style read
 * off its pages (title, body, background, objects repeated on most pages, the title page), every
 * layout written into a valid, stable beamer file, and the formatting typed into an empty title.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
// the schema the client modules use (the same module instance: a node of another instance's schema is not inserted)
import { schema, layoutTemplate, lyxToPmNode, pmToLyxBody } from '@overlyx/core';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { deckStyle, insertSlide, layoutObjects, promptMarks, SLIDE_LAYOUTS, boxIsEmpty } from '../packages/client/src/editor/layout/slidelayouts.ts';
import { pages } from '../packages/client/src/editor/layout/commands.ts';

const opts = { layoutDir: path.resolve('lyx/lib/layouts'), localDirs: [] };
const PAGE = { w: 160, h: 90 };

function load(tex: string) {
  const doc = parseTex(tex, opts).doc;
  return { lyx: doc, state: EditorState.create({ schema, doc: lyxToPmNode(doc) }) };
}
const write = (lyx: ReturnType<typeof load>['lyx'], pm: PMNode) => writeTex({ ...lyx, body: pmToLyxBody(pm) }, opts).text;
const boxes = (page: PMNode) => { const out: PMNode[] = []; page.forEach(c => { if (c.type.name === 'ol_box') out.push(c); }); return out; };

const DECK = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\olshape{x=0mm,y=0mm,w=160mm,h=90mm,vb=0 0 100 100,fill=blue!10}{M 0 0 L 100 0 L 100 100 L 0 100 Z}
\begin{olbox}{x=12mm,y=30mm,w=136mm,h=16mm,font=30pt,valign=c}
\textbf{The talk}
\end{olbox}
\begin{olbox}{x=12mm,y=50mm,w=136mm,h=8mm,font=13pt,color=darkgray}
Speaker
\end{olbox}
\end{frame}
` + [1, 2, 3].map(i => String.raw`
\begin{frame}[plain]
\olpage{fill=black!3}
\begin{olbox}{x=10mm,y=6mm,w=140mm,h=10mm,font=22pt,color=blue}
\textbf{Point ${i}}
\end{olbox}
\begin{olbox}{x=10mm,y=22mm,w=120mm,h=50mm,font=13pt}
\begin{itemize}
\item item ${i}
\end{itemize}
\end{olbox}
\olshape{x=0mm,y=86mm,w=160mm,h=4mm,vb=0 0 100 100,fill=blue}{M 0 0 L 100 0 L 100 100 L 0 100 Z}
\end{frame}
`).join('') + '\\end{document}\n';

describe('the deck\'s style', () => {
  const { state } = load(DECK);
  const st = deckStyle(state.doc, PAGE, 11);

  it('takes the title and body boxes the content pages share, their background and their repeated objects', () => {
    expect(st.title.attrs).toMatchObject({ x: 10, y: 6, w: 140, font: 22, color: 'blue' });
    expect(st.title.marks.map(m => `${m.type.name}=${m.attrs.value}`)).toEqual(['series=bold']);
    expect(st.body.attrs).toMatchObject({ x: 10, y: 22, w: 120, font: 13 });
    expect(st.body.par.layout).toBe('Itemize');
    expect(st.fill).toBe('black!3');
    expect(st.master.map(n => n.attrs.fill)).toEqual(['blue']);   // the footer bar, not the title page's backdrop
    expect(st.cover).toBe(pages(state.doc)[0].node);
  });

  it('a new slide: the master objects, then empty named boxes in the deck\'s style', () => {
    const objs = layoutObjects('content', st, PAGE);
    expect(objs.map(o => o.type.name)).toEqual(['ol_shape', 'ol_box', 'ol_box']);
    const [title, text] = objs.slice(1);
    expect(title.attrs).toMatchObject({ name: 'Title', font: 22, color: 'blue', step: null });
    expect(text.attrs).toMatchObject({ name: 'Text', font: 13 });
    expect(boxIsEmpty(title) && boxIsEmpty(text)).toBe(true);
    expect(text.firstChild!.attrs.layout).toBe('Itemize');
  });

  it('the title slide is the first page with its text taken out, its shapes kept', () => {
    const objs = layoutObjects('title', st, PAGE);
    expect(objs.map(o => o.type.name)).toEqual(['ol_shape', 'ol_box', 'ol_box']);
    expect(objs.slice(1).map(b => [b.attrs.name, Math.round(b.attrs.font), boxIsEmpty(b)])).toEqual([['Title', 30, true], ['Subtitle', 13, true]]);
  });

  it('text typed into an empty title gets the titles\' formatting; into a body, nothing special', () => {
    const { tr, pos } = insertSlide(state, pages(state.doc)[1].pos, 'content', PAGE, 11);
    const page = tr.doc.nodeAt(pos)!;
    const [title, text] = boxes(page);
    expect(promptMarks(tr.doc, title, PAGE)?.map(m => m.attrs.value)).toEqual(['bold']);
    expect(promptMarks(tr.doc, text, PAGE)).toBeNull();
    // the new empty slide does not outvote the deck: still the deck's titles' style
    expect(deckStyle(tr.doc, PAGE).title.marks.length).toBe(1);
  });
});

describe('every layout', () => {
  for (const { lyx, state, what } of [{ ...load(DECK), what: 'a styled deck' }, { ...load(layoutTemplate('slides169', { title: 'T' }).text), what: 'the new-slides template' }]) {
    for (const l of SLIDE_LAYOUTS) {
      it(`${l.label} in ${what}: inserted after the first page, written stably`, () => {
        const { tr, pos } = insertSlide(state, pages(state.doc)[0].pos, l.id, PAGE, 11);
        expect(pages(tr.doc).length).toBe(pages(state.doc).length + 1);
        expect(pages(tr.doc)[1].pos).toBe(pos);
        const text = write(lyx, tr.doc);
        expect(text.match(/\\begin\{frame\}/g)!.length).toBe(pages(tr.doc).length);
        const again = parseTex(text, opts).doc;
        expect(writeTex(again, opts).text).toBe(text);
        if (l.id !== 'blank') expect(text).toMatch(/name=(Title|Statement)/);
      });
    }
  }
});
