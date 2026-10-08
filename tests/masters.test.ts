/**
 * Master pages of layout decks (client editor/layout/masters.ts, core layout/*): \begin{olmaster}
 * read and written back, the PM model (role, master, ph), slides' boxes following a changed
 * placeholder unless changed on the slide, applying / resetting a master, a master made of a slide,
 * a slide made from a master, renaming and deleting masters, and pages moved between the lists.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
// the schema the client modules use (the same module instance: a node of another instance's schema is not inserted)
import { schema, lyxToPmNode, pmToLyxBody, LAYOUT_MACROS } from '@overlyx/core';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import {
  masterPages, findMaster, masterChain, resolvedFill, placeholdersOf, followMasters, applyMaster, slideFromMaster,
  masterFromSlide, renameMaster, deleteMaster, duplicateMaster, moveToMaster, asKind, possibleBases, uniqueMasterName, newMaster,
} from '../packages/client/src/editor/layout/masters.ts';
import { pages, deletePage } from '../packages/client/src/editor/layout/commands.ts';
import { LYX_LAYOUTS } from './lyxlib';

const opts = { layoutDir: LYX_LAYOUTS, localDirs: [] };
const PAGE = { w: 160, h: 90 };

const DECK = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{olmaster}{fill=[HTML]F4F1EA,name=Base}
\olshape{x=0mm,y=84mm,w=160mm,h=6mm,vb=0 0 160 6,fill=[HTML]1F3A5F,name=Footer bar}{M 0 0 L 160 0 L 160 6 L 0 6 Z}
\end{olmaster}

\begin{olmaster}{master=Base,name=Content}
\olshape{x=150mm,y=4mm,w=6mm,h=6mm,vb=0 0 6 6,fill=[HTML]E8A33D,name=Logo}{M 0 0 L 6 0 L 6 6 L 0 6 Z}
\begin{olbox}{x=10mm,y=8mm,w=130mm,h=10mm,font=20pt,color=[HTML]1F3A5F,name=Title,ph=title}
\end{olbox}
\begin{olbox}{x=10mm,y=22mm,w=130mm,h=50mm,font=12pt,name=Text,ph=body}
\end{olbox}
\end{olmaster}

\begin{frame}[plain]
\olpage{master=Content}
\begin{olbox}{x=10mm,y=8mm,w=130mm,h=10mm,font=20pt,color=[HTML]1F3A5F,name=Title,ph=title}
Light meets air
\end{olbox}
\begin{olbox}{x=10mm,y=22mm,w=130mm,h=50mm,font=12pt,name=Text,ph=body}
Sunlight is white.
\end{olbox}
\end{frame}

\begin{frame}[plain]
\olpage{master=Content}
\begin{olbox}{x=20mm,y=8mm,w=130mm,h=10mm,font=20pt,color=red,name=Title,ph=title}
Moved on this slide
\end{olbox}
\end{frame}

\begin{frame}[plain]
\begin{olbox}{x=12mm,y=6mm,w=100mm,h=12mm,font=24pt,name=Title}
Unlinked
\end{olbox}
\olshape{x=0mm,y=84mm,w=160mm,h=6mm,vb=0 0 160 6,fill=[HTML]1F3A5F,name=Footer bar}{M 0 0 L 160 0 L 160 6 L 0 6 Z}
\end{frame}

\end{document}
`;

function load(tex = DECK) {
  const lyx = parseTex(tex, opts).doc;
  return { lyx, state: EditorState.create({ schema, doc: lyxToPmNode(lyx) }) };
}
const write = (lyx: ReturnType<typeof load>['lyx'], pm: PMNode) => writeTex({ ...lyx, body: pmToLyxBody(pm) }, opts).text;
const body = (t: string) => t.slice(t.indexOf('\\begin{document}'));
const slide = (s: EditorState, i: number) => pages(s.doc)[i];
const boxes = (p: PMNode) => { const out: PMNode[] = []; p.forEach(c => { if (c.type.name === 'ol_box') out.push(c); }); return out; };

describe('master pages in the file', () => {
  it('reads \\begin{olmaster} as a page of role master, and writes the file back unchanged', () => {
    const { lyx, state } = load();
    expect(masterPages(state.doc).map(m => m.node.attrs.name)).toEqual(['Base', 'Content']);
    expect(pages(state.doc)).toHaveLength(3);
    expect(findMaster(state.doc, 'Content')!.node.attrs.master).toBe('Base');
    expect(slide(state, 0).node.attrs.master).toBe('Content');
    expect([...placeholdersOf(findMaster(state.doc, 'Content')!.node).keys()]).toEqual(['title', 'body']);
    expect(body(write(lyx, state.doc))).toBe(body(DECK));
  });

  it('the macro package defines olmaster and draws masters from \\olpage', () => {
    expect(LAYOUT_MACROS).toContain('\\NewDocumentEnvironment{olmaster}');
    expect(LAYOUT_MACROS).toContain('\\ol@drawmaster');
    expect(LAYOUT_MACROS).toMatch(/hide\/\.code/);
  });

  it('a master chain, its fill, cycles', () => {
    const { state } = load();
    expect(masterChain(state.doc, 'Content').chain.map(m => m.node.attrs.name)).toEqual(['Content', 'Base']);
    expect(resolvedFill(state.doc, slide(state, 0).node)).toBe('[HTML]F4F1EA');
    expect(resolvedFill(state.doc, slide(state, 2).node)).toBeNull();
    const base = findMaster(state.doc, 'Base')!;
    const loop = state.apply(state.tr.setNodeMarkup(base.pos, undefined, { ...base.node.attrs, master: 'Content' }));
    expect(masterChain(loop.doc, 'Content').cyclic).toBe(true);
    expect(possibleBases(state.doc, 'Base')).toEqual([]);   // Content builds on Base
    expect(possibleBases(state.doc, 'Content')).toEqual(['Base']);
  });
});

describe('placeholders followed by the slides', () => {
  it('a moved / restyled placeholder moves its slides\' boxes — not what a slide changed itself', () => {
    const { state } = load();
    const m = findMaster(state.doc, 'Content')!;
    let titlePos = -1;
    m.node.forEach((c, off) => { if (c.attrs.ph === 'title') titlePos = m.pos + 1 + off; });
    const title = state.doc.nodeAt(titlePos)!;
    const tr = state.tr.setNodeMarkup(titlePos, undefined, { ...title.attrs, y: 12, font: 24 });
    const next = state.apply(tr);
    const follow = followMasters([tr], state, next);
    expect(follow).not.toBeNull();
    const after = next.apply(follow!);
    const t0 = boxes(slide(after, 0).node)[0], t1 = boxes(slide(after, 1).node)[0];
    expect([t0.attrs.y, t0.attrs.font, t0.attrs.x]).toEqual([12, 24, 10]);
    // slide 2 had its own x and colour: those stay; y and the size follow
    expect([t1.attrs.y, t1.attrs.font, t1.attrs.x, t1.attrs.color]).toEqual([12, 24, 20, 'red']);
    expect(followMasters([follow!], next, after)).toBeNull();
    expect(t1.textContent).toBe('Moved on this slide');
    // the unlinked slide is not touched
    expect(boxes(slide(after, 2).node)[0].attrs.y).toBe(6);
  });

  it('nothing follows a collaborator\'s change, a live preview or its own transaction', () => {
    const { state } = load();
    const m = findMaster(state.doc, 'Content')!;
    const titlePos = m.pos + 2 + m.node.child(0).nodeSize - 1;
    const tr = state.tr.setNodeMarkup(titlePos, undefined, { ...state.doc.nodeAt(titlePos)!.attrs, y: 30 }).setMeta('addToHistory', false);
    expect(followMasters([tr], state, state.apply(tr))).toBeNull();
  });
});

describe('master commands', () => {
  it('applying a master links named boxes, takes the placeholders\' frames, adds the missing ones and drops what the master draws', () => {
    const { lyx, state } = load();
    const tr = state.tr;
    applyMaster(tr, slide(state, 2).pos, 'Content');
    const after = state.apply(tr);
    const s = slide(after, 2).node;
    expect(s.attrs.master).toBe('Content');
    const bs = boxes(s);
    expect(bs.map(b => [b.attrs.ph, b.attrs.x, b.attrs.y, Math.round(b.attrs.font)])).toEqual([['title', 10, 8, 20], ['body', 10, 22, 12]]);
    expect(bs[0].textContent).toBe('Unlinked');
    // the footer bar is Base's: no longer on the slide
    expect(s.childCount).toBe(2);
    const text = write(lyx, after.doc);
    expect(text).toContain('\\olpage{master=Content}\n\\begin{olbox}{x=10mm,y=8mm,w=130mm,h=10mm,font=20pt,color=[HTML]1F3A5F,name=Title,ph=title}\nUnlinked');
    expect(body(writeTex(parseTex(text, opts).doc, opts).text)).toBe(body(text));
  });

  it('reset takes every placeholder\'s look back; None unlinks', () => {
    const { state } = load();
    const tr = state.tr;
    applyMaster(tr, slide(state, 1).pos, 'Content', true);
    const after = state.apply(tr);
    const t = boxes(slide(after, 1).node)[0];
    expect([t.attrs.x, t.attrs.color]).toEqual([10, '[HTML]1F3A5F']);
    expect(boxes(slide(after, 1).node).map(b => b.attrs.ph)).toEqual(['title', 'body']);
    const tr2 = after.tr;
    applyMaster(tr2, slide(after, 1).pos, null);
    expect(slide(after.apply(tr2), 1).node.attrs.master).toBeNull();
  });

  it('a slide from a master: its placeholders, empty', () => {
    const { state } = load();
    const r = slideFromMaster(state, slide(state, 0).pos, 'Content')!;
    const after = state.apply(r.tr);
    const s = after.doc.nodeAt(r.pos)!;
    expect(pages(after.doc).findIndex(p => p.pos === r.pos)).toBe(1);
    expect(s.attrs.master).toBe('Content');
    expect(boxes(s).map(b => [b.attrs.ph, b.textContent])).toEqual([['title', ''], ['body', '']]);
  });

  it('a master made of a slide: named boxes become placeholders, the rest the master\'s, the slide uses it', () => {
    const { lyx, state } = load();
    const r = masterFromSlide(state, slide(state, 2).pos, PAGE)!;
    expect(r.name).toBe('Layout');
    const after = state.apply(r.tr);
    const m = findMaster(after.doc, 'Layout')!;
    expect(masterPages(after.doc).map(x => x.node.attrs.name)).toEqual(['Base', 'Content', 'Layout']);
    expect(m.node.childCount).toBe(2);
    const ph = placeholdersOf(m.node).get('title')!;
    expect([ph.attrs.x, ph.textContent]).toEqual([12, '']);
    const s = slide(after, 2).node;
    expect(s.attrs.master).toBe('Layout');
    expect(s.childCount).toBe(1);
    expect(boxes(s)[0].attrs.ph).toBe('title');
    expect(boxes(s)[0].textContent).toBe('Unlinked');
    // masters are written before the frames
    const text = write(lyx, after.doc);
    expect(text.indexOf('\\begin{olmaster}{name=Layout}')).toBeLessThan(text.indexOf('\\begin{frame}'));
  });

  it('a master made of a slide without named boxes: the largest type at the top is the title', () => {
    const tex = DECK.replace('font=24pt,name=Title}', 'font=24pt}');
    const { state } = load(tex);
    const r = masterFromSlide(state, slide(state, 2).pos, PAGE)!;
    const after = state.apply(r.tr);
    expect([...placeholdersOf(findMaster(after.doc, r.name)!.node).keys()]).toEqual(['title']);
  });

  it('objects moved to the master leave every slide of it that has them', () => {
    const { state } = load();
    // the same badge on both Content slides
    const badge = schema.nodes.ol_shape.create({ x: 1, y: 1, w: 5, h: 5, d: 'M 0 0 L 5 0 L 5 5 Z', vb: '0 0 5 5', fill: 'red' });
    let tr = state.tr;
    for (const p of [...pages(state.doc)].slice(0, 2).reverse()) tr.insert(p.pos + p.node.nodeSize - 1, badge);
    const s1 = state.apply(tr);
    const p0 = slide(s1, 0);
    const pos = p0.pos + p0.node.nodeSize - 1 - badge.nodeSize;
    expect(s1.doc.nodeAt(pos)!.type.name).toBe('ol_shape');
    tr = moveToMaster(s1, [pos])!;
    const s2 = s1.apply(tr);
    expect(slide(s2, 0).node.childCount).toBe(2);
    expect(slide(s2, 1).node.childCount).toBe(1);
    expect(findMaster(s2.doc, 'Content')!.node.lastChild!.attrs.fill).toBe('red');
  });

  it('rename follows into the pages; delete hands them the master it built on', () => {
    const { state } = load();
    const c = findMaster(state.doc, 'Content')!;
    const renamed = state.apply(renameMaster(state, c.pos, 'Body slide')!);
    expect(pages(renamed.doc).map(p => p.node.attrs.master)).toEqual(['Body slide', 'Body slide', null]);
    expect(uniqueMasterName(renamed.doc, 'Base')).toBe('Base 2');
    const del = renamed.apply(deleteMaster(renamed, findMaster(renamed.doc, 'Body slide')!.pos)!);
    expect(masterPages(del.doc)).toHaveLength(1);
    expect(pages(del.doc).map(p => p.node.attrs.master)).toEqual(['Base', 'Base', null]);
  });

  it('duplicates and new masters get names of their own; masters may all go, a slide stays', () => {
    const { state } = load();
    const d = duplicateMaster(state, findMaster(state.doc, 'Content')!.pos)!;
    const s1 = state.apply(d.tr);
    expect(masterPages(s1.doc).map(m => m.node.attrs.name)).toEqual(['Base', 'Content', 'Content 2']);
    const n = newMaster(s1, PAGE);
    const s2 = s1.apply(n.tr);
    expect(n.name).toBe('Layout');
    expect([...placeholdersOf(findMaster(s2.doc, 'Layout')!.node).keys()]).toEqual(['title', 'body']);
    expect(deletePage(s2, findMaster(s2.doc, 'Base')!.pos)).not.toBeNull();
  });

  it('pages pasted into the other list change kind', () => {
    const { state } = load();
    const asMaster = asKind([slide(state, 0).node], true, state.doc)[0];
    expect([asMaster.attrs.role, asMaster.attrs.name]).toEqual(['master', 'Layout']);
    const back = asKind([findMaster(state.doc, 'Content')!.node], false, state.doc)[0];
    expect(back.attrs.role).toBe('page');
  });
});
