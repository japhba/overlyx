/**
 * The laser pointer, alike wherever there is one: the document margins (editor/plugins/ink.ts), the
 * whiteboard (app/BoardEditor.tsx) and presenting (app/presentkit.ts: layout documents and HTML
 * decks). Its trace is drawn as the pen draws (core freehand.ts: the pen case's nib; a Pencil's
 * pressure, the line thinning out where it lands and lifts), over a soft glow, at one opacity from
 * end to end; a dot marks where it points while it is held. Lifted, the traces stay and fade out
 * together over LASER_FADE_MS; the pen put down again before they are gone brings them all back at
 * full strength, and the new trace joins them (LaserSession). The others' lasers arrive as the trace
 * they hold (awareness) and are gathered into sessions here alike (`hold`, `end`).
 */
import { inkRuns, inkPaths, chunkPaths, runPathD, LIVE_CHUNK, type FreePt, type InkCache, type NibOpts } from '@overlyx/core/freehand.ts';

/** one's own laser's colour (the others' take their presence colour) */
export const LASER_COLOR = '#e0284b';
/** how long lifted traces take to fade out */
export const LASER_FADE_MS = 3000;
/** the trace's width, its glow's, and the glow's opacity (screen px) */
export const LASER_W = 3.2;
export const LASER_GLOW_W = 11;
export const LASER_GLOW_OPACITY = 0.3;
/** the most points a session keeps (its oldest traces go first), and a trace (a longer one goes on as the next) */
const SESSION_PTS = 8000;
const TRACE_PTS = 2000;

export interface LaserTrace {
  /** [x, y, pressure] in the view's units */
  pts: FreePt[];
  /** a Pencil's: its pressure is drawn */
  pen: boolean;
  /** still held */
  held: boolean;
  /** the sender's number for it (another's laser): another number is another trace */
  id?: number;
  /** what the engine keeps while it is held (freehand.ts InkCache), and its paths as last worked out */
  cache?: InkCache;
  drawn?: TracePaths & { key: string; src: FreePt[]; n: number; canvas?: { glow: Path2D; runs: { w: number; path: Path2D }[] } };
}
export interface TracePaths { glow: string; runs: { w: number; d: string }[] }

/** one person's laser traces, from the first put down until they have faded out */
export class LaserSession {
  traces: LaserTrace[] = [];
  /** when the last trace was lifted; null while one is held */
  liftedAt: number | null = null;
  /** counts the changes (a drawing of the traces stays good until it changes) */
  v = 0;
  /** the last trace's number (one's own: another's are numbered by the sender) */
  private seq = 0;

  get held(): LaserTrace | null {
    const t = this.traces[this.traces.length - 1];
    return t?.held ? t : null;
  }
  /** its opacity now: 1 while held, then less, down to 0 LASER_FADE_MS after the lift */
  alpha(now: number): number {
    if (!this.traces.length) return 0;
    return this.liftedAt === null ? 1 : Math.max(0, 1 - (now - this.liftedAt) / LASER_FADE_MS);
  }
  gone(now: number): boolean { return this.alpha(now) <= 0; }
  /** lifted and not yet faded out */
  fading(now: number): boolean { return this.liftedAt !== null && !this.gone(now); }

  /** the pen put down: a new trace, and those still fading back at full strength (faded ones are gone) */
  begin(pts: FreePt[], pen: boolean, now: number, id: number | undefined = ++this.seq): LaserTrace {
    if (this.gone(now)) this.traces = [];
    for (const t of this.traces) t.held = false;
    const t: LaserTrace = { pts, pen, held: true, ...(id !== undefined ? { id } : {}) };
    this.traces.push(t);
    let n = 0;
    for (const x of this.traces) n += x.pts.length;
    while (this.traces.length > 1 && n > SESSION_PTS) n -= this.traces.shift()!.pts.length;
    this.liftedAt = null;
    this.v++;
    return t;
  }
  /** a point more on the trace held; true: that was long, and a new trace goes on from its end */
  add(pt: FreePt, now: number): boolean {
    const t = this.held;
    if (!t) return false;
    if (t.pts.length < TRACE_PTS) { t.pts.push(pt); this.v++; return false; }
    this.begin([[...t.pts[t.pts.length - 1]], pt], t.pen, now);
    return true;
  }
  /** another's trace held, as it came: the same one again (its number), or a new one */
  hold(pts: FreePt[], pen: boolean, now: number, id?: number): void {
    const t = this.held, n = id ?? -1;   // (a sender that numbers none: one trace until it lets go)
    if (t && t.id === n) { t.pts = pts; t.pen = pen; this.v++; }
    else this.begin(pts, pen, now, n);
  }
  /** the trace held given up (the hand's touch, not a pointer): what was there before fades out from now */
  drop(now: number): void {
    if (!this.held) return;
    this.traces.pop();
    this.liftedAt = now;
    this.v++;
  }
  /** lifted: all of it fades out from now */
  end(now: number): void {
    const t = this.held;
    if (!t) return;
    t.held = false;
    this.liftedAt = now;
    this.v++;
  }
  clear(): void {
    if (!this.traces.length) return;
    this.traces = [];
    this.liftedAt = null;
    this.v++;
  }
}

/**
 * A trace's paths in its points' units, `zoom` screen px to the unit (the laser's width and the
 * engine's smoothing are the screen's): the line through its runs for the glow, and the runs as the
 * pen's, one path for each width. Kept until the trace or the zoom changes; of a held one only the
 * end is worked out again.
 */
export function tracePaths(t: LaserTrace, nib: NibOpts, zoom = 1): TracePaths {
  const key = `${zoom} ${t.held ? 1 : 0}`;
  const d = t.drawn;
  if (d && d.key === key && d.src === t.pts && d.n === t.pts.length) return d;
  const runs = inkRuns(t.pts, {
    width: LASER_W / zoom, pressure: t.pen, zoom, nib: t.pen ? { ...nib, lift: true } : nib, final: !t.held,
    ...(t.held ? { cache: (t.cache ??= {}), chunk: LIVE_CHUNK } : {}),
  });
  if (!t.held) t.cache = undefined;
  t.drawn = { key, src: t.pts, n: t.pts.length, glow: runs.map(r => runPathD(r)).join(''), runs: t.held ? chunkPaths(runs) : inkPaths(runs) };
  return t.drawn;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** traces as SVG markup, in their points' units (`zoom` screen px to the unit): one glow under them all, then their lines */
export function tracesSvg(traces: readonly LaserTrace[], color: string, nib: NibOpts, zoom = 1): string {
  let glow = '', lines = '';
  for (const t of traces) {
    const p = tracePaths(t, nib, zoom);
    glow += p.glow;
    for (const r of p.runs) lines += `<path d="${r.d}" stroke-width="${r.w}"/>`;
  }
  if (!glow) return '';
  return `<g class="trace" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round"><path class="glow" d="${glow}" stroke-opacity="${LASER_GLOW_OPACITY}" stroke-width="${r2(LASER_GLOW_W / zoom)}"/>${lines}</g>`;
}

/** where a held laser points: a soft dot with a white centre (`zoom` screen px to the unit) */
export function dotSvg(x: number, y: number, color = LASER_COLOR, zoom = 1): string {
  return `<circle class="head" cx="${r2(x)}" cy="${r2(y)}" r="${r2(8 / zoom)}" fill="${color}" fill-opacity="0.5"/><circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(2.2 / zoom)}" fill="#fff" fill-opacity="0.9"/>`;
}

/** traces on a canvas, in their points' units as the context is set up (`zoom` screen px to the unit): one glow under them all, then their lines, at full strength */
export function paintTraces(ctx: CanvasRenderingContext2D, traces: readonly LaserTrace[], color: string, nib: NibOpts, zoom = 1): void {
  const glow = new Path2D();
  const lines: { w: number; path: Path2D }[] = [];
  for (const t of traces) {
    tracePaths(t, nib, zoom);
    const d = t.drawn!;
    d.canvas ??= { glow: new Path2D(d.glow), runs: d.runs.map(r => ({ w: r.w, path: new Path2D(r.d) })) };
    glow.addPath(d.canvas.glow);
    lines.push(...d.canvas.runs);
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.globalAlpha = LASER_GLOW_OPACITY;
  ctx.lineWidth = LASER_GLOW_W / zoom;
  ctx.stroke(glow);
  ctx.globalAlpha = 1;
  for (const l of lines) { ctx.lineWidth = l.w; ctx.stroke(l.path); }
  ctx.restore();
}

/** the dot of paintTraces' laser where it points (canvas px) */
export function paintDot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.globalAlpha = 0.9;
  ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
