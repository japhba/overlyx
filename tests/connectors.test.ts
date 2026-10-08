/**
 * Connectors of layout pages (client editor/layout/connectors.ts): ends on a side's middle or on the
 * outline towards the other end, straight and elbow paths, a connector redrawn when its objects move
 * and let go when one goes, ids kept unique on a page, copies of connected objects attached to each
 * other; and the guides' format (guides.ts). What lands in the file: the path as drawn, from= / to=.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, lyxToPmNode, pmToLyxBody, setHeaderValue } from '@overlyx/core';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import {
  parseEnd, endRef, sitePoint, outlinePoint, connectorPath, elbow, followConnectors, copyObjects, objectById, freshId, allObjects, pageSegs,
} from '../packages/client/src/editor/layout/connectors.ts';
import { parseGuides, formatGuides, defaultGrid } from '../packages/client/src/editor/layout/guides.ts';
import { pages } from '../packages/client/src/editor/layout/commands.ts';
import { LYX_LAYOUTS } from './lyxlib';

const opts = { layoutDir: LYX_LAYOUTS, localDirs: [] };

const DECK = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\olshape{x=10mm,y=10mm,w=30mm,h=20mm,vb=0 0 30 20,draw=black,id=a}{M 0 0 L 30 0 L 30 20 L 0 20 Z}
\olshape{x=80mm,y=40mm,w=30mm,h=20mm,vb=0 0 30 20,draw=black,id=b}{M 0 0 L 30 0 L 30 20 L 0 20 Z}
\begin{olbox}{x=60mm,y=5mm,w=20mm,h=10mm,shape=ellipse,id=e}
E
\end{olbox}
\olshape{x=40mm,y=20mm,w=40mm,h=30mm,vb=0 0 40 30,draw=black,arrows=-Stealth,from=a.e,to=b.w}{M 0 0 L 40 30}
\olshape{x=0mm,y=0mm,w=1mm,h=1mm,vb=0 0 1 1,draw=black,from=a,to=e,conn=elbow}{M 0 0 L 1 1}
\end{frame}

\end{document}
`;

function load(tex = DECK) {
  const lyx = parseTex(tex, opts).doc;
  return { lyx, state: EditorState.create({ schema, doc: lyxToPmNode(lyx) }) };
}
const page = (s: EditorState) => pages(s.doc)[0];
const shapes = (s: EditorState) => allObjects(page(s).node, page(s).pos).filter(o => o.node.type.name === 'ol_shape');
const ends = (n: PMNode) => { const sg = pageSegs(n).filter(x => x.c !== 'Z') as { p: number[] }[]; const a = sg[0].p, b = sg[sg.length - 1].p; return [a[0], a[1], b[b.length - 2], b[b.length - 1]].map(v => Math.round(v * 100) / 100); };

/** move object `id` by (dx, dy) and let the connectors follow (the layout plugin's appendTransaction) */
function moveAndFollow(s: EditorState, id: string, dx: number, dy: number): EditorState {
  const o = objectById(page(s).node, page(s).pos, id)!;
  const tr = s.tr.setNodeMarkup(o.pos, undefined, { ...o.node.attrs, x: o.node.attrs.x + dx, y: o.node.attrs.y + dy });
  const next = s.apply(tr);
  const f = followConnectors([tr], s, next);
  return f ? next.apply(f) : next;
}

describe('connector geometry', () => {
  it('ends: refs, sides, the outline towards a point (a rectangle, an ellipse)', () => {
    expect(parseEnd('box1.e')).toEqual({ id: 'box1', side: 'e' });
    expect(parseEnd('a')).toEqual({ id: 'a', side: null });
    expect(parseEnd(null)).toBeNull();
    expect(endRef('x', 'n')).toBe('x.n');
    const { state } = load();
    const a = objectById(page(state).node, page(state).pos, 'a')!.node;
    expect(sitePoint(a, 'e')).toEqual([40, 20]);
    expect(sitePoint(a, 'n')).toEqual([25, 10]);
    const p = outlinePoint(a, [100, 20]);
    expect(p.map(v => Math.round(v * 1000) / 1000)).toEqual([40, 20]);
    const e = objectById(page(state).node, page(state).pos, 'e')!.node;
    const q = outlinePoint(e, [70, 100]);   // straight down from the centre (70, 10): the ellipse's bottom
    expect(q[0]).toBeCloseTo(70, 2);
    expect(q[1]).toBeCloseTo(15, 1);
  });

  it('elbow runs: horizontal first when the ends lie further apart that way, along the sides\' directions', () => {
    expect(elbow([0, 0], [10, 4], null, null)).toEqual([[0, 0], [5, 0], [5, 4], [10, 4]]);
    expect(elbow([0, 0], [2, 10], null, null)).toEqual([[0, 0], [0, 5], [2, 5], [2, 10]]);
    expect(elbow([0, 0], [10, 10], [1, 0], [0, -1])).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it('a connector\'s path from its objects; nothing when no end is attached', () => {
    const { state } = load();
    const [, , c1, c2] = shapes(state);
    const p1 = connectorPath(page(state).node, page(state).pos, c1.node)!;
    expect(p1).toEqual([{ c: 'M', p: [40, 20] }, { c: 'L', p: [80, 50] }]);
    const p2 = connectorPath(page(state).node, page(state).pos, c2.node)!;
    expect(p2.length).toBeGreaterThan(2);
    expect(p2.every((s, i) => i === 0 || s.c === 'L')).toBe(true);
    const free = schema.nodes.ol_shape.create({ d: 'M 0 0 L 5 5', vb: '0 0 5 5', w: 5, h: 5 });
    expect(connectorPath(page(state).node, page(state).pos, free)).toBeNull();
  });
});

describe('connectors follow their objects', () => {
  it('moving an object redraws the connectors attached to it (and only those)', () => {
    const { lyx, state } = load();
    const s1 = moveAndFollow(state, 'b', 10, 20);
    const [, , c1] = shapes(s1);
    expect(ends(c1.node)).toEqual([40, 20, 90, 70]);
    const text = writeTex({ ...lyx, body: pmToLyxBody(s1.doc) }, opts).text;
    expect(text).toContain('from=a.e,to=b.w}{M 0 0 L 50 50}');
  });

  it('nothing follows a collaborator\'s change; a live preview\'s followers keep out of the history', () => {
    const { state } = load();
    const o = objectById(page(state).node, page(state).pos, 'b')!;
    const tr = state.tr.setNodeMarkup(o.pos, undefined, { ...o.node.attrs, x: 90 }).setMeta('addToHistory', false);
    const f = followConnectors([tr], state, state.apply(tr))!;
    expect(f.getMeta('addToHistory')).toBe(false);
  });

  it('an end whose object is deleted lets go (the path stays where it was)', () => {
    const { state } = load();
    const b = objectById(page(state).node, page(state).pos, 'b')!;
    const tr = state.tr.delete(b.pos, b.pos + b.node.nodeSize);
    const next = state.apply(tr);
    const after = next.apply(followConnectors([tr], state, next)!);
    const c1 = shapes(after).find(s => s.node.attrs.arrows)!;
    expect([c1.node.attrs.from, c1.node.attrs.to]).toEqual(['a.e', null]);
  });

  it('ids twice on a page: the later one gets a new id', () => {
    const { state } = load();
    const a = objectById(page(state).node, page(state).pos, 'a')!;
    const p = page(state);
    const tr = state.tr.insert(p.pos + p.node.nodeSize - 1, a.node);
    const next = state.apply(tr);
    const after = next.apply(followConnectors([tr], state, next)!);
    const ids = allObjects(page(after).node, 0).map(o => o.node.attrs.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(freshId(page(after).node)).toMatch(/^o\d+$/);
  });

  it('copies: new ids, a connector copied with both objects attached to the copies, one copied alone let go', () => {
    const { state } = load();
    const objs = allObjects(page(state).node, page(state).pos);
    const [a, b, , c1] = objs;
    const both = copyObjects([a.node, b.node, c1.node], page(state).node);
    expect(both[0].attrs.id).not.toBe('a');
    expect(both[2].attrs.from).toBe(`${both[0].attrs.id}.e`);
    expect(both[2].attrs.to).toBe(`${both[1].attrs.id}.w`);
    const alone = copyObjects([c1.node], page(state).node)[0];
    expect([alone.attrs.from, alone.attrs.to]).toEqual([null, null]);
  });
});

describe('guides', () => {
  it('"x20 y45.5" both ways; the grid\'s default spacing for a page', () => {
    const g = parseGuides('x20 y45.5 junk x-3');
    expect(g).toEqual([{ axis: 'x', at: 20 }, { axis: 'y', at: 45.5 }, { axis: 'x', at: -3 }]);
    expect(formatGuides(g)).toBe('x20 y45.5 x-3');
    expect(parseGuides(undefined)).toEqual([]);
    expect(defaultGrid({ w: 160 })).toBe(5);
    expect(defaultGrid({ w: 841 })).toBe(25);
  });

  it('the guides and the grid are kept in the file\'s settings line', () => {
    const doc = parseTex(DECK, opts).doc;
    setHeaderValue(doc.header, 'overlyx_guides', 'x20 y45');
    setHeaderValue(doc.header, 'overlyx_grid', '2.5');
    const out = writeTex(doc, opts).text;
    expect(out).toContain('"overlyx_guides":"x20 y45"');
    expect(out).toContain('"overlyx_grid":"2.5"');
    const back = parseTex(out, opts).doc;
    expect(back.header.lines).toContain('\\overlyx_guides x20 y45');
    expect(back.header.lines).toContain('\\overlyx_grid 2.5');
    expect(writeTex(back, opts).text).toBe(out);
  });
});
