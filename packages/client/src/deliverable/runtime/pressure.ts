/**
 * How hard a point was pressed (0..1), for Draw's strokes: a pen's pressure, and a Mac's Force Touch
 * trackpad's. Safari tells the trackpad's as `webkitForce` (0–3: a click about 1, a force click 2), on
 * the mouse events and as `webkitmouseforcechanged` — kept here as it changes, for pointer events that
 * lack it; Chrome may give it as the pointer's own pressure, where a plain mouse's button is 0.5
 * throughout. A mouse's stroke is drawn with pressure only once its pressures differ (`pressed`): a
 * button pressed is no pressure, nor is a trackpad dragged without clicking.
 */

let force = 0;
const busy = new Set<() => boolean>();
let watching = false;

/**
 * Safari's force as it changes (on the whole document: the pointer may be captured elsewhere); a force
 * click's own action (Look Up, a preview) held back while `drawing` says a stroke is under way.
 */
export function watchForce(drawing: () => boolean, doc: Document = document): () => void {
  busy.add(drawing);
  if (!watching) {
    watching = true;
    doc.addEventListener('webkitmouseforcechanged', e => { const f = (e as MouseEvent & { webkitForce?: number }).webkitForce; force = typeof f === 'number' && f > 0 ? f : 0; }, true);
    const hold = (e: Event) => { for (const d of busy) if (d()) { e.preventDefault(); return; } };
    doc.addEventListener('webkitmouseforcewillbegin', hold, true);
    doc.addEventListener('webkitmouseforcedown', hold, true);
  }
  return () => busy.delete(drawing);
}

/** how hard the point was pressed: a pen's (0 where it does not know, its first and last), the trackpad's, else 0.5 */
export function pointPressure(e: PointerEvent): number {
  if (e.pointerType === 'pen') return Math.max(0, e.pressure);
  if (e.pointerType !== 'mouse') return 0.5;
  const wf = (e as PointerEvent & { webkitForce?: number }).webkitForce;
  const f = typeof wf === 'number' && wf > 0 ? wf : force;
  // (a click's force, about 1, as a Pencil's usual writing, a quarter; a force click's, 2, three quarters — never 0, a pen's "not known")
  if (f > 0) return Math.max(0.02, Math.min(1, (f - 0.5) / 2));
  return e.pressure > 0 && e.pressure <= 1 ? e.pressure : 0.5;
}

/** whether a stroke's pressure is to be drawn: a pen's always; a mouse's once a point (`p`) was pressed otherwise than its first (`first`) */
export const pressed = (pointerType: string, first: number, p: number): boolean => pointerType === 'pen' || (pointerType === 'mouse' && Math.abs(p - first) > 0.02);
