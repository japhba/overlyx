/**
 * Guides, the grid and the rulers of the layout canvas (Inkscape's): guides are lines across every
 * page at a distance from its left or top edge, dragged out of a ruler, moved by dragging, removed by
 * dragging them back onto it or off the page; the grid is a square mesh of a spacing. Both are the
 * document's — header settings `overlyx_guides` ("x20 y45.5", mm) and `overlyx_grid` (mm), kept in the
 * file's settings line — so collaborators see the same; whether the grid, the guides and the rulers
 * are shown, and whether moves snap to the grid, is each reader's (remembered per browser). Moving and
 * resizing snap to the guides whenever they are shown (Alt: no snapping), as to the page and objects.
 */
export interface Guide { axis: 'x' | 'y'; at: number }

/** "x20 y45.5" → guides */
export function parseGuides(s: string | undefined | null): Guide[] {
  const out: Guide[] = [];
  for (const t of (s ?? '').trim().split(/\s+/)) {
    const m = /^([xy])(-?\d+(?:\.\d+)?)$/.exec(t);
    if (m) out.push({ axis: m[1] as 'x' | 'y', at: Number(m[2]) });
  }
  return out;
}

export function formatGuides(list: Guide[]): string {
  return list.map(g => `${g.axis}${Math.round(g.at * 100) / 100}`).join(' ');
}

/** a header line's value (`\key value`) */
export function headerValue(lines: string[], key: string): string | undefined {
  const l = lines.find(x => x === '\\' + key || x.startsWith('\\' + key + ' '));
  return l === undefined ? undefined : l.slice(key.length + 2);
}

/** The grid's spacing for a page when the document names none: about a 32nd of its width, a round number of mm. */
export function defaultGrid(page: { w: number }): number {
  const steps = [1, 2, 2.5, 5, 10, 20, 25, 50];
  const want = page.w / 32;
  return steps.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
}

/* ------------------------------------------------------------------ the reader's switches */

export type CanvasPref = 'grid' | 'snapGrid' | 'guides' | 'rulers';
const DEFAULTS: Record<CanvasPref, boolean> = { grid: false, snapGrid: false, guides: true, rulers: true };

export function canvasPref(k: CanvasPref): boolean {
  try { const v = localStorage.getItem('ol.canvas.' + k); return v === null ? DEFAULTS[k] : v === '1'; } catch { return DEFAULTS[k]; }
}
export function setCanvasPref(k: CanvasPref, on: boolean): void {
  try { localStorage.setItem('ol.canvas.' + k, on ? '1' : '0'); } catch { /* not remembered */ }
}

/* ------------------------------------------------------------------ rulers */

export interface RulerHost {
  /** the page the rulers measure: its sheet on screen and its size in mm (null: none shown) */
  sheet(): { rect: DOMRect; w: number; h: number } | null;
  /** a guide dragged out of a ruler: the controller takes the gesture from here */
  dragOut(ev: PointerEvent, axis: 'x' | 'y'): void;
}

const SIZE = 18;

/**
 * Two rulers along the top and the left of the canvas, in millimetres of the page shown (its corner is
 * 0), lying over the scroller's edges like the slide rail; drawn again on scroll and zoom. A press in
 * one drags out a guide: from the top ruler a horizontal one, from the left a vertical one.
 */
export class LayoutRulers {
  readonly top: HTMLCanvasElement;
  readonly left: HTMLCanvasElement;
  private corner: HTMLElement;
  private raf = 0;
  private ro: ResizeObserver | null = null;

  constructor(private scroller: HTMLElement, private host: RulerHost) {
    const column = scroller.parentElement!;
    if (getComputedStyle(column).position === 'static') column.style.position = 'relative';
    this.top = document.createElement('canvas');
    this.top.className = 'ol-ruler ol-ruler-top';
    this.top.title = 'Drag down onto the page for a horizontal guide';
    this.left = document.createElement('canvas');
    this.left.className = 'ol-ruler ol-ruler-left';
    this.left.title = 'Drag right onto the page for a vertical guide';
    this.corner = document.createElement('div');
    this.corner.className = 'ol-ruler-corner';
    this.top.addEventListener('pointerdown', e => { if (e.button === 0) { e.preventDefault(); this.host.dragOut(e, 'y'); } });
    this.left.addEventListener('pointerdown', e => { if (e.button === 0) { e.preventDefault(); this.host.dragOut(e, 'x'); } });
    column.append(this.top, this.left, this.corner);
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => this.refresh()); this.ro.observe(scroller); }
    this.refresh();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.top.remove(); this.left.remove(); this.corner.remove();
  }

  /** is a point (client coordinates) over one of the rulers? (a guide dropped there is taken away) */
  over(x: number, y: number): boolean {
    for (const el of [this.top, this.left]) { const r = el.getBoundingClientRect(); if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true; }
    return false;
  }

  private onScroll = (): void => this.refresh();

  /** drawn again in the next frame */
  refresh(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private draw(): void {
    const s = this.scroller;
    // over the scroller's visible area, right of the slide rail (the editor's padding says how wide it is)
    const railW = parseFloat(getComputedStyle(s.querySelector('.lyx-editor') ?? s).getPropertyValue('--ol-rail-w')) || 0;
    const x0 = s.offsetLeft + railW, y0 = s.offsetTop;
    const w = s.clientWidth - railW, h = s.clientHeight;
    place(this.top, x0 + SIZE, y0, Math.max(0, w - SIZE), SIZE);
    place(this.left, x0, y0 + SIZE, SIZE, Math.max(0, h - SIZE));
    Object.assign(this.corner.style, { left: `${x0}px`, top: `${y0}px`, width: `${SIZE}px`, height: `${SIZE}px` });
    // (a page not laid out — hidden, none in the master view yet — measures nothing)
    const s0 = this.host.sheet();
    const sheet = s0 && s0.rect.width > 0 && s0.rect.height > 0 ? s0 : null;
    const tr = this.top.getBoundingClientRect(), lr = this.left.getBoundingClientRect();
    drawRuler(this.top, 'h', sheet ? sheet.rect.left - tr.left : 0, sheet ? sheet.rect.width / sheet.w : 1, sheet ? sheet.w : 0);
    drawRuler(this.left, 'v', sheet ? sheet.rect.top - lr.top : 0, sheet ? sheet.rect.height / sheet.h : 1, sheet ? sheet.h : 0);
  }
}

function place(c: HTMLCanvasElement, x: number, y: number, w: number, h: number): void {
  Object.assign(c.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (c.width !== pw) c.width = pw;
  if (c.height !== ph) c.height = ph;
}

/** ticks of a ruler: mm 0 at `origin` px, `pxPerMm`; the page's extent `len` mm is lighter than outside it */
function drawRuler(c: HTMLCanvasElement, dir: 'h' | 'v', origin: number, pxPerMm: number, len: number): void {
  const g = c.getContext('2d');
  if (!g) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.width / dpr, H = c.height / dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(c);
  const bg = css.getPropertyValue('--ruler-bg').trim() || '#f3f3f3', fg = css.getPropertyValue('--ruler-fg').trim() || '#777', page = css.getPropertyValue('--ruler-page').trim() || '#fff';
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  if (!(pxPerMm > 0) || !Number.isFinite(origin) || !(len > 0)) return;
  const along = dir === 'h' ? W : H;
  // the page's extent
  g.fillStyle = page;
  const a = origin, b = origin + len * pxPerMm;
  if (dir === 'h') g.fillRect(Math.max(0, a), 0, Math.max(0, Math.min(W, b) - Math.max(0, a)), H);
  else g.fillRect(0, Math.max(0, a), W, Math.max(0, Math.min(H, b) - Math.max(0, a)));
  // a labelled tick every `major` mm, at least ~60 px apart; minor ticks between
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const major = steps.find(st => st * pxPerMm >= 60) ?? 1000;
  const minor = major / (String(major).startsWith('2') ? 4 : 5);
  g.strokeStyle = fg; g.fillStyle = fg; g.lineWidth = 1;
  g.font = '9px system-ui, sans-serif';
  const from = Math.floor(-origin / pxPerMm / minor) * minor, to = (along - origin) / pxPerMm;
  if (!Number.isFinite(from) || !Number.isFinite(to) || (to - from) / minor > 4000) return;
  g.beginPath();
  for (let mm = from; mm <= to; mm += minor) {
    const p = Math.round(origin + mm * pxPerMm) + 0.5;
    const isMajor = Math.abs(mm / major - Math.round(mm / major)) < 1e-6;
    const t = isMajor ? SIZE * 0.55 : SIZE * 0.25;
    if (dir === 'h') { g.moveTo(p, SIZE); g.lineTo(p, SIZE - t); } else { g.moveTo(SIZE, p); g.lineTo(SIZE - t, p); }
    if (isMajor) {
      const label = String(Math.round(mm));
      if (dir === 'h') g.fillText(label, p + 2, 9);
      else { g.save(); g.translate(9, p + 2); g.rotate(-Math.PI / 2); g.textAlign = 'right'; g.fillText(label, 0, 0); g.restore(); }
    }
  }
  g.stroke();
  g.strokeStyle = css.getPropertyValue('--ruler-edge').trim() || '#ccc';
  g.beginPath();
  if (dir === 'h') { g.moveTo(0, H - 0.5); g.lineTo(W, H - 0.5); } else { g.moveTo(W - 0.5, 0); g.lineTo(W - 0.5, H); }
  g.stroke();
}
