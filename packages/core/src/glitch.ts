/**
 * Display glitches the app notices on a touch screen (an iPad's), reported as errors are (server
 * feedback.ts, POST /api/client-glitch; the client's glitches.ts watches for them):
 *   shift   the interface scrolled out of place: the window moved (it never scrolls — each pane
 *           scrolls itself), or a container that cannot be scrolled and fills much of the screen did
 *   zoom    the whole interface zoomed in (a pinch the app did not take)
 *   jump    a stroke's point far from the one before it, sooner than a hand gets there: drawn, a
 *           line across the screen
 * A report is measurements and fixed words only: sizes, scroll offsets, the kinds of control and of
 * input — never text, names, or where on the page something was drawn. The server takes nothing else
 * (glitchReport).
 */
import { INTERACTION_TARGETS } from './interactions.ts';

export const GLITCH_KINDS = ['shift', 'zoom', 'jump'] as const;
export type GlitchKind = typeof GLITCH_KINDS[number];

export const INK_ENGINES = ['deck', 'present', 'board', 'doc-ink', 'math-pad'] as const;
export type InkEngine = typeof INK_ENGINES[number];
export type InkSample = 'down' | 'move' | 'coalesced' | 'up';

/** each field a report may carry: a number, or one of these words */
const WORDS: Record<string, readonly string[] | 'number' | 'class'> = {
  // the screen
  app: ['home-screen', 'browser'], orientation: ['portrait', 'landscape'], view: ['home', 'editor', 'source', 'text', 'markdown', 'board', 'pdf', 'bib'],
  width: 'number', height: 'number', ui: ['modern', 'classic'],
  // shift / zoom
  scroller: ['window', 'container'], container: 'class', scrollY: 'number', scrollX: 'number', appTop: 'number',
  viewportTop: 'number', viewportHeight: 'number', layoutHeight: 'number', zoom: 'number',
  keyboard: ['up', 'bar', 'down'], focus: ['none', 'text', 'math', 'input', 'textarea', 'editable', 'frame', 'button', 'other'],
  focusAt: ['on-screen', 'below', 'above', 'hidden', 'none'], lasted: 'number', restored: ['yes', 'no'],
  // jump
  engine: INK_ENGINES, pointer: ['pen', 'touch', 'mouse'], sample: ['down', 'move', 'coalesced', 'up'], before: ['down', 'move', 'coalesced', 'up'],
  at: ['first', 'middle', 'last'], jump: 'number', dt: 'number', points: 'number', spike: ['yes', 'no'], place: ['inside', 'origin', 'outside'],
  scrolled: 'number', stroke: 'number',
};

/** what happened before a glitch, as `<ms before> <word> [<word or number>…]` (glitches.ts keeps them) */
const TRAIL_WORDS = new Set([
  'down', 'cancel', 'focus', 'blur', 'keyboard', 'scroll', 'viewport', 'zoom', 'orientation', 'hidden', 'visible', 'view', 'key', 'mod', 'pinch', 'restored',
  'container', 'up', 'bar', 'pen', 'touch', 'mouse',
  ...(WORDS.focus as string[]), ...(WORDS.focusAt as string[]), ...(WORDS.orientation as string[]), ...(WORDS.view as string[]),
  ...INTERACTION_TARGETS,   // the surfaces a pointer goes down on
]);
export const TRAIL_MAX = 16;

export type GlitchFields = Record<string, string | number>;

const CLASS_RE = /^[a-z][a-z0-9-]{0,39}$/;
const fieldOk = (k: string, v: unknown): boolean => {
  const w = WORDS[k];
  if (!w) return false;
  if (w === 'number') return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7;
  if (w === 'class') return typeof v === 'string' && CLASS_RE.test(v);
  return typeof v === 'string' && w.includes(v);
};
const trailOk = (s: unknown): s is string => {
  if (typeof s !== 'string' || s.length > 80) return false;
  const [ms, ...rest] = s.split(' ');
  return /^\d{1,7}$/.test(ms) && rest.length >= 1 && rest.length <= 4 && rest.every(w => TRAIL_WORDS.has(w) || /^-?\d{1,6}$/.test(w));
};

/** only what may be sent: unknown fields, other words and free text left out */
export function cleanGlitch(kind: unknown, fields: unknown, trail: unknown): { kind: GlitchKind; fields: GlitchFields; trail: string[] } | null {
  if (typeof kind !== 'string' || !(GLITCH_KINDS as readonly string[]).includes(kind) || !fields || typeof fields !== 'object') return null;
  const f: GlitchFields = {};
  for (const [k, v] of Object.entries(fields as Record<string, unknown>)) if (fieldOk(k, v)) f[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v as string;
  const t = Array.isArray(trail) ? trail.filter(trailOk).slice(-TRAIL_MAX) : [];
  return { kind: kind as GlitchKind, fields: f, trail: t };
}

/**
 * The stored report: its message (what tells one glitch from another — the same message is the same
 * report, counted) and the measurements, one per line.
 */
export function glitchReport(kind: unknown, fields: unknown, trail: unknown): { message: string; details: Record<string, string>; trail: string } | null {
  const g = cleanGlitch(kind, fields, trail);
  if (!g) return null;
  const f = g.fields, w = (k: string) => (f[k] === undefined ? '?' : String(f[k]));
  const message = g.kind === 'jump'
    ? `A stroke jumped across the screen · ${w('engine')} · ${w('pointer')} · ${w('sample')} point, ${w('at')} of the stroke${f.spike === 'yes' ? ' · one stray point' : ''}${f.place && f.place !== 'inside' ? ` · at the ${f.place === 'origin' ? 'screen corner (0, 0)' : 'outside of the screen'}` : ''}`
    : g.kind === 'zoom'
      ? `The interface was zoomed in · ${w('app')}`
      : `The interface scrolled out of place · ${f.scroller === 'container' ? `a container (${w('container')})` : 'the window'} · keyboard ${w('keyboard')} · focus ${w('focus')} ${w('focusAt')} · ${w('app')}`;
  const details: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) details[k] = String(v);
  return { message, details, trail: g.trail.length ? `Before it (ms before · what):\n${g.trail.join('\n')}` : '' };
}

/**
 * One stroke's points as the screen had them, to find a point that cannot be where the hand went:
 * further from the one before than a third of the screen's shorter side (and 200 px). `x`, `y` are
 * client px; `ox`, `oy` how far the surface drawn on had scrolled (what the stroke is drawn in is
 * client + scroll: a surface scrolling mid-stroke moves the line, the hand need not have).
 */
export class StrokeWatch {
  private pts: { x: number; y: number; ox: number; oy: number; t: number; s: InkSample }[] = [];
  constructor(readonly engine: InkEngine, readonly pointer: string, private readonly screen: { w: number; h: number }) {}

  add(x: number, y: number, t: number, s: InkSample, ox = 0, oy = 0): void {
    if (this.pts.length < 6000) this.pts.push({ x, y, ox, oy, t, s });
  }

  /** the stroke ended: the worst jump in it, as a report's fields — null when there was none */
  end(): GlitchFields | null {
    const p = this.pts, n = p.length, { w, h } = this.screen;
    const limit = Math.max(200, Math.min(w, h) / 3);
    let worst = -1, far = 0;
    for (let i = 1; i < n; i++) {
      const d = Math.hypot(p[i].x + p[i].ox - p[i - 1].x - p[i - 1].ox, p[i].y + p[i].oy - p[i - 1].y - p[i - 1].oy);
      if (Number.isNaN(d)) { far = Infinity; worst = i; break; }   // a point nowhere
      if (d > far) { far = d; worst = i; }
    }
    if (worst < 0 || far < limit) return null;
    // the way back from a stray point can be the longer: the jump is the one to it
    if (worst >= 2 && Number.isFinite(far) && Math.hypot(p[worst].x + p[worst].ox - p[worst - 2].x - p[worst - 2].ox, p[worst].y + p[worst].oy - p[worst - 2].y - p[worst - 2].oy) < far / 3) {
      worst--;
      far = Math.hypot(p[worst].x + p[worst].ox - p[worst - 1].x - p[worst - 1].ox, p[worst].y + p[worst].oy - p[worst - 1].y - p[worst - 1].oy);
    }
    const a = p[worst - 1], b = p[worst], c = p[worst + 1];
    const back = c ? Math.hypot(c.x + c.ox - a.x - a.ox, c.y + c.oy - a.y - a.oy) : Infinity;
    const place = b.x === 0 && b.y === 0 ? 'origin' : !(b.x >= -2 && b.y >= -2 && b.x <= w + 2 && b.y <= h + 2) ? 'outside' : 'inside';
    const scrolled = Math.max(...p.map(q => Math.hypot(q.ox - p[0].ox, q.oy - p[0].oy)));
    const pointer = ['pen', 'touch', 'mouse'].includes(this.pointer) ? this.pointer : 'touch';
    return {
      engine: this.engine, pointer, sample: b.s, before: a.s, at: worst === 1 ? 'first' : worst === n - 1 ? 'last' : 'middle',
      jump: Number.isFinite(far) ? Math.round((far / Math.min(w, h)) * 100) : 999, dt: Math.round(b.t - a.t), points: n,
      spike: back < far / 3 ? 'yes' : 'no', place, scrolled: Math.round(scrolled), stroke: Math.round(p[n - 1].t - p[0].t),
    };
  }
}
