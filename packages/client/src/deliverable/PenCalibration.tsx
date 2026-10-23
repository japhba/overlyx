/**
 * The pen calibration (the pen's settings ▸ Calibrate…): a sheet of paper on which a few strokes are
 * drawn as a hand draws them — arches and points, loops, corners, a spiral and a quickening wave — for
 * the pen to trace, or anything else written there. Those strokes are drawn as the pen would give them
 * (its points a second, whole px if it gives those) and, like what the pen draws, with the settings
 * beside it as they change (with the saved ones while Compare is held): the width in points, the
 * levels in per cent. Save keeps them for this browser's pen (deckink.ts), on slides, boards and
 * documents' margins alike.
 *
 * It measures the pen too: points a second, whole-px positions (older Safari), its pressure — a
 * Pencil's or a Mac's Force Touch trackpad's (runtime/pressure.ts); the usual one (the median) is
 * drawn at the nominal width from then on (freehand.ts `usual`).
 */
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { appleTablet } from '../app/penrate';
import { HZ120_STEPS } from '../app/promotion';
import type { Nib } from './protocol';
import { DECK_INK_WIDTH_CHOICES, DEFAULT_NIB, loadDeckInk, patchDeckInk, saveDeckInk, type DeckInkPatch } from './deckink';
import { freshPoint, inkPaths, inkRuns, usualPressure, type FreePt } from './runtime/freehand';
import { NibLevels, rungStyle } from './PenSettings';
import { pointPressure, pressed, watchForce } from './runtime/pressure';
import { fmtPt, ptToPx, pxToPt } from './units';

type Pt = [number, number];

/* -------------------------------------------------------------------------------- the guides */

/** the guides' box (css px): drawn this size where the paper has room, smaller where not */
const BOX = { w: 800, h: 440 };

/** a polyline with a point every px */
function dense(poly: Pt[]): Pt[] {
  const out: Pt[] = [poly[0]];
  for (let i = 1; i < poly.length; i++) {
    const [ax, ay] = poly[i - 1], [bx, by] = poly[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let j = 1; j <= n; j++) out.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n]);
  }
  return out;
}
const curve = (n: number, f: (u: number) => Pt): Pt[] => dense(Array.from({ length: n + 1 }, (_, i) => f(i / n)));

/** arches over the baseline (an m's, its feet sharp), or under the x-height (a u's, `cups`) */
const arches = (x0: number, base: number, n: number, w: number, h: number, cups = false) =>
  curve(n * 40, u => { const t = u * n; const s = Math.abs(Math.sin(Math.PI * t)); return [x0 + w * t, cups ? base - h + h * s : base - h * s]; });
/** a cursive e's or l's loops (a prolate trochoid: b > a loops back) */
const loops = (x0: number, base: number, n: number, a: number, b: number, c: number) =>
  curve(n * 60, u => { const t = u * n * 2 * Math.PI; return [x0 + a * t - b * Math.sin(t), base - c * (1 - Math.cos(t))]; });
/** a spiral out from its centre */
const spiral = (cx: number, cy: number, turns: number, r: number) =>
  curve(turns * 90, u => { const t = u * turns * 2 * Math.PI; return [cx + r * u * Math.cos(t), cy + r * u * Math.sin(t)]; });
/** a wave that quickens */
const wave = (x0: number, x1: number, y: number, amp: number, cycles: number) =>
  curve(1200, u => [x0 + (x1 - x0) * u, y - amp * Math.sin(2 * Math.PI * cycles * u * u) * (1 - 0.35 * u)]);
const star = (cx: number, cy: number, r: number): Pt[] => dense(Array.from({ length: 6 }, (_, i) => { const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt; }));

/** the guides, row by row: where each sits in BOX, and what it is for (shown beside its row) */
const GUIDES: { pts: Pt[] }[] = [
  { pts: arches(40, 92, 6, 26, 36) },
  { pts: dense([[230, 56], [242, 92], [254, 56], [266, 92], [278, 56], [290, 92], [302, 56], [314, 92], [326, 56]]) },
  { pts: arches(370, 92, 6, 26, 36, true) },
  { pts: loops(48, 196, 5, 5, 9, 11) },
  { pts: loops(250, 196, 4, 6.5, 11, 30) },
  { pts: dense([[40, 256], [96, 256], [96, 312], [40, 312], [40, 256]]) },
  { pts: dense([[130, 312], [162, 256], [194, 312], [130, 312]]) },
  { pts: star(262, 286, 32) },
  { pts: dense([[330, 312], [330, 256], [372, 312], [372, 256]]) },
  { pts: dense([[410, 256], [454, 256], [410, 312], [454, 312]]) },
  { pts: spiral(84, 392, 3, 36) },
  { pts: wave(160, 770, 392, 24, 9) },
];
const ROWS: { y: number; label: string }[] = [
  { y: 92, label: 'arches and points' }, { y: 196, label: 'loops' }, { y: 312, label: 'corners' }, { y: 420, label: 'curves, faster and faster' },
];

/**
 * When a hand would pass each point of a guide (ms from its start): slower where it bends (the
 * two-thirds power law, v ∝ curvature^-⅓), at most 700 px a second, slowing smoothly into corners.
 */
function timing(pts: Pt[]): number[] {
  const n = pts.length, k = 3;
  const v = pts.map((_, i) => {
    const a = pts[Math.max(0, i - k)], b = pts[i], c = pts[Math.min(n - 1, i + k)];
    const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let turn = Math.abs(a2 - a1); if (turn > Math.PI) turn = 2 * Math.PI - turn;
    const kappa = i < k || i > n - 1 - k ? 0 : turn / (2 * k);
    return Math.max(70, Math.min(700, 116 * Math.max(kappa, 1e-4) ** (-1 / 3)));
  });
  const sv = v.map((_, i) => { let s = 0, m = 0; for (let j = Math.max(0, i - 8); j <= Math.min(n - 1, i + 8); j++) { s += 1 / v[j]; m++; } return m / s; });
  const t = [0];
  for (let i = 1; i < n; i++) t.push(t[i - 1] + (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) / sv[i]) * 1000);
  return t;
}
const PAUSE_MS = 280;
const TIMED = (() => {
  let at = 400;
  return GUIDES.map(g => { const t = timing(g.pts); const start = at; at += t[t.length - 1] + PAUSE_MS; return { pts: g.pts, t, start }; });
})();
const PLAY_MS = TIMED[TIMED.length - 1].start + TIMED[TIMED.length - 1].t[TIMED[TIMED.length - 1].t.length - 1];

const pathOf = (pts: Pt[], end = pts.length) => {
  let d = '';
  for (let i = 0; i < end; i++) d += (i ? 'L' : 'M') + pts[i][0].toFixed(1) + ' ' + pts[i][1].toFixed(1);
  return d;
};

/* -------------------------------------------------------------------------------- the pen's strokes */

/** a stroke on the paper: its points (paper px) as the pen gave them, and what it says of the pen */
interface Trace {
  pts: FreePt[];
  /** it was pressed harder and lighter (a pen; a trackpad that tells, pressure.ts) */
  pressure: boolean;
  kind: string;
  /** the pointer's type and its first point's pressure */
  type: string; p0: number;
  /** every position in whole px */
  whole: boolean;
  /** events (each time stamp once) and the time they took (ms); the most points one move carried */
  events: number; first: number; last: number; perMove: number;
}

/** what the strokes tell of the pen (those of a pen, if any) */
function measure(traces: Trace[]) {
  const pens = traces.filter(t => t.pressure);
  const use = pens.length ? pens : traces;
  if (!use.length) return null;
  const rates = use.filter(t => t.events >= 12 && t.last > t.first).map(t => ((t.events - 1) * 1000) / (t.last - t.first)).sort((a, b) => a - b);
  const press = pens.flatMap(t => t.pts.slice(3, -3).map(p => p[2]).filter(p => p > 0)).sort((a, b) => a - b);
  const q = (f: number) => press[Math.min(press.length - 1, Math.floor(f * press.length))];
  return {
    kind: use[use.length - 1].kind,
    rate: rates.length ? Math.round(rates[rates.length >> 1] / 10) * 10 : null,
    whole: use.every(t => t.whole),
    coalesced: Math.max(...use.map(t => t.perMove)) > 1,
    pressure: press.length >= 30 ? { lo: q(0.05), hi: q(0.95) } : null,
    usual: usualPressure(pens.map(t => t.pts)),
  };
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

/**
 * A guide as a pen would give it — its points at `rate` a second, in whole px where the pen gives
 * those —, placed on the paper by `at`, so that it is drawn as the hand's strokes are. Its pressure:
 * the usual one, a little more on the way down and less on the way up, light as it touches down and
 * lifts. `t`: when each point came (ms from its start).
 */
function asPenGives(g: { pts: Pt[]; t: number[] }, rate: number, whole: boolean, at: (p: Pt) => Pt, usual: number): { pts: FreePt[]; t: number[] } {
  const T = g.t[g.t.length - 1], n = Math.max(2, Math.ceil((T * rate) / 1000));
  const pts: FreePt[] = [], t: number[] = [];
  let j = 1;
  for (let k = 0; k <= n; k++) {
    const tau = Math.min(T, (k * 1000) / rate);
    while (j < g.t.length - 1 && g.t[j] < tau) j++;
    const a = g.pts[j - 1], b = g.pts[j], f = g.t[j] > g.t[j - 1] ? Math.min(1, (tau - g.t[j - 1]) / (g.t[j] - g.t[j - 1])) : 1;
    let [x, y] = at([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    if (whole) { x = Math.round(x); y = Math.round(y); }
    const down = (b[1] - a[1]) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1), ramp = Math.max(0, Math.min(1, tau / 60, (T - tau) / 60));
    pts.push([x, y, Math.max(0.03, (usual + 0.1 * down) * (0.35 + 0.65 * ramp))]);
    t.push(tau);
  }
  return { pts, t };
}

/** the pen's widths a width can be set to (px of a 1280 px slide, as on the slide at 100 %): the width picker's range */
const W_LO = DECK_INK_WIDTH_CHOICES.pen[0], W_HI = DECK_INK_WIDTH_CHOICES.pen[DECK_INK_WIDTH_CHOICES.pen.length - 1];

/** the pen's width in points: a slider finer at the thin end, in quarter points, the pen's three presets its rungs */
function WidthSlider({ px, presets, onChange }: { px: number; presets: number[]; onChange: (px: number) => void }) {
  const pos = (v: number) => (Math.log(v / W_LO) / Math.log(W_HI / W_LO)) * 1000;
  const val = (p: number) => W_LO * (W_HI / W_LO) ** (p / 1000);
  const snap = (v: number) => presets.find(w => Math.abs(Math.log(w / v)) < 0.05) ?? Math.round(ptToPx(Math.max(0.25, Math.round(pxToPt(v) * 4) / 4)) * 1000) / 1000;
  const label = (v: number) => `${fmtPt(pxToPt(v))} pt`;
  return (
    <div class="pen-set-row" data-pen-cal-width title="The pen's width, as on a slide at 100 %. Save puts it in place of the width preset in use">
      <span class="pen-set-name">Width<span class="pen-set-val">{label(px)}</span></span>
      <input type="range" class="ink-pick-range" min={0} max={1000} step={1} value={Math.round(pos(px))} aria-label="Width" aria-valuetext={label(px)}
        onInput={e => onChange(snap(val(Number((e.target as HTMLInputElement).value))))} />
      <div class="ff-rungs pen-set-rungs">
        {[...new Set(presets)].map(w => (
          <button key={w} type="button" class={'ff-rung' + (Math.abs(w - px) < 1e-3 ? ' on' : '')} style={rungStyle(pos(w) / 10)} title={`One of the pen's widths: ${label(w)}`}
            onMouseDown={e => e.preventDefault()} onClick={() => onChange(w)}><span>{label(w)}</span></button>
        ))}
      </div>
    </div>
  );
}

/** the dots of the points a stroke was given (and a hairline through them) */
const dotsD = (pts: FreePt[]) => pts.map(([x, y]) => `M${x.toFixed(2)} ${y.toFixed(2)}h0.01`).join('');

/* -------------------------------------------------------------------------------- the page */

function PenCalibration({ onClose }: { onClose: () => void }) {
  const saved = useMemo(() => loadDeckInk(), []);
  const pen = saved.pens.pen;
  const [nib, setNib] = useState<Nib>(saved.nib);
  const [width, setWidth] = useState(pen.width);
  /** the usual pressure follows what is measured until set by hand */
  const [usualByHand, setUsualByHand] = useState(false);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [showPts, setShowPts] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [played, setPlayed] = useState(0);
  const [now, setNow] = useState(0);
  const [, setFrame] = useState(0);
  const paper = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const live = useRef<(Trace & { id: number; lastT: number }) | null>(null);
  const pencilSeen = useRef(saved.pencil && !saved.fingersDraw);
  const root = useRef<HTMLDivElement>(null);

  // the paper's size (the guides fitted to it)
  useEffect(() => {
    const el = paper.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the guides drawn as a hand draws them (again on Replay)
  useEffect(() => {
    const t0 = performance.now();
    let raf = 0;
    const tick = () => { const t = performance.now() - t0; setNow(t); if (t < PLAY_MS) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [played]);
  // (a force click while drawing: no Look Up)
  useEffect(() => watchForce(() => live.current !== null), []);
  // Esc: away without saving; the editor behind hears no keys meanwhile
  useEffect(() => {
    root.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      e.stopPropagation();
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, [onClose]);

  const facts = useMemo(() => measure(traces), [traces]);
  const hz = useFrameRate();
  // the pressure the hand writes with: drawn at the pen's width
  useEffect(() => { if (!usualByHand && facts?.usual != null && facts.usual !== nib.usual) setNib(n => ({ ...n, usual: facts.usual! })); }, [facts?.usual, usualByHand]);

  const shown = comparing ? saved.nib : nib, shownW = comparing ? pen.width : width;
  const runsOf = (pts: FreePt[], pressure: boolean, whole: boolean, final: boolean) =>
    inkPaths(inkRuns(pts, { width: shownW, pressure, zoom: 1, coarse: whole && pts.length > 4 ? 1 : false, nib: pressure ? { ...shown, lift: true } : shown, final }));
  const drawn = useMemo(() => traces.map(t => runsOf(t.pts, t.pressure, t.whole, true)), [traces, shown, shownW]);

  // where the guides sit: centred at the top, as large as they are where there is room
  const fit = Math.min(1, (size.w - 24) / BOX.w, (size.h - 24) / BOX.h);
  const gs = fit > 0 ? fit : 1;
  const ox = Math.max(12, (size.w - BOX.w * gs) / 2), oy = Math.max(12, Math.min((size.h - BOX.h * gs) / 2, 28));
  // below the guides, lines to write anything on, as far as the paper goes
  const rows = [...ROWS];
  for (let y = ROWS[ROWS.length - 1].y + 110; oy + (y + 20) * gs < size.h; y += 90) rows.push({ y, label: rows.length === ROWS.length ? 'your own writing' : '' });
  // the guides as this pen gives its strokes (until it has drawn: the Pencil's 240 a second, finer than a px)
  const rate = Math.max(30, Math.min(480, facts?.rate ?? 240)), givesWhole = facts?.whole ?? false;
  const demo = useMemo(() => TIMED.map(g => ({ start: g.start, ...asPenGives(g, rate, givesWhole, p => [ox + p[0] * gs, oy + p[1] * gs], nib.usual) })), [rate, givesWhole, ox, oy, gs, nib.usual]);
  const demoDone = useMemo(() => demo.map(d => runsOf(d.pts, true, givesWhole, true)), [demo, shown, shownW]);
  // how many of each guide's points are drawn by now; the one being drawn
  const shownTo = demo.map(d => {
    const t = now - d.start;
    if (t <= 0) return 0;
    if (t >= d.t[d.t.length - 1]) return d.pts.length;
    let end = 1;
    while (end < d.pts.length && d.t[end] <= t) end++;
    return end;
  });
  const drawingGuide = shownTo.findIndex((e, i) => e > 0 && e < demo[i].pts.length);

  const local = (e: PointerEvent): FreePt => {
    const r = paper.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top, pointPressure(e)];
  };
  const whole = (e: PointerEvent) => Number.isInteger(e.clientX) && Number.isInteger(e.clientY);
  const kindOf = (e: PointerEvent) => (e.pointerType === 'pen' ? 'a pen' : e.pointerType === 'touch' ? 'a finger' : 'the mouse or trackpad');

  const down = (e: PointerEvent) => {
    if (e.button > 0 || live.current) return;
    if (e.pointerType === 'pen') pencilSeen.current = true;
    // the hand resting on the glass while the pen writes: not a stroke
    else if (e.pointerType === 'touch' && pencilSeen.current) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const first = local(e);
    live.current = { id: e.pointerId, pts: [first], pressure: e.pointerType === 'pen', kind: kindOf(e), type: e.pointerType, p0: first[2], whole: whole(e), events: 1, first: e.timeStamp, last: e.timeStamp, perMove: 1, lastT: e.timeStamp };
    setFrame(f => f + 1);
  };
  const move = (e: PointerEvent) => {
    const l = live.current;
    if (!l || e.pointerId !== l.id) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents?.() ?? [];
    l.perMove = Math.max(l.perMove, evs.length);
    for (const ev of evs.length ? evs : [e]) {
      if (ev.timeStamp > l.last) { l.events++; l.last = ev.timeStamp; }
      const p = local(ev);
      if (!freshPoint(l.pts, l.lastT, ev.timeStamp, p)) continue;
      l.lastT = ev.timeStamp;
      l.whole &&= whole(ev);
      l.pts.push(p);
      if (!l.pressure && pressed(l.type, l.p0, p[2])) { l.pressure = true; l.kind = 'the trackpad (Force Touch)'; }
    }
    requestAnimationFrame(() => setFrame(f => f + 1));
  };
  const up = (e: PointerEvent) => {
    const l = live.current;
    if (!l || e.pointerId !== l.id) return;
    live.current = null;
    const { id: _id, lastT: _t, ...t } = l;
    if (e.type !== 'pointercancel' || t.pts.length > 3) setTraces(ts => [...ts, t]);
    else setFrame(f => f + 1);
  };

  const save = () => {
    // the width in place of the preset in use (as clicking the selected width again does); the pen in hand stays
    const cur = loadDeckInk(), p = cur.pens.pen, idx = p.widths.indexOf(p.width);
    const w: DeckInkPatch = width === p.width ? {} : p.widths.includes(width) || idx < 0 ? { width } : { slotWidth: { idx, width } };
    saveDeckInk({ ...patchDeckInk(cur, { pen: 'pen', nib, ...w }), pen: cur.pen });
    onClose();
  };
  const changed = width !== pen.width || (Object.keys(nib) as (keyof Nib)[]).some(k => nib[k] !== saved.nib[k]);
  const l = live.current;

  return (
    <div class="pen-cal" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Pen calibration" data-pen-calibration>
      <div class="pen-cal-head">
        <div class="pen-cal-titles">
          <div class="pen-cal-title">Pen calibration</div>
          <div class="pen-cal-sub">Trace the pale strokes as they are drawn, or write anything. Change the settings: your strokes and the pale ones are redrawn with them.</div>
        </div>
        <button type="button" class="btn" data-pen-cal-replay onClick={() => setPlayed(p => p + 1)}>Replay</button>
        <button type="button" class="btn" data-pen-cal-undo disabled={!traces.length} onClick={() => setTraces(ts => ts.slice(0, -1))}>Undo</button>
        <button type="button" class="btn" data-pen-cal-clear disabled={!traces.length} onClick={() => setTraces([])}>Clear</button>
        <span class="pen-cal-gap" />
        <button type="button" class="btn" data-pen-cal-cancel onClick={onClose}>Cancel</button>
        <button type="button" class="btn primary" data-pen-cal-save onClick={save} title={changed ? 'Keep these settings for this browser\'s pen' : 'Nothing changed yet'}>Save</button>
      </div>
      <div class="pen-cal-paper" ref={paper} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <svg aria-hidden="true">
          <g transform={`translate(${ox} ${oy}) scale(${gs})`}>
            {rows.map(r => <line key={r.y} class="pen-cal-rule" x1={20} x2={BOX.w - 10} y1={r.y} y2={r.y} />)}
            {rows.map(r => r.label && <text key={'t' + r.y} class="pen-cal-label" x={BOX.w - 10} y={r.y + 16} text-anchor="end">{r.label}</text>)}
          </g>
          {/* (the guides faint, as one: where two runs meet they would darken each other) */}
          <g class="pen-cal-guide" fill="none" stroke={pen.color} stroke-linecap="round" stroke-linejoin="round">
            {demo.map((d, i) => !shownTo[i] ? null : (shownTo[i] === d.pts.length ? demoDone[i] : runsOf(d.pts.slice(0, shownTo[i]), true, givesWhole, false))
              .map(p => <path key={i + ':' + p.w} stroke-width={p.w} d={p.d} />))}
          </g>
          {drawingGuide >= 0 && <circle class="pen-cal-tip" cx={demo[drawingGuide].pts[shownTo[drawingGuide] - 1][0]} cy={demo[drawingGuide].pts[shownTo[drawingGuide] - 1][1]} r={5} />}
          <g fill="none" stroke={pen.color} stroke-linecap="round" stroke-linejoin="round">
            {drawn.map((paths, i) => paths.map(p => <path key={i + ':' + p.w} stroke-width={p.w} d={p.d} />))}
            {l && runsOf(l.pts, l.pressure, l.whole, false).map(p => <path key={'l' + p.w} stroke-width={p.w} d={p.d} />)}
          </g>
          {showPts && (
            <g class="pen-cal-pts">
              {[...traces, ...(l ? [l] : [])].map((t, i) => (
                <g key={i}>
                  <path class="pen-cal-raw" d={pathOf(t.pts.map(p => [p[0], p[1]] as Pt))} />
                  <path class="pen-cal-dot" d={dotsD(t.pts)} />
                </g>
              ))}
            </g>
          )}
        </svg>
      </div>
      <div class="pen-cal-side">
        <WidthSlider px={width} presets={pen.widths} onChange={setWidth} />
        <NibLevels nib={nib} wide onChange={p => { if (p.usual !== undefined) setUsualByHand(true); setNib(n => ({ ...n, ...p })); }} measuredUsual={facts?.usual ?? null} />
        <label class="pen-set-check">
          <input type="checkbox" checked={showPts} data-pen-cal-points onChange={e => setShowPts((e.target as HTMLInputElement).checked)} /> Show the points the pen gave
        </label>
        <button type="button" class={'btn pen-cal-compare' + (comparing ? ' on' : '')} data-pen-cal-compare disabled={!traces.length}
          onPointerDown={e => { e.preventDefault(); setComparing(true); }} onPointerUp={() => setComparing(false)} onPointerLeave={() => setComparing(false)} onPointerCancel={() => setComparing(false)}
          onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') setComparing(true); }} onKeyUp={() => setComparing(false)}>
          {comparing ? 'Showing the saved settings' : 'Hold to compare with the saved settings'}
        </button>
        <div class="pen-cal-facts" data-pen-cal-facts>
          {!facts ? <span>Draw a few strokes and the pen is measured here.</span> : (
            <>
              <div><b>Drawn with {facts.kind}</b>{facts.rate ? ` · ${facts.rate} points a second` : ''}{facts.coalesced ? '' : ' (this browser gives no in-between points)'}</div>
              <div>{facts.whole ? 'Positions to the whole screen pixel: this browser rounds them. Rounding smooths the steps away; at 0 they show.' : 'Positions finer than a screen pixel: rounding makes little difference except on fast strokes.'}</div>
              <div>The pale strokes are drawn as this pen gives its points.</div>
              {facts.pressure && <div>Pressure {pct(facts.pressure.lo)} – {pct(facts.pressure.hi)}{facts.usual != null ? `, usually ${pct(facts.usual)}` : ''}.</div>}
              {!facts.pressure && facts.kind === 'the mouse or trackpad' && <div>No pressure came with it. A Mac's Force Touch trackpad tells it when you press to click and draw with the click held (not with tap to click or three-finger drag); Safari passes it on, other browsers may not.</div>}
            </>
          )}
          {hz && <div data-pen-cal-hz>The screen shows the page {hz} times a second.{hz < 75 && appleTablet() ? ` An iPad Pro can show it 120 times, and the line follows the pen sooner: only you can switch that on. ${HZ120_STEPS}` : ''}</div>}
        </div>
        <div class="pen-cal-foot">
          <button type="button" class="pen-set-reset" data-pen-cal-reset onClick={() => { setUsualByHand(false); setWidth(pen.width); setNib({ ...DEFAULT_NIB, usual: facts?.usual ?? DEFAULT_NIB.usual }); }}>Reset to defaults</button>
        </div>
      </div>
    </div>
  );
}

let open: HTMLElement | null = null;

/** the calibration page over everything (one at a time) */
export function openPenCalibration(): void {
  if (open) return;
  const host = document.createElement('div');
  document.body.append(host);
  open = host;
  const close = () => { render(null, host); host.remove(); open = null; };
  render(<PenCalibration onClose={close} />, host);
}

/**
 * How often the screen shows the page (its frames a second, from a second of them): Safari on an iPad
 * Pro holds pages to 60 unless a feature flag is turned off — half as often as the screen could, which
 * puts the line a frame further behind the pen.
 */
function useFrameRate(): number | null {
  const [hz, setHz] = useState<number | null>(null);
  useEffect(() => {
    const ts: number[] = [];
    let raf = 0;
    const tick = (t: number) => {
      ts.push(t);
      if (ts.length < 61) { raf = requestAnimationFrame(tick); return; }
      const d = ts.slice(1).map((v, i) => v - ts[i]).sort((a, b) => a - b)[30];
      if (d > 0) setHz(Math.round(1000 / d / 10) * 10 || Math.round(1000 / d));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return hz;
}

