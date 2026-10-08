/**
 * Connectors: lines and arrows whose ends are attached to objects (Inkscape's connector tool,
 * PowerPoint's connectors). A connector is an ordinary shape with `from` / `to` — the `id` of an
 * object on its page, optionally with a side (`box1.e`: the middle of its right edge; without one the
 * end lies on the object's outline, on the line between the two ends) — and `conn` (straight, the
 * default, or elbow: horizontal and vertical runs). When an attached object moves, turns, grows or
 * goes, the editor draws the connector's path again (followConnectors, an appendTransaction of the
 * layout plugin); the file holds the path as drawn, so TeX needs nothing of this.
 *
 * Object ids are made when something is attached to an object, and kept unique on each page:
 * copies (duplicate, paste, the stamp: copyObjects) get new ones, a connector copied with its objects
 * is attached to the copies, one copied without them is let go.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { ySyncPluginKey } from 'y-prosemirror';
import { normalizePath, pathBounds, pathToString, parseViewBox, type PathSeg } from '@overlyx/core';
import { boxOf, rotatePoint, objectBounds } from './geom';

export type Side = 'n' | 'e' | 's' | 'w';
export const SIDES: Side[] = ['n', 'e', 's', 'w'];
type Pt = [number, number];

/** `box1.e` → { id: 'box1', side: 'e' } */
export function parseEnd(ref: string | null | undefined): { id: string; side: Side | null } | null {
  if (!ref) return null;
  const m = /^(.*?)(?:\.([nesw]))?$/.exec(ref);
  return m && m[1] ? { id: m[1], side: (m[2] as Side | undefined) ?? null } : null;
}
export const endRef = (id: string, side: Side | null): string => (side ? `${id}.${side}` : id);

export const isConnector = (n: PMNode): boolean => n.type.name === 'ol_shape' && !!(n.attrs.from || n.attrs.to || n.attrs.conn);

/** Every object of a page (inside groups too) with its position. */
export function allObjects(page: PMNode, pagePos: number): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  const walk = (n: PMNode, at: number) => n.forEach((c, off) => {
    if (c.type.name === 'ol_notes') return;
    out.push({ node: c, pos: at + 1 + off });
    if (c.type.name === 'ol_group') walk(c, at + 1 + off);
  });
  walk(page, pagePos);
  return out;
}

export function objectById(page: PMNode, pagePos: number, id: string): { node: PMNode; pos: number } | null {
  return allObjects(page, pagePos).find(o => o.node.attrs.id === id) ?? null;
}

/** An id not yet used on the page (o1, o2, …), not among `also`. */
export function freshId(page: PMNode, also: Set<string> = new Set()): string {
  const taken = new Set(also);
  allObjects(page, 0).forEach(o => { if (o.node.attrs.id) taken.add(o.node.attrs.id); });
  for (let i = 1; ; i++) if (!taken.has(`o${i}`)) return `o${i}`;
}

/**
 * Objects about to be copied onto a page (`page`: the page they go to): new ids where they have one, a
 * connector among them attached to the copies of its objects — an end whose object is not copied
 * along is let go (the copy stays where it is put).
 */
export function copyObjects(nodes: PMNode[], page: PMNode | null): PMNode[] {
  const taken = new Set<string>();
  if (page) allObjects(page, 0).forEach(o => { if (o.node.attrs.id) taken.add(o.node.attrs.id); });
  const renamed = new Map<string, string>();
  let k = 1;
  const next = () => { while (taken.has(`o${k}`)) k++; taken.add(`o${k}`); return `o${k}`; };
  const ids = (n: PMNode) => { if (n.attrs.id) renamed.set(n.attrs.id, next()); n.forEach(ids); };
  nodes.forEach(ids);
  const remap = (ref: string | null) => { const e = parseEnd(ref); const n = e ? renamed.get(e.id) : undefined; return n ? endRef(n, e!.side) : null; };
  const copy = (n: PMNode): PMNode => {
    const attrs: Record<string, unknown> = { ...n.attrs };
    if (n.attrs.id) attrs.id = renamed.get(n.attrs.id) ?? null;
    if (isConnector(n)) { attrs.from = remap(n.attrs.from); attrs.to = remap(n.attrs.to); }
    if (n.isLeaf) return n.type.create(attrs, null, n.marks);
    if (n.type.name !== 'ol_group') return n.type.create(attrs, n.content, n.marks);
    const kids: PMNode[] = [];
    n.forEach(c => kids.push(copy(c)));
    return n.type.create(attrs, kids, n.marks);
  };
  return nodes.map(copy);
}

/* ------------------------------------------------------------------ geometry */

/** The middle of a side of an object's (rotated) frame, on the page. */
export function sitePoint(n: PMNode, side: Side): Pt {
  if (n.type.name === 'ol_group') {
    const b = objectBounds(n);
    const p: Record<Side, Pt> = { n: [b.x + b.w / 2, b.y], s: [b.x + b.w / 2, b.y + b.h], w: [b.x, b.y + b.h / 2], e: [b.x + b.w, b.y + b.h / 2] };
    return p[side];
  }
  const b = boxOf(n);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const p: Record<Side, Pt> = { n: [cx, b.y], s: [cx, b.y + b.h], w: [b.x, cy], e: [b.x + b.w, cy] };
  return rotatePoint(p[side][0], p[side][1], cx, cy, b.rot);
}

/** the direction a side faces on the page (rotated with the object) */
function sideDir(n: PMNode, side: Side): Pt {
  const rot = n.type.name === 'ol_group' ? 0 : boxOf(n).rot;
  const d: Record<Side, Pt> = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
  return rotatePoint(d[side][0], d[side][1], 0, 0, rot);
}

export function centre(n: PMNode): Pt {
  const b = n.type.name === 'ol_group' ? { ...objectBounds(n), rot: 0 } : boxOf(n);
  return [b.x + b.w / 2, b.y + b.h / 2];
}

/** an object's outline on the page as a polygon (a shape's own path, flattened; an ellipse; else its frame) */
function outline(n: PMNode): Pt[] {
  if (n.type.name === 'ol_group') { const b = objectBounds(n); return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]; }
  const b = boxOf(n);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const turn = (p: Pt): Pt => rotatePoint(p[0], p[1], cx, cy, b.rot);
  if (n.type.name === 'ol_shape' && n.attrs.d) {
    const v = parseViewBox(String(n.attrs.vb));
    const map = (x: number, y: number): Pt => turn([b.x + (x - v.x) * b.w / v.w, b.y + (y - v.y) * b.h / v.h]);
    const pts: Pt[] = [];
    let cur: Pt = [0, 0];
    for (const s of normalizePath(String(n.attrs.d))) {
      if (s.c === 'Z') continue;
      if (s.c === 'C') {
        const [x1, y1, x2, y2, x3, y3] = s.p;
        for (let k = 1; k <= 8; k++) {
          const t = k / 8, u = 1 - t;
          pts.push(map(u * u * u * cur[0] + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * cur[1] + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3));
        }
        cur = [x3, y3];
      } else { pts.push(map(s.p[0], s.p[1])); cur = [s.p[0], s.p[1]]; }
    }
    // a line (an open path of two points) has no inside: its frame
    if (pts.length > 2) return pts;
  }
  if (n.type.name === 'ol_box' && n.attrs.shape === 'ellipse') {
    return Array.from({ length: 32 }, (_, i) => turn([cx + b.w / 2 * Math.cos(i / 16 * Math.PI), cy + b.h / 2 * Math.sin(i / 16 * Math.PI)]));
  }
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(p => turn(p as Pt));
}

/** where the ray from the object's centre towards `to` leaves its outline (the centre when it never does) */
export function outlinePoint(n: PMNode, to: Pt): Pt {
  const c = centre(n);
  const poly = outline(n);
  const dx = to[0] - c[0], dy = to[1] - c[1];
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - c[0]) * ey - (a[1] - c[1]) * ex) / den;
    const u = ((a[0] - c[0]) * dy - (a[1] - c[1]) * dx) / den;
    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) best = t;
  }
  // (the far end inside the object: the outline in that direction all the same)
  return Number.isFinite(best) ? [c[0] + dx * best, c[1] + dy * best] : c;
}

/** A connector's path on the page from its two ends' objects (null: an end missing — the path stays). */
export function connectorPath(page: PMNode, pagePos: number, conn: PMNode, oldSegs?: PathSeg[]): PathSeg[] | null {
  const f = parseEnd(conn.attrs.from), t = parseEnd(conn.attrs.to);
  const fo = f ? objectById(page, pagePos, f.id)?.node ?? null : null;
  const to = t ? objectById(page, pagePos, t.id)?.node ?? null : null;
  // a free end stays where it is: the path's own first / last point
  const segs = oldSegs ?? pageSegs(conn);
  const first: Pt = segs.length && segs[0].c !== 'Z' ? [segs[0].p[0], segs[0].p[1]] : centre(conn);
  const lastSeg = [...segs].reverse().find(s => s.c !== 'Z') as { p: number[] } | undefined;
  const last: Pt = lastSeg ? [lastSeg.p[lastSeg.p.length - 2], lastSeg.p[lastSeg.p.length - 1]] : centre(conn);
  if (!fo && !to) return null;
  // the ends: a side's middle, or the outline towards the other end
  const aim = (o: PMNode | null, e: { side: Side | null } | null, free: Pt): Pt => (o ? (e?.side ? sitePoint(o, e.side) : centre(o)) : free);
  const fAim = aim(fo, f, first), tAim = aim(to, t, last);
  const p1: Pt = fo ? (f!.side ? sitePoint(fo, f!.side) : outlinePoint(fo, tAim)) : first;
  const p2: Pt = to ? (t!.side ? sitePoint(to, t!.side) : outlinePoint(to, fAim)) : last;
  if (conn.attrs.conn !== 'elbow') return [{ c: 'M', p: p1 }, { c: 'L', p: p2 }];
  const d1 = fo && f!.side ? sideDir(fo, f!.side) : null, d2 = to && t!.side ? sideDir(to, t!.side) : null;
  return elbow(p1, p2, d1, d2).reduce<PathSeg[]>((acc, p, i) => { acc.push({ c: i ? 'L' : 'M', p }); return acc; }, []);
}

/**
 * Horizontal and vertical runs from p1 to p2, leaving and entering along the sides' directions
 * (d1, d2; none: whichever way the ends lie further apart).
 */
export function elbow(p1: Pt, p2: Pt, d1: Pt | null, d2: Pt | null): Pt[] {
  const horiz = (d: Pt | null) => (d ? Math.abs(d[0]) >= Math.abs(d[1]) : null);
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const h1 = horiz(d1) ?? Math.abs(dx) >= Math.abs(dy);
  const h2 = horiz(d2) ?? h1;
  const out: Pt[] = [p1];
  if (h1 && h2) { const mx = p1[0] + dx / 2; out.push([mx, p1[1]], [mx, p2[1]]); }
  else if (!h1 && !h2) { const my = p1[1] + dy / 2; out.push([p1[0], my], [p2[0], my]); }
  else if (h1) out.push([p2[0], p1[1]]);
  else out.push([p1[0], p2[1]]);
  out.push(p2);
  // no zero-length runs
  return out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-6);
}

/** a shape's path in page millimetres (its box's frame applied, no rotation: connectors are drawn unrotated) */
export function pageSegs(n: PMNode): PathSeg[] {
  const b = boxOf(n);
  const v = parseViewBox(String(n.attrs.vb));
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return normalizePath(String(n.attrs.d)).map(s => {
    if (s.c === 'Z') return s;
    const p = [...s.p];
    for (let i = 0; i < p.length; i += 2) {
      const [x, y] = rotatePoint(b.x + (p[i] - v.x) * b.w / v.w, b.y + (p[i + 1] - v.y) * b.h / v.h, cx, cy, b.rot);
      p[i] = x; p[i + 1] = y;
    }
    return { c: s.c, p } as PathSeg;
  });
}

/** the attributes of a shape drawn along these page segments (its box the path's bounds) */
export function shapeAttrsFor(segs: PathSeg[]): Record<string, unknown> {
  const b = pathBounds(segs);
  const w = Math.max(b.w, 0.5), h = Math.max(b.h, 0.5);
  const rel = segs.map(s => (s.c === 'Z' ? s : { c: s.c, p: s.p.map((v, i) => (i % 2 === 0 ? v - b.x : v - b.y)) }) as PathSeg);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { x: r(b.x), y: r(b.y), w: r(w), h: r(h), rot: 0, d: pathToString(rel, 3), vb: `0 0 ${r(w)} ${r(h)}` };
}

const close = (a: unknown, b: unknown) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 2e-3 : a === b);

/* ------------------------------------------------------------------ keeping them attached */

const OWN = 'olConnectors';

/**
 * appendTransaction of the layout plugin: on the pages the transactions changed, ids made unique
 * again, ends whose object is gone let go, and every connector drawn to its objects. Live previews of
 * a drag are followed too, without history like them. Not for collaborators' changes.
 */
export function followConnectors(trs: readonly Transaction[], oldState: EditorState, state: EditorState): Transaction | null {
  const mine = trs.filter(t => t.docChanged && !t.getMeta(OWN) && !(t.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin);
  if (!mine.length) return null;
  const before = new Set<PMNode>();
  oldState.doc.forEach(p => before.add(p));
  const tr = state.tr;
  state.doc.forEach((page, pagePos) => {
    if (page.type.name !== 'ol_page' || before.has(page)) return;
    const objs = allObjects(page, pagePos);
    if (!objs.some(o => o.node.attrs.id)) return;
    // ids twice on the page (a copy made some other way than copyObjects): the later one gets a new id
    const seen = new Set<string>(), fresh = new Set<string>();
    for (const o of objs) {
      const id = o.node.attrs.id as string | null;
      if (!id) continue;
      if (!seen.has(id)) { seen.add(id); continue; }
      const nid = freshId(page, new Set([...seen, ...fresh]));
      fresh.add(nid);
      tr.setNodeMarkup(tr.mapping.map(o.pos), undefined, { ...tr.doc.nodeAt(tr.mapping.map(o.pos))!.attrs, id: nid });
    }
    // every connector of the page to its objects (an end whose object went is let go)
    const pg = tr.doc.nodeAt(tr.mapping.map(pagePos))!;
    const ppos = tr.mapping.map(pagePos);
    for (const o of allObjects(pg, ppos)) {
      if (!isConnector(o.node) || (!o.node.attrs.from && !o.node.attrs.to)) continue;
      let node = o.node;
      const lost: Record<string, null> = {};
      for (const k of ['from', 'to'] as const) { const e = parseEnd(node.attrs[k]); if (e && !objectById(pg, ppos, e.id)) lost[k] = null; }
      if (Object.keys(lost).length) node = node.type.create({ ...node.attrs, ...lost });
      const segs = connectorPath(pg, ppos, node);
      const attrs = segs ? { ...node.attrs, ...shapeAttrsFor(segs) } : node.attrs;
      if (Object.keys(attrs).every(k => close(attrs[k], o.node.attrs[k]))) continue;
      tr.setNodeMarkup(o.pos, undefined, attrs);
    }
  });
  if (!tr.docChanged) return null;
  tr.setMeta(OWN, true);
  // a live preview's followers are no step of the history either
  if (mine.every(t => t.getMeta('addToHistory') === false)) tr.setMeta('addToHistory', false);
  return tr;
}
