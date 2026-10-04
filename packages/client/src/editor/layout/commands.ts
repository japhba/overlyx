/**
 * Commands of layout documents, as ProseMirror transactions: pages (add, duplicate, delete, move),
 * objects (insert, move / resize, z-order, align, distribute, group, delete, duplicate) and their
 * styles. Objects are addressed by document position; a group moves as one object.
 */
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { schema, SHAPE_PRESETS, pageSizeOf, normalizePath, pathBounds, pathToString, type PathSeg } from '@overlyx/core';
import { boxOf, objectBounds, unionBounds, isLayoutObject, pageObjects, rotatePoint } from './geom';

export type Attrs = Record<string, unknown>;

/* ------------------------------------------------------------------ lookups */

export function isLayoutDoc(doc: PMNode): boolean { return doc.firstChild?.type.name === 'ol_page'; }

/** The page containing `pos` (its node and position). */
export function pageAt(doc: PMNode, pos: number): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  doc.forEach((n, off) => { if (!found && n.type.name === 'ol_page' && pos >= off && pos <= off + n.nodeSize) found = { node: n, pos: off }; });
  return found;
}

export function pages(doc: PMNode): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  doc.forEach((n, off) => { if (n.type.name === 'ol_page') out.push({ node: n, pos: off }); });
  return out;
}

/** The top-level object (a direct child of its page) containing `pos`. */
export function objectAt(doc: PMNode, pos: number): { node: PMNode; pos: number } | null {
  const $p = doc.resolve(Math.min(pos, doc.content.size));
  for (let d = 1; d <= $p.depth; d++) {
    if ($p.node(d - 1).type.name === 'ol_page' && isLayoutObject($p.node(d))) return { node: $p.node(d), pos: $p.before(d) };
  }
  const after = $p.nodeAfter;
  if (after && isLayoutObject(after) && $p.parent.type.name === 'ol_page') return { node: after, pos };
  return null;
}

/** The text box the selection's head is in (text editing), if any. */
export function editedBox(state: EditorState): { node: PMNode; pos: number } | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection) return null;
  const $h = sel.$head;
  for (let d = $h.depth; d > 0; d--) if ($h.node(d).type.name === 'ol_box') return { node: $h.node(d), pos: $h.before(d) };
  return null;
}

/* ------------------------------------------------------------------ pages */

export function emptyPage(attrs: Attrs = {}): PMNode {
  return schema.nodes.ol_page.create(attrs);
}

export function insertPage(state: EditorState, after: number | null, page: PMNode = emptyPage()): Transaction {
  const list = pages(state.doc);
  const at = after === null ? (list.length ? list[list.length - 1].pos + list[list.length - 1].node.nodeSize : state.doc.content.size) : after;
  return state.tr.insert(at, page).scrollIntoView();
}

export function deletePage(state: EditorState, pagePos: number): Transaction | null {
  const list = pages(state.doc);
  if (list.length <= 1) return null;
  const p = list.find(x => x.pos === pagePos);
  if (!p) return null;
  return state.tr.delete(p.pos, p.pos + p.node.nodeSize);
}

export function movePage(state: EditorState, pagePos: number, dir: -1 | 1): Transaction | null {
  const list = pages(state.doc);
  const i = list.findIndex(x => x.pos === pagePos);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return null;
  const a = list[Math.min(i, j)], b = list[Math.max(i, j)];
  const tr = state.tr.replaceWith(a.pos, b.pos + b.node.nodeSize, Fragment.from([b.node, a.node]));
  return tr;
}

/** Move a page into the gap before page `gap` (0 … the number of pages; the slide rail's drag). */
export function movePageTo(state: EditorState, pagePos: number, gap: number): Transaction | null {
  const list = pages(state.doc);
  const i = list.findIndex(x => x.pos === pagePos);
  if (i < 0 || gap < 0 || gap > list.length || gap === i || gap === i + 1) return null;
  const p = list[i];
  const tr = state.tr.delete(p.pos, p.pos + p.node.nodeSize);
  const end = list[list.length - 1];
  tr.insert(tr.mapping.map(gap < list.length ? list[gap].pos : end.pos + end.node.nodeSize), p.node);
  return tr;
}

/* ------------------------------------------------------------------ objects */

export function defaultParagraph(): PMNode {
  return schema.nodes.paragraph.create({ layout: 'Plain Layout', depth: 0 });
}

export function makeBox(attrs: Attrs, content?: PMNode[]): PMNode {
  return schema.nodes.ol_box.create({ grow: true, ...attrs }, content?.length ? content : [defaultParagraph()]);
}

export function makeShape(preset: string, attrs: Attrs): PMNode {
  const p = SHAPE_PRESETS[preset] ?? SHAPE_PRESETS.rect;
  return schema.nodes.ol_shape.create({ d: p.d, vb: p.vb ?? '0 0 100 100', ...attrs });
}

/** A shape from absolute path segments in page millimetres: its box is the path's bounds. */
export function shapeFromPath(segs: PathSeg[], attrs: Attrs): PMNode {
  const b = pathBounds(segs);
  const w = Math.max(b.w, 0.5), h = Math.max(b.h, 0.5);
  const rel = segs.map(s => (s.c === 'Z' ? s : { c: s.c, p: s.p.map((v, i) => (i % 2 === 0 ? v - b.x : v - b.y)) }) as PathSeg);
  return schema.nodes.ol_shape.create({ ...attrs, x: b.x, y: b.y, w, h, d: pathToString(rel, 3), vb: `0 0 ${fmt(w)} ${fmt(h)}` });
}
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** Insert an object at the end of a page (on top of everything else, before the notes). */
export function insertObject(state: EditorState, pagePos: number, node: PMNode): { tr: Transaction; pos: number } {
  const page = state.doc.nodeAt(pagePos)!;
  let at = pagePos + page.nodeSize - 1;
  if (page.lastChild?.type.name === 'ol_notes') at -= page.lastChild.nodeSize;
  const tr = state.tr.insert(at, node);
  return { tr, pos: at };
}

/** Change attributes of objects (a group's attributes that are geometry go to its members). */
export function setAttrs(tr: Transaction, pos: number, patch: Attrs): Transaction {
  const node = tr.doc.nodeAt(pos);
  if (!node) return tr;
  const attrs = { ...node.attrs };
  for (const [k, v] of Object.entries(patch)) if (k in attrs) attrs[k] = v;
  return tr.setNodeMarkup(pos, undefined, attrs);
}

/** Move an object by (dx, dy) mm (a group: all its members). */
export function translate(tr: Transaction, pos: number, dx: number, dy: number): Transaction {
  const node = tr.doc.nodeAt(pos);
  if (!node) return tr;
  if (node.type.name === 'ol_group') {
    node.forEach((c, off) => { translate(tr, pos + 1 + off, dx, dy); });
    return tr;
  }
  return setAttrs(tr, pos, { x: r3(Number(node.attrs.x) + dx), y: r3(Number(node.attrs.y) + dy) });
}
export const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Scale an object from the bounds `from` onto `to` (the multi-selection's resize): positions and
 * sizes scale, rotations stay. A shape's path scales with its box.
 */
export function scaleInto(tr: Transaction, pos: number, from: { x: number; y: number; w: number; h: number }, to: { x: number; y: number; w: number; h: number }): Transaction {
  const node = tr.doc.nodeAt(pos);
  if (!node) return tr;
  const sx = to.w / Math.max(from.w, 1e-6), sy = to.h / Math.max(from.h, 1e-6);
  if (node.type.name === 'ol_group') { node.forEach((c, off) => { scaleInto(tr, pos + 1 + off, from, to); }); return tr; }
  const b = boxOf(node);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const ncx = to.x + (cx - from.x) * sx, ncy = to.y + (cy - from.y) * sy;
  // for a rotated object the box's own axes are not the page's: scale by the projection
  const rad = b.rot * Math.PI / 180, c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  const w = b.w * (c * sx + s * sy), h = b.h * (s * sx + c * sy);
  const patch: Attrs = { x: r3(ncx - w / 2), y: r3(ncy - h / 2), w: r3(Math.max(0.5, w)), h: r3(Math.max(0.5, h)) };
  if (node.type.name === 'ol_box' && node.attrs.grow && Math.abs(sy - 1) > 1e-3) patch.grow = false;
  return setAttrs(tr, pos, patch);
}

/** Delete objects (positions of top-level objects; deleted from the last so positions stay valid). */
export function deleteObjects(state: EditorState, positions: number[]): Transaction {
  const tr = state.tr;
  for (const pos of [...positions].sort((a, b) => b - a)) {
    const n = tr.doc.nodeAt(pos);
    if (n) tr.delete(pos, pos + n.nodeSize);
  }
  return tr;
}

/** Duplicate objects in place (on top of their page), offset by `off` mm; returns the copies' positions. */
export function duplicateObjects(state: EditorState, positions: number[], off = 4): { tr: Transaction; positions: number[] } {
  const tr = state.tr;
  const made: { pos: number; step: number }[] = [];
  for (const pos of [...positions].sort((a, b) => a - b)) {
    const n = state.doc.nodeAt(pos), page = pageAt(state.doc, pos);
    if (!n || !page) continue;
    const pagePos = tr.mapping.map(page.pos);
    const pageNode = tr.doc.nodeAt(pagePos)!;
    let at = pagePos + pageNode.nodeSize - 1;
    if (pageNode.lastChild?.type.name === 'ol_notes') at -= pageNode.lastChild.nodeSize;
    tr.insert(at, n);
    translate(tr, at, off, off);
    made.push({ pos: at, step: tr.steps.length });
  }
  return { tr, positions: made.map(m => tr.mapping.slice(m.step).map(m.pos)) };
}

/** z-order: 'front' | 'back' | 'forward' | 'backward' for objects of one page. */
export function reorder(state: EditorState, positions: number[], how: 'front' | 'back' | 'forward' | 'backward'): { tr: Transaction; positions: number[] } | null {
  if (!positions.length) return null;
  const page = pageAt(state.doc, positions[0]);
  if (!page) return null;
  const objs = pageObjects(page.node, page.pos);
  const sel = new Set(positions);
  const nodes = objs.map(o => ({ ...o, sel: sel.has(o.pos) }));
  if (!nodes.some(n => n.sel)) return null;
  let order = nodes.slice();
  if (how === 'front') order = [...nodes.filter(n => !n.sel), ...nodes.filter(n => n.sel)];
  else if (how === 'back') order = [...nodes.filter(n => n.sel), ...nodes.filter(n => !n.sel)];
  else if (how === 'forward') { for (let i = order.length - 2; i >= 0; i--) if (order[i].sel && !order[i + 1].sel) [order[i], order[i + 1]] = [order[i + 1], order[i]]; }
  else { for (let i = 1; i < order.length; i++) if (order[i].sel && !order[i - 1].sel) [order[i], order[i - 1]] = [order[i - 1], order[i]]; }
  if (order.every((n, i) => n === nodes[i])) return null;
  const start = page.pos + 1;
  const end = objs.length ? objs[objs.length - 1].pos + objs[objs.length - 1].node.nodeSize : start;
  const tr = state.tr.replaceWith(start, end, Fragment.from(order.map(n => n.node)));
  const out: number[] = [];
  let p = start;
  for (const n of order) { if (n.sel) out.push(p); p += n.node.nodeSize; }
  return { tr, positions: out };
}

export type AlignHow = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Align objects to their common bounds, or a single object to the page. */
export function align(state: EditorState, positions: number[], how: AlignHow, page: { w: number; h: number }): Transaction | null {
  const objs = positions.map(pos => ({ pos, node: state.doc.nodeAt(pos)! })).filter(o => o.node);
  if (!objs.length) return null;
  const bounds = objs.map(o => objectBounds(o.node));
  const ref = objs.length === 1 ? { x: 0, y: 0, w: page.w, h: page.h } : unionBounds(bounds)!;
  const tr = state.tr;
  objs.forEach((o, i) => {
    const b = bounds[i];
    let dx = 0, dy = 0;
    if (how === 'left') dx = ref.x - b.x;
    else if (how === 'right') dx = ref.x + ref.w - (b.x + b.w);
    else if (how === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
    else if (how === 'top') dy = ref.y - b.y;
    else if (how === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
    else dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
    if (dx || dy) translate(tr, o.pos, dx, dy);
  });
  return tr.docChanged ? tr : null;
}

/** Distribute the objects' centres evenly between the outermost two. */
export function distribute(state: EditorState, positions: number[], axis: 'h' | 'v'): Transaction | null {
  const objs = positions.map(pos => ({ pos, node: state.doc.nodeAt(pos)! })).filter(o => o.node).map(o => ({ ...o, b: objectBounds(o.node) }));
  if (objs.length < 3) return null;
  const c = (b: { x: number; y: number; w: number; h: number }) => (axis === 'h' ? b.x + b.w / 2 : b.y + b.h / 2);
  objs.sort((a, b) => c(a.b) - c(b.b));
  const first = c(objs[0].b), last = c(objs[objs.length - 1].b);
  const step = (last - first) / (objs.length - 1);
  const tr = state.tr;
  objs.forEach((o, i) => {
    const d = first + i * step - c(o.b);
    if (Math.abs(d) > 1e-4) translate(tr, o.pos, axis === 'h' ? d : 0, axis === 'v' ? d : 0);
  });
  return tr.docChanged ? tr : null;
}

/** Group objects of one page: the group takes the place of the topmost member. */
export function group(state: EditorState, positions: number[]): { tr: Transaction; pos: number } | null {
  if (positions.length < 2) return null;
  const page = pageAt(state.doc, positions[0]);
  if (!page || positions.some(p => pageAt(state.doc, p)?.pos !== page.pos)) return null;
  const sorted = [...positions].sort((a, b) => a - b);
  const nodes = sorted.map(p => state.doc.nodeAt(p)!).filter(Boolean);
  const g = schema.nodes.ol_group.create({}, nodes);
  const tr = state.tr;
  const last = sorted[sorted.length - 1];
  const lastNode = state.doc.nodeAt(last)!;
  tr.replaceWith(last, last + lastNode.nodeSize, g);
  for (let i = sorted.length - 2; i >= 0; i--) { const n = state.doc.nodeAt(sorted[i])!; tr.delete(sorted[i], sorted[i] + n.nodeSize); }
  return { tr, pos: tr.mapping.map(last, -1) };
}

/** Dissolve groups into their members (in place); returns the members' positions. */
export function ungroup(state: EditorState, positions: number[]): { tr: Transaction; positions: number[] } | null {
  const groups = positions.map(pos => ({ pos, node: state.doc.nodeAt(pos)! })).filter(o => o.node?.type.name === 'ol_group');
  if (!groups.length) return null;
  const tr = state.tr;
  const out: number[] = [];
  for (const g of [...groups].sort((a, b) => b.pos - a.pos)) {
    const members: PMNode[] = [];
    g.node.forEach(c => {
      // the group's animation step passes to members that have none of their own
      members.push(g.node.attrs.step && !c.attrs.step ? c.type.create({ ...c.attrs, step: g.node.attrs.step, effect: c.attrs.effect ?? g.node.attrs.effect }, c.content, c.marks) : c);
    });
    tr.replaceWith(g.pos, g.pos + g.node.nodeSize, Fragment.from(members));
  }
  for (const g of groups) {
    let p = tr.mapping.map(g.pos, -1);
    const start = p;
    void start;
    g.node.forEach(c => { out.push(p); p += c.nodeSize; });
  }
  return { tr, positions: out };
}

/** Rotate objects by `deg` (TikZ sense) about their own centres. */
export function rotateBy(state: EditorState, positions: number[], deg: number): Transaction {
  const tr = state.tr;
  for (const pos of positions) {
    const n = tr.doc.nodeAt(pos);
    if (!n) continue;
    if (n.type.name === 'ol_group') {
      // members turn about the group's centre
      const gb = objectBounds(n);
      const cx = gb.x + gb.w / 2, cy = gb.y + gb.h / 2;
      n.forEach((c, off) => {
        const b = boxOf(c);
        const [nx, ny] = rotatePoint(b.x + b.w / 2, b.y + b.h / 2, cx, cy, deg);
        setAttrs(tr, pos + 1 + off, { x: r3(nx - b.w / 2), y: r3(ny - b.h / 2), rot: normDeg(b.rot + deg) });
      });
      continue;
    }
    setAttrs(tr, pos, { rot: normDeg(Number(n.attrs.rot) + deg) });
  }
  return tr;
}
export const normDeg = (d: number) => { let v = ((d % 360) + 360) % 360; if (v > 180) v -= 360; return Math.round(v * 100) / 100; };

/** Mirror shapes (their path) and other objects' rotation. */
export function flip(state: EditorState, positions: number[], axis: 'h' | 'v'): Transaction {
  const tr = state.tr;
  const one = (pos: number) => {
    const n = tr.doc.nodeAt(pos);
    if (!n) return;
    if (n.type.name === 'ol_group') { n.forEach((c, off) => one(pos + 1 + off)); return; }
    if (n.type.name === 'ol_shape') {
      const v = String(n.attrs.vb).split(/\s+/).map(Number);
      const [vx, vy, vw, vh] = v.length === 4 ? v : [0, 0, 100, 100];
      const segs = normalizePath(String(n.attrs.d)).map(s => (s.c === 'Z' ? s : { c: s.c, p: s.p.map((val, i) => (axis === 'h' && i % 2 === 0 ? 2 * vx + vw - val : axis === 'v' && i % 2 === 1 ? 2 * vy + vh - val : val)) }) as PathSeg);
      setAttrs(tr, pos, { d: pathToString(segs, 3), rot: normDeg(-Number(n.attrs.rot)) });
    } else setAttrs(tr, pos, { rot: normDeg(-Number(n.attrs.rot)) });
  };
  for (const p of positions) one(p);
  return tr;
}

/** Selection helpers: put the caret into a text box (at its end). */
export function caretInto(tr: Transaction, boxPos: number, atEnd = true): Transaction {
  const box = tr.doc.nodeAt(boxPos);
  if (!box) return tr;
  const inner = atEnd ? boxPos + box.nodeSize - 2 : boxPos + 2;
  return tr.setSelection(TextSelection.near(tr.doc.resolve(inner), atEnd ? -1 : 1));
}

/** The page size of the document (mm) from its header. */
export function pageSize(headerLines: string[]): { w: number; h: number } { return pageSizeOf(headerLines); }
