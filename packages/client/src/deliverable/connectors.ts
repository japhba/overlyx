/**
 * Connectors between objects (runtime/connect.ts draws the line from one to the other; annotations.ts
 * keeps it attached): written into the slide as an empty SVG the runtime fills —
 *
 *   <svg data-ol-connector='{"from":{"id":"box-1","side":"right"},"to":{"id":"box-2","side":"left"},"route":"elbow"}' stroke="#1d2433" stroke-width="2"></svg>
 *
 * The two objects get an `id` when they have none (what the connector names). `route`: "elbow" or
 * "curved" (none: straight); `head` 0: no arrowhead. Colour, width and dashes are the SVG's own
 * stroke attributes (the toolbar's line controls).
 */
import { attr, elementAt, elementChildren, parseSource, walk, type HElement } from '@overlyx/core/html/source.ts';
import type { HtmlOp, Path } from './protocol';

export type Route = 'straight' | 'elbow' | 'curved';
const SIDES = new Set(['top', 'right', 'bottom', 'left', 'center', 'auto']);

/** a name for an object no other element in the page has */
function freshId(taken: Set<string>, el: HElement): string {
  const base = (attr(el, 'data-ol-name') ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || (el.tagName === 'img' ? 'picture' : el.tagName === 'svg' ? 'drawing' : 'box');
  for (let i = 1; ; i++) { const id = `${base}-${i}`; if (!taken.has(id)) { taken.add(id); return id; } }
}

/** the ops that connect the objects at `from` and `to` (siblings on one slide): their ids, and the connector after the last of its slide's objects */
export function connectOps(source: string, from: Path, to: Path, sides: [string, string], arrow: boolean, stroke = '#1d2433'): { ops: HtmlOp[]; path: Path } | null {
  const { doc } = parseSource(source);
  const a = elementAt(doc, from), b = elementAt(doc, to);
  if (!a || !b || a === b || from.length !== to.length || from.slice(0, -1).join() !== to.slice(0, -1).join()) return null;
  const parentPath = from.slice(0, -1), parent = elementAt(doc, parentPath);
  if (!parent) return null;
  const taken = new Set<string>();
  for (const el of walk(doc)) { const id = attr(el, 'id'); if (id) taken.add(id); }
  const ops: HtmlOp[] = [];
  const idOf = (el: HElement, path: Path) => { const id = attr(el, 'id'); if (id) return id; const fresh = freshId(taken, el); ops.push({ t: 'attr', path, name: 'id', value: fresh }); return fresh; };
  const end = (id: string, side: string) => (SIDES.has(side) && side !== 'auto' ? { id, side } : { id });
  const cfg = { from: end(idOf(a, from), sides[0]), to: end(idOf(b, to), sides[1]), ...(arrow ? {} : { head: 0 }) };
  // (before the speaker notes, which stay last)
  const kids = elementChildren(parent), lastKid = kids[kids.length - 1];
  const index = lastKid && /(^|\s)notes(\s|$)/.test(attr(lastKid, 'class') ?? '') ? kids.length - 1 : kids.length;
  ops.push({ t: 'insert', parent: parentPath, index, html: `<svg data-ol-connector='${JSON.stringify(cfg).replace(/'/g, '&#39;')}' stroke="${stroke}" stroke-width="2"></svg>` });
  return { ops, path: [...parentPath, index] };
}

/** a connector's settings changed (its route, its arrowhead): the attribute written again, the rest kept */
export function connectorOps(source: string, path: Path, change: { route?: Route; head?: boolean }): HtmlOp[] | null {
  const el = elementAt(parseSource(source).doc, path);
  const raw = el ? attr(el, 'data-ol-connector') : null;
  if (raw === null) return null;
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(raw) ?? {}; } catch { return null; }
  if (change.route !== undefined) {
    delete cfg.curve;
    if (change.route === 'straight') delete cfg.route; else cfg.route = change.route;
  }
  if (change.head !== undefined) { if (change.head) delete cfg.head; else cfg.head = 0; }
  return [{ t: 'attr', path, name: 'data-ol-connector', value: JSON.stringify(cfg) }];
}

/** the connectors attached to the objects at `paths` (or to what is inside them) on their slides: deleted with them */
export function connectorsFor(source: string, paths: Path[]): Path[] {
  const { doc } = parseSource(source);
  const ids = new Set<string>(), parents = new Map<string, Path>();
  for (const p of paths) {
    const el = elementAt(doc, p);
    if (!el) continue;
    for (const e of [el, ...walk(el)]) { const id = attr(e, 'id'); if (id) ids.add(id); }
    parents.set(p.slice(0, -1).join(), p.slice(0, -1));
  }
  if (!ids.size) return [];
  const gone = new Set(paths.map(p => p.join())), out: Path[] = [];
  const idOf = (a: unknown) => (typeof a === 'string' ? a : a && typeof a === 'object' ? (a as { id?: string }).id : undefined);
  for (const pp of parents.values()) {
    const parent = elementAt(doc, pp);
    if (!parent) continue;
    elementChildren(parent).forEach((k, i) => {
      const raw = k.tagName === 'svg' ? attr(k, 'data-ol-connector') : null;
      if (raw === null || gone.has([...pp, i].join())) return;
      try {
        const cfg = JSON.parse(raw) as { from?: unknown; to?: unknown };
        if ([idOf(cfg?.from), idOf(cfg?.to)].some(x => x && ids.has(x))) out.push([...pp, i]);
      } catch { /* a hand-written one that does not parse: left */ }
    });
  }
  return out;
}
