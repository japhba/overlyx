/**
 * What the lasso takes and what it copies, for documents' margins and whiteboards:
 *
 * - its filter (Draw's lasso settings, deckink.ts): the kinds it takes and the colours it is limited
 *   to — a stroke is handwriting, or a shape when it is a `poly` one (a line or shape of the Draw row,
 *   a stroke snapped by draw and hold);
 * - its clipboard: strokes, pictures and sticky notes copied with the lasso (its bar, Ctrl+C / Ctrl+X)
 *   go both into memory and onto the system clipboard as JSON text with a marker, so they paste into
 *   another document's margin or a board — in this tab, another, or after a reload. Their places
 *   are relative to the copied selection's top-left corner, in px at 100 %.
 */
import type { NibOpts } from '@overlyx/core/freehand.ts';
import { colorsPass, getLassoColors, hexColor, loadDeckInk, type LassoKind } from './deckink';

/** whether the lasso, set to take `kinds` of the colours `filter`, takes a thing of `kind` and `colors` */
export function lassoAllows(kind: LassoKind, colors: readonly (string | null | undefined)[], kinds: readonly LassoKind[], filter: readonly string[]): boolean {
  return kinds.includes(kind) && colorsPass(filter, colors);
}

/** the same, with this browser's lasso settings */
export function lassoTakes(kind: LassoKind, colors: readonly (string | null | undefined)[]): boolean {
  return lassoAllows(kind, colors, loadDeckInk().lasso, getLassoColors());
}

/** the colours among `colors` (CSS colours, as many times as they are used), the most used first */
export function usedColors(colors: readonly (string | null | undefined)[]): string[] {
  const n = new Map<string, number>();
  for (const c of colors) { const h = hexColor(c); if (h) n.set(h, (n.get(h) ?? 0) + 1); }
  return [...n].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

export interface ClipStroke { color: string; w: number; o?: number; nib?: NibOpts; pressure?: boolean; poly?: true; pts: [number, number, number][] }
/** a picture: the project and its project-relative path (a document's are relative to it) */
export interface ClipImage { project: string; path: string; x: number; y: number; w: number; h: number }
export interface ClipNote { text: string; color?: string; x: number; y: number; w: number; h: number }
export interface InkClip { strokes: ClipStroke[]; imgs: ClipImage[]; notes: ClipNote[]; w: number; h: number }

const MARK = 'overlyxInk';
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A clip of things at absolute places (any one unit, the same for all): moved so that their box
 * starts at (0, 0).
 */
export function makeInkClip(parts: { strokes?: ClipStroke[]; imgs?: ClipImage[]; notes?: ClipNote[] }): InkClip | null {
  const strokes = parts.strokes ?? [], imgs = parts.imgs ?? [], notes = parts.notes ?? [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const [x, y] of s.pts) { x0 = Math.min(x0, x - s.w / 2); y0 = Math.min(y0, y - s.w / 2); x1 = Math.max(x1, x + s.w / 2); y1 = Math.max(y1, y + s.w / 2); }
  for (const b of [...imgs, ...notes]) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  if (x0 > x1) return null;
  return {
    strokes: strokes.map(s => ({ ...s, pts: s.pts.map(([x, y, p]) => [r2(x - x0), r2(y - y0), p] as [number, number, number]) })),
    imgs: imgs.map(b => ({ ...b, x: r2(b.x - x0), y: r2(b.y - y0) })),
    notes: notes.map(b => ({ ...b, x: r2(b.x - x0), y: r2(b.y - y0) })),
    w: r2(x1 - x0), h: r2(y1 - y0),
  };
}

/** the clip as the system clipboard holds it */
export function inkClipText(clip: InkClip): string {
  return JSON.stringify({ [MARK]: 1, ...clip });
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBox = (b: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }) => isNum(b.x) && isNum(b.y) && isNum(b.w) && isNum(b.h) && (b.w as number) > 0 && (b.h as number) > 0;

/** a clip read back from the clipboard's text (null: not one, or broken) */
export function parseInkClip(text: string | null | undefined): InkClip | null {
  if (!text || !text.includes(MARK)) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  if (!j || j[MARK] !== 1) return null;
  const strokes = (Array.isArray(j.strokes) ? j.strokes : []).filter((s: ClipStroke) =>
    s && typeof s.color === 'string' && isNum(s.w) && s.w > 0 && Array.isArray(s.pts) && s.pts.length > 0 && s.pts.every(p => Array.isArray(p) && isNum(p[0]) && isNum(p[1])))
    .map((s: ClipStroke): ClipStroke => ({
      color: hexColor(s.color) ?? '#000000', w: s.w, ...(isNum(s.o) ? { o: s.o } : {}), ...(s.poly ? { poly: true as const } : {}),
      ...(s.nib && typeof s.nib === 'object' ? { nib: s.nib } : {}), ...(typeof s.pressure === 'boolean' ? { pressure: s.pressure } : {}),
      pts: s.pts.slice(0, 4000).map(p => [p[0], p[1], isNum(p[2]) ? p[2] : 0] as [number, number, number]),
    }));
  const imgs = (Array.isArray(j.imgs) ? j.imgs : []).filter((b: ClipImage) => b && typeof b.project === 'string' && typeof b.path === 'string' && isBox(b));
  const notes = (Array.isArray(j.notes) ? j.notes : []).filter((b: ClipNote) => b && typeof b.text === 'string' && isBox(b))
    .map((b: ClipNote) => ({ ...b, text: b.text.slice(0, 4000) }));
  if (!strokes.length && !imgs.length && !notes.length) return null;
  return { strokes, imgs, notes, w: isNum(j.w) ? j.w : 0, h: isNum(j.h) ? j.h : 0 };
}

let held: InkClip | null = null;

/** copied: kept here, and put on the system clipboard as text (as far as the browser lets it) */
export function holdInk(clip: InkClip, e?: ClipboardEvent): void {
  held = clip;
  const text = inkClipText(clip);
  if (e?.clipboardData) { e.clipboardData.setData('text/plain', text); e.preventDefault(); return; }
  try { void navigator.clipboard?.writeText(text).catch(() => { /* not allowed: the copy here still pastes */ }); } catch { /* no clipboard */ }
}

/** what was copied last in this tab */
export function heldInk(): InkClip | null { return held; }

/** the clip a paste brings: the clipboard's when it holds one, else nothing (the clipboard has something else) */
export function pastedInk(e: ClipboardEvent): InkClip | null {
  const text = e.clipboardData?.getData('text/plain');
  if (text) return parseInkClip(text);
  // (no text at all: a browser that did not let the copy write it)
  return e.clipboardData && !e.clipboardData.files.length ? held : null;
}

/** points turned by `a` radians about (cx, cy) (a lasso selection rotated) */
export function rotatePts<P extends number[]>(pts: readonly P[], cx: number, cy: number, a: number): P[] {
  const c = Math.cos(a), s = Math.sin(a);
  return pts.map(p => { const x = p[0] - cx, y = p[1] - cy; const q = p.slice() as P; q[0] = cx + x * c - y * s; q[1] = cy + x * s + y * c; return q; });
}

/** the rotation handle's angle, Shift: in steps of 15° */
export function rotationAngle(a: number, shift: boolean): number {
  return shift ? Math.round(a / (Math.PI / 12)) * (Math.PI / 12) : a;
}

/** a thinner or thicker stroke width (the lasso bar's), kept within reason */
export function thickened(w: number, k: number): number {
  return Math.round(Math.max(0.3, Math.min(80, w * k)) * 100) / 100;
}
