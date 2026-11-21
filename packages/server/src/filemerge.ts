/**
 * Three-way merges for the documents whose file is not LaTeX or markdown: an HTML deliverable's text
 * (decks, posters, web pages — by lines, as `git merge-file` does) and a board's objects (by object
 * id). Used when the file changed on disk while the document had edits not written yet: while it is
 * open (docs.ts HtmlDoc/BoardDoc.absorbExternalChange), and when a restart finds edits the server
 * stored but had not written (DocManager.openHtmlCold / openBoardCold).
 *
 * What only one side changed is taken from it. Where both changed the same lines (or adjacent ones,
 * with no unchanged line between) or the same object differently, the file's version is taken and
 * the caller keeps the state as it was as a version in History (`conflicts` > 0).
 */
import { align } from '@overlyx/core/lyx/merge.ts';

/** a replacement in `ours`: [from, from + removed) becomes `insert` */
export interface Splice { from: number; removed: number; insert: string }

const linesOf = (s: string): string[] => s.length ? s.split(/(?<=\n)/) : [];

/**
 * `base` → `theirs` merged into `ours` by lines: the splices to make in `ours` (ascending, not
 * overlapping), the merged text, and how many places both changed differently (taken from `theirs`).
 */
export function mergeLines(base: string, ours: string, theirs: string): { splices: Splice[]; text: string; conflicts: number } {
  const b = linesOf(base), o = linesOf(ours), t = linesOf(theirs);
  const mo = new Map(align(b, o)), mt = new Map(align(b, t));
  // where each line of ours starts
  const at = new Array<number>(o.length + 1);
  at[0] = 0;
  for (let i = 0; i < o.length; i++) at[i + 1] = at[i] + o[i].length;
  const splices: Splice[] = [];
  let conflicts = 0;
  let ib = 0, io = 0, it = 0;
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  /** the unstable chunk before the next lines all three share: b[ib, eb), o[io, eo), t[it, et) */
  const chunk = (eb: number, eo: number, et: number) => {
    if (eb === ib && eo === io && et === it) return;
    const cb = b.slice(ib, eb), co = o.slice(io, eo), ct = t.slice(it, et);
    if (same(ct, cb) || same(ct, co)) return;                 // theirs did not change it (or alike): ours
    if (!same(co, cb)) conflicts++;                             // both changed it differently: theirs
    splices.push({ from: at[io], removed: at[eo] - at[io], insert: ct.join('') });
  };
  for (let i = 0; i < b.length; i++) {
    const jo = mo.get(i), jt = mt.get(i);
    if (jo === undefined || jt === undefined || jo < io || jt < it) continue;
    chunk(i, jo, jt);
    ib = i + 1; io = jo + 1; it = jt + 1;
  }
  chunk(b.length, o.length, t.length);
  let text = '', p = 0;
  for (const s of splices) { text += ours.slice(p, s.from) + s.insert; p = s.from + s.removed; }
  return { splices, text: text + ours.slice(p), conflicts };
}

/** the objects of a board file (null: not a board's JSON) */
export function boardObjects(text: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(text) as { objects?: unknown };
    return j && typeof j === 'object' && j.objects && typeof j.objects === 'object' && !Array.isArray(j.objects) ? j.objects as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * `base` → `theirs` merged into `ours`, object by object: what to set (undefined: delete) in ours,
 * and how many objects both changed differently (taken from theirs).
 */
export function mergeObjects(base: Record<string, unknown>, ours: Map<string, unknown>, theirs: Record<string, unknown>): { set: Map<string, unknown>; conflicts: number } {
  const set = new Map<string, unknown>();
  let conflicts = 0;
  const j = (v: unknown) => v === undefined ? undefined : JSON.stringify(v);
  const has = (r: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(r, k);
  for (const k of new Set([...Object.keys(base), ...ours.keys(), ...Object.keys(theirs)])) {
    const b = has(base, k) ? j(base[k]) : undefined, o = j(ours.get(k)), t = has(theirs, k) ? j(theirs[k]) : undefined;
    if (t === b || t === o) continue;                            // theirs did not change it (or alike): ours
    if (o !== b) conflicts++;                                    // both changed it differently: theirs
    set.set(k, has(theirs, k) ? theirs[k] : undefined);
  }
  return { set, conflicts };
}
