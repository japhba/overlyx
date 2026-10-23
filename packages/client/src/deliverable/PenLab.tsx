/**
 * The pen lab (the pen's settings ▸ Find your ink…, the calibration's Find your ink…, or the address
 * with `?penlab`): you write a few lines once, and then see them drawn two ways at a time and say which
 * looks better — much better, about the same, horrible — until the ink you like is found. The pen's
 * settings it moves through (core inklab.ts) go further than the settings' sliders: how far the
 * pressure is smoothed, where the line breaks off and thins as the pen lifts, as well as the pressure,
 * pointed ends, a flat nib, smoothing and rounding.
 *
 * What to show next is worked out from all answers so far (core prefgp.ts: a Gaussian process of how
 * much each setting is liked): first a few kinds of pen against the best so far — a gel pen, fountain
 * pens, a brush pen, a flat nib, a smoothed line, the line as drawn —, so that a taste far from the
 * first is found too; then the best so far against what may well beat it, now and then a region liked
 * less polished on its own, and now and then a guess further off. The sides are drawn at random (the
 * model counts a lean towards one), two that would look alike are not shown, and twice an earlier
 * pair comes again the other way round (how consistent the answers are). At the end, the settings
 * liked best — as many as are liked about as much and differ — each to take as the pen's.
 *
 * Kept in this browser (`ol.penLab`); the answers (and, if ticked, the writing) can be sent to OverLyX,
 * where curators' answers become what everyone is asked first, and what they found horrible is left
 * out of everyone's questions (inklab.ts CURATED).
 */
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PrefModel, nextPair, favourites, regions, spread, around, seeded, HORRIBLE, type Answer, type Setting } from '@overlyx/core/prefgp.ts';
import { LAB_DIMS, LAB_KINDS, LAB_VERSION, labNib, labSetting, describe, curatedPrior } from '@overlyx/core/inklab.ts';
import { api } from '../api';
import { freshPoint, inkPaths, inkRuns, type FreePt, type InkCache, type NibOpts } from './runtime/freehand';
import { loadDeckInk, patchDeckInk, saveDeckInk } from './deckink';
import { pointPressure, watchForce } from './runtime/pressure';

/* -------------------------------------------------------------------------------- what is kept */

/** a stroke of the sample: its points (pad px), when each came (ms from the sample's first), the pen's tilt (°, x and y, if it told) */
interface LabStroke { pts: FreePt[]; t: number[]; tilt?: number[]; pressure: boolean; whole: boolean }
interface Sample { strokes: LabStroke[]; type: string }
/** an answer as given: which kind of pen B was (the first questions), how long it took, whether it was an earlier pair again */
interface LabAnswer extends Answer { kind?: string; ms: number; at: number; again?: boolean; score?: number }
interface Lab { version: number; seed: number; sample: Sample | null; start: Setting; answers: LabAnswer[]; sent?: number }

const KEY = 'ol.penLab';

function freshLab(sample: Sample | null = null): Lab {
  return { version: LAB_VERSION, seed: Math.floor(Math.random() * 1e9), sample, start: labSetting(loadDeckInk().nib), answers: [] };
}
function loadLab(): Lab {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Lab | null;
    if (s && s.version === LAB_VERSION && Array.isArray(s.answers) && Array.isArray(s.start) && s.start.length === LAB_DIMS.length) return s;
  } catch { /* private window */ }
  return freshLab();
}
function saveLab(lab: Lab): void {
  try { localStorage.setItem(KEY, JSON.stringify(lab)); } catch { /* private window, or full: the session is lost on reload */ }
}

/* -------------------------------------------------------------------------------- the questions */

/** after this many answers the lab says it has probably found the ink (and keeps going if asked) */
const ENOUGH = 24;
/** earlier pairs asked again, the other way round, after this many questions past the kinds */
const AGAIN_AT = [8, 20];

/** the kinds of pen in the order this session asks about them */
const kindOrder = (seed: number) => { const r = seeded(seed), idx = LAB_KINDS.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } return idx.map(i => LAB_KINDS[i]); };

interface Question { a: Setting; b: Setting; top: 0 | 1; kind?: string; again?: boolean; score?: number }

/** the model of the answers so far (the curators' taste expected before them) */
function modelOf(answers: Answer[], prior: ReturnType<typeof curatedPrior>): PrefModel {
  const m = new PrefModel(LAB_DIMS.length, prior ? { prior: prior.prior } : {});
  for (const a of answers) m.add(a);
  m.fit(true);
  return m;
}

/**
 * What to ask next: a kind of pen against the best so far (the user's own pen to begin with), an
 * earlier pair again, or what the model says — never two that would look alike (`alike`).
 */
function nextQuestion(lab: Lab, model: PrefModel, prior: ReturnType<typeof curatedPrior>, alike: (a: Setting, b: Setting) => boolean): Question {
  const n = lab.answers.length, rand = seeded(lab.seed * 7919 + n * 104729);
  const top: 0 | 1 = rand() < 0.5 ? 0 : 1;
  const inc = model.answers ? model.pts[model.incumbent()] : lab.start;
  const kinds = kindOrder(lab.seed);
  // (the kinds: each in turn — one alike to the best so far skipped)
  const askedKinds = new Set(lab.answers.map(a => a.kind).filter(Boolean));
  if (askedKinds.size < kinds.length && n < kinds.length + 2) {
    for (const k of kinds) if (!askedKinds.has(k.name) && !alike(inc, k.x)) return { a: inc, b: k.x, top, kind: k.name };
  }
  const past = n - Math.min(n, kinds.length);
  if (AGAIN_AT.includes(past)) {
    const same = (x: Setting, y: Setting) => model.distance(x, y) < 1e-6;
    const was = lab.answers.find((a, i) => i >= 2 && !a.again && a.grade !== 0 && !(a.badA && a.badB) && !lab.answers.some(b => b.again && same(b.a, a.b) && same(b.b, a.a)));
    if (was) return { a: was.b, b: was.a, top: was.top === 0 ? 0 : 1, again: true };
  }
  // the pool: settings spread over the whole range, around the best ones, around the best of each region — none horrible to a curator, none near what was horrible here
  const bad = [...model.bad].map(i => model.pts[i]);
  const ranked = model.pts.map((x, i) => ({ x, v: model.values[i] ?? 0 })).filter((_, i) => !model.bad.has(i)).sort((p, q) => q.v - p.v);
  const pool = [
    ...spread(LAB_DIMS.length, 700, 20 + (lab.seed % 5000), 0.03),
    ...ranked.slice(0, 5).flatMap(t => [...around(t.x, 40, 0.1, rand), ...around(t.x, 30, 0.03, rand)]),
    ...regions(model).slice(1, 3).flatMap(r => around(model.pts[r.best], 30, 0.06, rand)),
    ...LAB_KINDS.map(k => k.x),
  ].filter(x => !prior?.veto(x) && bad.every(b => model.distance(x, b) > 0.15));
  const mode = past % 4;
  let left = pool;
  for (let tries = 0; tries < 4 && left.length; tries++) {
    const p = nextPair(model, left, { draw: mode === 3 || tries === 3, region: mode === 1 ? (past % 8 === 5 ? 2 : 1) : 0, rand });
    if (!alike(p.a, p.b)) return { a: p.a, b: p.b, top, score: p.score };
    left = left.filter(x => model.distance(x, p.b) > 0.15);
  }
  return { a: inc, b: kinds[n % kinds.length].x, top };
}

/* -------------------------------------------------------------------------------- drawing the sample */

/** the sample's strokes drawn with a setting: paths for each stroke */
function drawSample(sample: Sample, nib: NibOpts, width: number): { w: number; d: string }[][] {
  return sample.strokes.map(s => inkPaths(inkRuns(s.pts, { width, pressure: s.pressure, zoom: 1, coarse: s.whole && s.pts.length > 4 ? 1 : false, nib, final: true })));
}

/** the box the sample's points take (pad px), with room for the ink */
function sampleBox(sample: Sample, width: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of sample.strokes) for (const [x, y] of s.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const m = width * 2 + 6;
  return x0 === Infinity ? { x: 0, y: 0, w: 1, h: 1 } : { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
}

/**
 * Whether two settings would look alike on the sample: drawn on a canvas, the ink of each
 * differs in less than ALIKE of where either has ink (a pair hardly anyone can tell apart wastes a
 * question; Koyama's sliders have a least length for the same reason).
 */
const ALIKE = 0.05;
function alikeOn(sample: Sample, width: number): (a: Setting, b: Setting) => boolean {
  const box = sampleBox(sample, width);
  // (at about the screen's own resolution: a difference seen on a Retina screen is not blurred away)
  const k = Math.min(2, 900 / box.w);
  const W = Math.max(8, Math.ceil(box.w * k)), H = Math.max(8, Math.ceil(box.h * k));
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const raster = (x: Setting) => {
    ctx!.clearRect(0, 0, W, H);
    ctx!.setTransform(k, 0, 0, k, -box.x * k, -box.y * k);
    ctx!.lineCap = ctx!.lineJoin = 'round';
    for (const paths of drawSample(sample, labNib(x), width)) for (const p of paths) { ctx!.lineWidth = p.w; ctx!.stroke(new Path2D(p.d)); }
    ctx!.setTransform(1, 0, 0, 1, 0, 0);
    return ctx!.getImageData(0, 0, W, H).data;
  };
  return (a, b) => {
    if (!ctx) return false;
    const ia = raster(a), ib = raster(b);
    let diff = 0, ink = 0;
    for (let i = 3; i < ia.length; i += 4) { diff += Math.abs(ia[i] - ib[i]); ink += Math.max(ia[i], ib[i]); }
    return ink > 0 && diff / ink < ALIKE;
  };
}

/** one way of drawing the sample, in its box; `upTo` (ms): the sample as written by then — the stroke being written as the pen draws it while writing */
function Drawn({ sample, x, width, color, upTo, label }: { sample: Sample; x: Setting; width: number; color: string; upTo?: number | null; label?: string }) {
  const nib = useMemo(() => labNib(x), [x]);
  const done = useMemo(() => drawSample(sample, nib, width), [sample, nib, width]);
  const box = useMemo(() => sampleBox(sample, width), [sample, width]);
  const live = useRef<{ i: number; cache: InkCache } | null>(null);
  let paths = done;
  if (upTo != null) {
    paths = [];
    sample.strokes.forEach((s, i) => {
      if (!s.t.length || s.t[0] > upTo) return;
      if (s.t[s.t.length - 1] <= upTo) { paths.push(done[i]); return; }
      let k = 1;
      while (k < s.pts.length && s.t[k] <= upTo) k++;
      if (live.current?.i !== i) live.current = { i, cache: {} };
      paths.push(inkPaths(inkRuns(s.pts.slice(0, k), { width, pressure: s.pressure, zoom: 1, coarse: s.whole && k > 4 ? 1 : false, nib, final: false, cache: live.current.cache })));
    });
  }
  return (
    <svg class="pen-lab-ink" viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} style={{ maxWidth: `${box.w}px`, aspectRatio: `${box.w} / ${box.h}` }} aria-label={label} role="img">
      <g fill="none" stroke={color} stroke-linecap="round" stroke-linejoin="round">
        {paths.map((ps, i) => ps.map(p => <path key={i + ':' + p.w} stroke-width={p.w} d={p.d} />))}
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------------- writing the sample */

function WritePad({ initial, onDone, onCancel }: { initial: Sample | null; onDone: (s: Sample) => void; onCancel: () => void }) {
  const [strokes, setStrokes] = useState<LabStroke[]>(initial?.strokes ?? []);
  const [, setFrame] = useState(0);
  const pad = useRef<HTMLDivElement>(null);
  const live = useRef<(LabStroke & { id: number; lastT: number }) | null>(null);
  const t0 = useRef<number | null>(null);
  const type = useRef(initial?.type ?? '');
  const pencil = useRef(initial?.type === 'pen');
  const ink = useMemo(() => loadDeckInk().pens.pen, []);
  useEffect(() => watchForce(() => live.current !== null), []);

  const local = (e: PointerEvent): FreePt => { const r = pad.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, pointPressure(e)]; };
  const whole = (e: PointerEvent) => Number.isInteger(e.clientX) && Number.isInteger(e.clientY);
  const down = (e: PointerEvent) => {
    if (e.button > 0 || live.current) return;
    if (e.pointerType === 'pen') pencil.current = true;
    // (the hand resting on the glass while the pen writes)
    else if (e.pointerType === 'touch' && pencil.current) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (t0.current === null) t0.current = e.timeStamp - (strokes.length ? strokes[strokes.length - 1].t.slice(-1)[0] + 400 : 0);
    type.current = e.pointerType;
    live.current = { id: e.pointerId, pts: [local(e)], t: [Math.round(e.timeStamp - t0.current)], tilt: [e.tiltX || 0, e.tiltY || 0], pressure: e.pointerType === 'pen', whole: whole(e), lastT: e.timeStamp };
    setFrame(f => f + 1);
  };
  const move = (e: PointerEvent) => {
    const l = live.current;
    if (!l || e.pointerId !== l.id) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents?.() ?? [];
    for (const ev of evs.length ? evs : [e]) {
      const p = local(ev);
      if (!freshPoint(l.pts, l.lastT, ev.timeStamp, p)) continue;
      l.lastT = ev.timeStamp;
      l.whole &&= whole(ev);
      l.pts.push(p); l.t.push(Math.round(ev.timeStamp - t0.current!)); l.tilt!.push(ev.tiltX || 0, ev.tiltY || 0);
    }
    requestAnimationFrame(() => setFrame(f => f + 1));
  };
  const up = (e: PointerEvent) => {
    const l = live.current;
    if (!l || e.pointerId !== l.id) return;
    live.current = null;
    const { id: _id, lastT: _t, ...s } = l;
    if (e.type !== 'pointercancel' || s.pts.length > 3) setStrokes(ss => [...ss, s]);
    else setFrame(f => f + 1);
  };
  const shown = live.current ? [...strokes, live.current] : strokes;
  const points = strokes.reduce((n, s) => n + s.pts.length, 0);
  const pressured = strokes.some(s => s.pressure);
  const ready = strokes.length >= 3 && points >= 80;
  const nib: NibOpts = { ...loadDeckInk().nib, lift: true };
  return (
    <div class="pen-lab-write">
      <div class="pen-lab-note">
        Write a line or two as you usually would — a few words, a formula, a quick sketch. Every comparison redraws exactly this, two ways.
        {strokes.length > 0 && !pressured && ' (No pressure came with these strokes: the comparisons are about the line\'s shape and smoothing then. A pen gives more.)'}
      </div>
      <div class="pen-lab-pad" ref={pad} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <svg aria-hidden="true">
          {[1, 2, 3, 4, 5].map(i => <line key={i} class="pen-cal-rule" x1={16} x2="98%" y1={i * 64} y2={i * 64} />)}
          <g fill="none" stroke={ink.color} stroke-linecap="round" stroke-linejoin="round">
            {shown.map((s, i) => inkPaths(inkRuns(s.pts, { width: ink.width, pressure: s.pressure, zoom: 1, coarse: s.whole && s.pts.length > 4 ? 1 : false, nib: s.pressure ? nib : loadDeckInk().nib, final: s !== live.current }))
              .map(p => <path key={i + ':' + p.w} stroke-width={p.w} d={p.d} />))}
          </g>
        </svg>
      </div>
      <div class="pen-lab-bar">
        <button type="button" class="btn" disabled={!strokes.length} onClick={() => setStrokes(ss => ss.slice(0, -1))}>Undo</button>
        <button type="button" class="btn" disabled={!strokes.length} onClick={() => { setStrokes([]); t0.current = null; }}>Clear</button>
        <span class="pen-cal-gap" />
        {initial && <button type="button" class="btn" onClick={onCancel}>Keep the old sample</button>}
        <button type="button" class="btn primary" data-pen-lab-start disabled={!ready} title={ready ? '' : 'A few more strokes first'}
          onClick={() => onDone({ strokes, type: type.current || (pressured ? 'pen' : 'mouse') })}>Compare inks</button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------------- the page */

const GRADES: { g: -2 | -1 | 0 | 1 | 2; label: string; key: string }[] = [
  { g: 2, label: 'A much better', key: '1' }, { g: 1, label: 'A better', key: '2' }, { g: 0, label: 'About the same', key: '3' }, { g: -1, label: 'B better', key: '4' }, { g: -2, label: 'B much better', key: '5' },
];

function PenLab({ onClose, sample: given }: { onClose: () => void; sample?: Sample | null }) {
  const [lab, setLab] = useState<Lab>(() => { const l = loadLab(); return !l.sample && given ? { ...l, sample: given } : l; });
  const [view, setView] = useState<'write' | 'compare' | 'results'>(() => (lab.sample ? 'compare' : 'write'));
  const [q, setQ] = useState<Question | null>(null);
  const [bad, setBad] = useState<[boolean, boolean]>([false, false]);
  const [held, setHeld] = useState<0 | 1 | null>(null);
  const [replay, setReplay] = useState<number | null>(null);
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [withSample, setWithSample] = useState(false);
  const shownAt = useRef(performance.now());
  const root = useRef<HTMLDivElement>(null);
  const deck = useMemo(() => loadDeckInk(), []);
  const [width, setWidth] = useState(deck.pens.pen.width);
  const color = deck.pens.pen.color;
  const prior = useMemo(() => curatedPrior(), []);
  // the model: an answer more taken in where the last left off (its length looked for again every fifth), else built afresh (an undo, a new session)
  const built = useRef<{ model: PrefModel; count: number } | null>(null);
  const model = useMemo(() => {
    const b = built.current, n = lab.answers.length;
    if (b && n === b.count + 1) { b.model.add(lab.answers[b.count]); b.model.fit(n % 5 === 0); b.count = n; return b.model; }
    const m = modelOf(lab.answers, prior);
    built.current = { model: m, count: n };
    return m;
  }, [lab.answers, prior]);
  const alike = useMemo(() => (lab.sample ? alikeOn(lab.sample, width) : () => false), [lab.sample, width]);

  useEffect(() => saveLab(lab), [lab]);
  // the next question, once the last answer is in
  useEffect(() => {
    if (view !== 'compare' || !lab.sample) return;
    setBusy(true);
    const t = setTimeout(() => {
      setQ(nextQuestion(lab, model, prior, alike));
      setBad([false, false]); setBusy(false); setReplay(null);
      shownAt.current = performance.now();
    }, 10);
    return () => clearTimeout(t);
  }, [lab.answers, view, lab.sample]);
  // Esc: away (the session is kept); the keys of the answers
  useEffect(() => {
    root.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (view === 'compare' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const g = GRADES.find(x => x.key === e.key);
        if (g) { e.preventDefault(); answer(g.g); }
        else if (e.key === 'a' || e.key === 'b') { e.preventDefault(); toggleBad(e.key === 'a' ? 0 : 1); }
        else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
      }
      e.stopPropagation();
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  });
  // the replay: the sample written again at the pace it was, both ways at once
  const duration = useMemo(() => Math.max(0, ...(lab.sample?.strokes.map(s => s.t[s.t.length - 1] ?? 0) ?? [0])), [lab.sample]);
  useEffect(() => {
    if (replay === null) return;
    const t0 = performance.now() - replay;
    let raf = 0;
    const tick = () => { const t = performance.now() - t0; if (t > duration + 300) { setReplay(null); return; } setReplay(t); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [replay === null]);

  // the panels: A on top (or on the left), the question's `top` its own setting
  const shown: [Setting, Setting] | null = q ? (q.top === 0 ? [q.a, q.b] : [q.b, q.a]) : null;
  const toggleBad = (i: 0 | 1) => setBad(b => (i === 0 ? [!b[0], b[1]] : [b[0], !b[1]]));
  const answer = (g: -2 | -1 | 0 | 1 | 2, both = false) => {
    if (!q || busy) return;
    // (the grade and the flags of the panels, said of A and B of the question)
    const flip = q.top === 1;
    const flags: [boolean, boolean] = both ? [true, true] : bad;
    const ans: LabAnswer = {
      a: q.a, b: q.b, grade: (flip ? -g : g) as Answer['grade'], top: q.top,
      ...(flags[flip ? 1 : 0] ? { badA: true } : {}), ...(flags[flip ? 0 : 1] ? { badB: true } : {}),
      ...(q.kind ? { kind: q.kind } : {}), ...(q.again ? { again: true } : {}), ...(q.score !== undefined ? { score: Math.round(q.score * 1000) / 1000 } : {}),
      ms: Math.round(performance.now() - shownAt.current), at: Date.now(),
    };
    setLab(l => ({ ...l, answers: [...l.answers, ans] }));
  };
  const undo = () => { if (lab.answers.length) setLab(l => ({ ...l, answers: l.answers.slice(0, -1) })); };

  const n = lab.answers.length;
  const inc = model.answers ? model.pts[model.incumbent()] : lab.start;
  // settled: enough answers, and the best has stayed the best for the last six
  // settled (the lab says so, and keeps going if asked): the best has been in each of the last six questions and stayed the best, or
  // little was left to find beside it the last three times (what the challengers were expected to add, EUBO)
  const last = lab.answers.slice(-6);
  const settled = n >= 16 && (n >= ENOUGH && last.every(a => model.distance(a.a, inc) < 1e-6 || model.distance(a.b, inc) < 1e-6)
    || (last.length >= 3 && last.slice(-3).every(a => a.score !== undefined && a.score < 0.08)));
  const favs = useMemo(() => (view === 'results' ? favourites(model, 3, 1) : []), [view, lab.answers]);
  // how consistent the answers were: the pairs asked again, answered the same way
  const agains = lab.answers.filter(a => a.again).map(a => {
    const was = lab.answers.find(b => !b.again && model.distance(b.a, a.b) < 1e-6 && model.distance(b.b, a.a) < 1e-6);
    return was ? Math.sign(was.grade) === -Math.sign(a.grade) : null;
  }).filter(v => v !== null);

  const use = (x: Setting) => {
    const nib = labNib(x), cur = loadDeckInk();
    saveDeckInk({ ...patchDeckInk(cur, { pen: 'pen', nib: { ball: false, sensitivity: nib.sensitivity, sharpness: nib.sharpness, flatness: nib.flatness, stabilization: nib.stabilization, rounding: nib.rounding, pressSmooth: nib.pressSmooth, liftLo: nib.liftLo, liftHi: nib.liftHi } }), pen: cur.pen });
    setStatus('Your pen draws with this ink now — on slides, whiteboards and in documents\' margins, in this browser.');
  };
  const send = async () => {
    setStatus('Sending…');
    const s = lab.sample;
    try {
      const r = await api.inkLab({
        version: LAB_VERSION, dims: LAB_DIMS.map(d => d.key), start: lab.start,
        answers: lab.answers.map(({ a, b, grade, badA, badB, top, kind, ms, again, score }) => ({ a, b, grade, ...(badA ? { badA } : {}), ...(badB ? { badB } : {}), top, ...(kind ? { kind } : {}), ms, ...(again ? { again } : {}), ...(score !== undefined ? { score } : {}) })),
        favourites: favourites(model, 3, 1).map(f => f.x), length: model.length, bias: model.bias,
        device: { type: s?.type ?? '', whole: !!s?.strokes.every(t => t.whole), pressure: !!s?.strokes.some(t => t.pressure), width, dpr: devicePixelRatio, screen: [screen.width, screen.height] },
        ...(withSample && s ? { sample: s.strokes.map(t => ({ pts: t.pts.map(p => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(p[2] * 1000) / 1000]), t: t.t, tilt: t.tilt, whole: t.whole, pressure: t.pressure })) } : {}),
      });
      setLab(l => ({ ...l, sent: Date.now() }));
      setStatus(`Sent (report #${r.id}). Thank you!`);
    } catch (e) { setStatus(`Not sent: ${(e as Error).message}`); }
  };

  const header = (
    <div class="pen-cal-head">
      <div class="pen-cal-titles">
        <div class="pen-cal-title">Find your ink</div>
        <div class="pen-cal-sub">
          {view === 'write' ? 'Your writing, drawn many ways: say which looks better each time.'
            : view === 'results' ? 'The inks you liked best.'
              : `Comparison ${n + 1}${n < ENOUGH ? ` · usually ${ENOUGH - 4}–${ENOUGH + 6}` : ''} · hold a panel to see the other ink in its place`}
        </div>
      </div>
      {view === 'compare' && (
        <>
          <span class="pen-lab-widths" role="radiogroup" aria-label="Width">
            {[...new Set(deck.pens.pen.widths)].map(w => (
              <button key={w} type="button" role="radio" aria-checked={w === width} class={'pen-lab-w' + (w === width ? ' on' : '')} title="The pen's width (as on a slide at 100 %)" onClick={() => setWidth(w)}>
                <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width={Math.min(10, w)} stroke-linecap="round" /></svg>
              </button>
            ))}
          </span>
          <button type="button" class="btn" disabled={!lab.sample?.strokes.some(s => s.t.length > 1)} onClick={() => setReplay(0)} title="Write the sample again at the pace it was written, both ways at once">Replay</button>
          <button type="button" class="btn" onClick={() => setView('write')}>New sample</button>
          <button type="button" class="btn primary" disabled={n < 4} onClick={() => setView('results')}>{settled ? 'Show my favourites' : 'Done'}</button>
        </>
      )}
      {view === 'results' && <button type="button" class="btn" onClick={() => setView('compare')}>Keep comparing</button>}
      <span class="pen-cal-gap" />
      <button type="button" class="btn" onClick={onClose}>Close</button>
    </div>
  );

  return (
    <div class="pen-cal pen-lab" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Find your ink" data-pen-lab>
      {header}
      {view === 'write' && (
        <WritePad initial={lab.sample} onCancel={() => setView('compare')}
          onDone={s => { setLab(l => (l.sample && !l.answers.length ? { ...l, sample: s } : { ...freshLab(s), seed: l.seed })); setView('compare'); }} />
      )}
      {view === 'compare' && lab.sample && (
        <div class="pen-lab-main">
          {settled && <div class="pen-lab-settled">Your ink looks found — the best has stayed the best for a while. <button type="button" class="btn small primary" onClick={() => setView('results')}>Show my favourites</button> or keep going.</div>}
          <div class={'pen-lab-pair' + (busy ? ' busy' : '')}>
            {shown && ([0, 1] as const).map(i => {
              const x = held === i ? shown[1 - i] : shown[i];
              return (
                <div key={i} class={'pen-lab-panel' + (bad[i] ? ' bad' : '') + (held === i ? ' held' : '')} data-pen-lab-panel={i ? 'b' : 'a'}
                  onPointerDown={e => { e.preventDefault(); setHeld(i); }} onPointerUp={() => setHeld(null)} onPointerLeave={() => setHeld(null)} onPointerCancel={() => setHeld(null)}>
                  <span class="pen-lab-tag">{held === i ? (i ? 'A' : 'B') : i ? 'B' : 'A'}</span>
                  <Drawn sample={lab.sample!} x={x} width={width} color={color} upTo={replay} label={`Ink ${i ? 'B' : 'A'}`} />
                  {details && <div class="pen-lab-details">{LAB_DIMS.map((d, k) => `${d.label} ${d.to(x[k], x)}`).join(' · ')}<br />{describe(x).join(', ')}</div>}
                </div>
              );
            })}
          </div>
          <div class="pen-lab-answers">
            <div class="pen-lab-grades">
              {GRADES.map(g => <button key={g.g} type="button" class={'btn pen-lab-grade' + (g.g === 0 ? ' same' : '')} data-pen-lab-grade={g.g} disabled={busy || !q} onClick={() => answer(g.g)} title={`Key ${g.key}`}>{g.label}</button>)}
            </div>
            <div class="pen-lab-flags">
              <button type="button" class={'btn pen-lab-flag' + (bad[0] ? ' on' : '')} aria-pressed={bad[0]} onClick={() => toggleBad(0)} title="Key a — then say which is better (or both horrible)">A is horrible</button>
              <button type="button" class={'btn pen-lab-flag' + (bad[1] ? ' on' : '')} aria-pressed={bad[1]} onClick={() => toggleBad(1)} title="Key b">B is horrible</button>
              <button type="button" class="btn pen-lab-flag" disabled={busy || !q} onClick={() => answer(0, true)}>Both horrible</button>
              <span class="pen-cal-gap" />
              <button type="button" class="btn" disabled={!n} onClick={undo} title="Backspace">Undo</button>
              <label class="pen-set-check"><input type="checkbox" checked={details} onChange={e => setDetails((e.target as HTMLInputElement).checked)} /> Settings</label>
            </div>
            {/* (which is which only when asked: knowing sways the eye) */}
            {details && <div class="pen-lab-best">Best so far: {describe(inc).join(', ')}{q?.kind ? ` · new: ${q.kind}` : ''}</div>}
          </div>
        </div>
      )}
      {view === 'results' && lab.sample && (
        <div class="pen-lab-main pen-lab-results">
          {favs.map((f, i) => (
            <div key={f.x.join()} class="pen-lab-fav">
              <div class="pen-lab-fav-head"><b>{i === 0 ? 'Liked best' : 'Liked about as much'}</b> · {describe(f.x).join(', ')}
                <button type="button" class={'btn small' + (i === 0 ? ' primary' : '')} data-pen-lab-use={i} onClick={() => use(f.x)}>Use this ink</button></div>
              <Drawn sample={lab.sample!} x={f.x} width={width} color={color} />
            </div>
          ))}
          <div class="pen-lab-fav">
            <div class="pen-lab-fav-head"><b>Your pen until now</b> · {describe(lab.start).join(', ')}</div>
            <Drawn sample={lab.sample!} x={lab.start} width={width} color={color} />
          </div>
          <div class="pen-lab-send">
            <div>{n} comparisons{agains.length ? ` · ${agains.filter(Boolean).length} of ${agains.length} pairs asked again were answered the same way` : ''}.</div>
            <label class="pen-set-check"><input type="checkbox" checked={withSample} onChange={e => setWithSample((e.target as HTMLInputElement).checked)} /> With my writing (the points the pen gave)</label>
            <button type="button" class="btn" data-pen-lab-send disabled={!n} onClick={send}>{lab.sent ? 'Send again' : 'Send my answers to OverLyX'}</button>
            <div class="pen-lab-hint">Your answers help OverLyX's pens get better for everyone: which settings you compared and what you chose. Your writing only if ticked.</div>
            <button type="button" class="btn small" onClick={() => { setLab({ ...freshLab(lab.sample), seed: lab.seed + 1 }); setView('compare'); setStatus(''); }}>Start over</button>
          </div>
          {status && <div class="pen-lab-status" role="status">{status}</div>}
        </div>
      )}
      {view !== 'results' && status && <div class="pen-lab-status" role="status">{status}</div>}
    </div>
  );
}

let open: HTMLElement | null = null;

/** the pen lab over everything (one at a time); `sample`: strokes written already (the calibration's), if no sample is kept */
export function openPenLab(sample?: { pts: FreePt[]; pressure: boolean; whole: boolean }[]): void {
  if (open) return;
  const host = document.createElement('div');
  document.body.append(host);
  open = host;
  const close = () => { render(null, host); host.remove(); open = null; };
  const given: Sample | null = sample?.length ? { strokes: sample.map(s => ({ ...s, t: [] })), type: sample.some(s => s.pressure) ? 'pen' : 'mouse' } : null;
  render(<PenLab onClose={close} sample={given} />, host);
}

export { HORRIBLE };
