/**
 * The pen lab's settings (client PenLab.tsx): the pen's settings (freehand.ts NibOpts) as numbers in
 * [0, 1] each, for the preference model (prefgp.ts) to learn over — each scaled so that equal steps
 * look about equally different (the smoothing in octaves, say) —, the kinds of pen asked about first
 * (a monoline gel pen, a fountain pen, a brush pen, a flat nib, a smoothed line, the line as given), a
 * few words for a setting, and what curators' answers taught: a value expected before anyone answers,
 * and the settings they found horrible, which nobody is asked about again.
 */
import type { NibOpts } from './freehand.ts';
import { PrefModel, HORRIBLE, cdf, type Answer, type Setting } from './prefgp.ts';

/** the version of the lab's settings (and the ink drawn with them): answers from another one are not mixed in */
export const LAB_VERSION = 1;

export interface LabDim {
  key: 'sensitivity' | 'pressSmooth' | 'liftLo' | 'liftHi' | 'sharpness' | 'flatness' | 'stabilization' | 'rounding';
  label: string;
  /** the pen's setting at u (and the setting so far, for those that depend on another) */
  to: (u: number, x: Setting) => number;
  from: (v: number, nib: NibOpts) => number;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
/** the pressure's smoothing: 0.6 to 12 screen px, in octaves */
const PS_LO = 0.6, PS_HI = 12;
/** the ink's thresholds (NibOpts.liftLo / liftHi): none below lo (up to 0.4 of the strongest), full from a little above it up to 0.85 */
const LO_MAX = 0.4, HI_MAX = 0.85, HI_GAP = 0.03;
/** the furthest the tip's sharpness, flatness and the smoothing go */
const SHARP_MAX = 0.7, FLAT_MAX = 0.8, STAB_MAX = 0.5;

export const LAB_DIMS: LabDim[] = [
  { key: 'sensitivity', label: 'Pressure', to: u => r2(u), from: v => clamp01(v) },
  { key: 'pressSmooth', label: 'Pressure smoothing', to: u => r2(PS_LO * (PS_HI / PS_LO) ** u), from: v => clamp01(Math.log(v / PS_LO) / Math.log(PS_HI / PS_LO)) },
  { key: 'liftLo', label: 'Breaks off below', to: u => r2(LO_MAX * u), from: v => clamp01(v / LO_MAX) },
  { key: 'liftHi', label: 'Full from', to: (u, x) => { const lo = LO_MAX * x[2]; return r2(lo + HI_GAP + u * (HI_MAX - lo - HI_GAP)); }, from: (v, nib) => { const lo = nib.liftLo ?? 0.12; return clamp01((v - lo - HI_GAP) / (HI_MAX - lo - HI_GAP)); } },
  // (only so far as handwriting a few px high keeps its shape: beyond, a short stroke is all taper, a small loop is smoothed away)
  { key: 'sharpness', label: 'Pointed ends', to: u => r2(SHARP_MAX * u), from: v => clamp01(v / SHARP_MAX) },
  { key: 'flatness', label: 'Flat nib', to: u => r2(FLAT_MAX * u * u), from: v => clamp01(Math.sqrt(v / FLAT_MAX)) },
  { key: 'stabilization', label: 'Smoothing', to: u => r2(STAB_MAX * u * u), from: v => clamp01(Math.sqrt(v / STAB_MAX)) },
  { key: 'rounding', label: 'Rounding', to: u => r2(u), from: v => clamp01(v) },
];

/** the pen's settings at a lab setting (a pen's: ink only where pressed) */
export function labNib(x: Setting): NibOpts {
  const nib: NibOpts = { ball: false, lift: true };
  LAB_DIMS.forEach((d, i) => { (nib as Record<string, number | boolean>)[d.key] = d.to(clamp01(x[i]), x); });
  return nib;
}

/**
 * The lab setting nearest a pen's settings (the user's own, to start from): what they leave unsaid as
 * the pen draws it then — the pressure smoothed as for whole-px points (Safari 17), the ink's
 * thresholds freehand.ts' own.
 */
export function labSetting(nib: Partial<NibOpts>, coarse = true): Setting {
  const full: NibOpts = { sensitivity: 0.25, sharpness: 0, flatness: 0, stabilization: 0, rounding: 0.3, liftLo: 0.12, liftHi: 0.42, ...nib };
  if (full.pressSmooth === undefined) full.pressSmooth = coarse ? Math.max(1.2, 2.5 * Math.hypot(3, 6 * (full.stabilization ?? 0))) : Math.max(1.2, 15 * (full.stabilization ?? 0));
  if (full.ball) { full.sensitivity = 0; full.sharpness = 0; full.flatness = 0; }
  const x = LAB_DIMS.map(d => d.from(full[d.key] as number, full));
  return x.map(v => Math.round(v * 1000) / 1000);
}

/** the kinds of pen asked about first — each against the best so far —, so that a taste far from the first one is found too */
export const LAB_KINDS: { name: string; x: Setting }[] = [
  // (pressure, its smoothing, breaks below, full from, pointed, flat, smoothing, rounding)
  { name: 'Even gel pen', x: [0.05, 0.55, 0.1, 0.05, 0, 0, 0.2, 0.5] },
  { name: 'Fountain pen, light pressure', x: [0.3, 0.5, 0.3, 0.2, 0, 0, 0, 0.5] },
  { name: 'Fountain pen, strong pressure', x: [0.8, 0.4, 0.35, 0.55, 0.15, 0, 0, 0.4] },
  { name: 'Brush pen', x: [1, 0.3, 0.5, 0.8, 0.6, 0, 0.35, 0.7] },
  { name: 'Flat nib', x: [0.3, 0.5, 0.3, 0.4, 0, 0.75, 0.25, 0.6] },
  { name: 'Smoothed', x: [0.25, 0.85, 0.25, 0.35, 0, 0, 0.75, 1] },
  { name: 'As drawn', x: [0.25, 0.2, 0.3, 0.4, 0, 0, 0, 0] },
];

/** a few words for a setting */
export function describe(x: Setting): string[] {
  const nib = labNib(x);
  const out: string[] = [];
  const s = nib.sensitivity!;
  out.push(s < 0.12 ? 'even width' : s < 0.4 ? 'a little pressure' : s < 0.75 ? 'follows the pressure' : 'strongly pressure-led');
  if (nib.flatness! > 0.15) out.push('flat nib');
  if (nib.sharpness! > 0.3) out.push('pointed ends');
  const lo = nib.liftLo!, hi = nib.liftHi!;
  out.push(lo > 0.22 ? 'breaks off where the pen barely touches' : lo < 0.06 ? 'never breaks off' : 'breaks off where the pen grazes');
  out.push(hi - lo < 0.12 ? 'round, full ends' : hi > 0.6 ? 'long tapers where it lifts' : 'thins out as it lifts');
  if (nib.stabilization! > 0.25) out.push('smoothed');
  out.push(nib.rounding! < 0.2 ? 'exact corners' : nib.rounding! > 0.7 ? 'rounded' : 'gently rounded');
  return out;
}

/**
 * A curator's answers (the lab's Send, LAB_VERSION's settings): what they found horrible is kept out of
 * everyone's questions, and what they liked is a little expected. None yet.
 */
export const CURATED: { version: number; answers: Answer[] }[] = [];

/** what the curators' answers say: the value expected before one's own answers (scaled down), and the settings kept out (horrible to them, likely) */
export function curatedPrior(sets = CURATED): { prior: (x: Setting) => number; veto: (x: Setting) => boolean } | null {
  const answers = sets.filter(s => s.version === LAB_VERSION).flatMap(s => s.answers);
  if (!answers.length) return null;
  const m = new PrefModel(LAB_DIMS.length);
  for (const a of answers) m.add(a);
  m.fit();
  const memo = new Map<string, { mu: number; v: number }>();
  const at = (x: Setting) => {
    const k = x.join(',');
    let r = memo.get(k);
    if (!r) { const p = m.predict([x]); r = { mu: p.mu[0], v: p.v[0] }; if (memo.size > 20000) memo.clear(); memo.set(k, r); }
    return r;
  };
  return {
    prior: x => 0.5 * at(x).mu,
    // (horrible to them more likely than not — Gelbart et al.'s feasibility, at ½: one flag keeps out its neighbourhood, a third of the way across the lab)
    veto: x => { const r = at(x); return cdf((HORRIBLE - r.mu) / Math.sqrt(r.v)) > 0.5; },
  };
}

/**
 * The pen lab's answers as kept (POST /api/ink-lab): numbers and a few fixed words only, everything
 * else dropped — null if it is not that at all, or too much.
 */
export function inkLabReport(b: unknown): { title: string; body: string } | null {
  if (!b || typeof b !== 'object') return null;
  const o = b as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
  const nums = (v: unknown, max: number) => (Array.isArray(v) && v.length <= max && v.every(x => num(x) !== null) ? v.map(x => num(x)!) : null);
  const word = (v: unknown, max: number) => (typeof v === 'string' && /^[\w ,.'()-]*$/.test(v) ? v.slice(0, max) : undefined);
  const version = num(o.version), dims = Array.isArray(o.dims) && o.dims.length <= 16 ? o.dims.map(d => word(d, 24)).filter((d): d is string => !!d) : null;
  if (version === null || !dims || !Array.isArray(o.answers) || o.answers.length > 400) return null;
  const answers = [];
  for (const a of o.answers as unknown[]) {
    if (!a || typeof a !== 'object') return null;
    const r = a as Record<string, unknown>;
    const x = nums(r.a, 16), y = nums(r.b, 16), grade = num(r.grade);
    if (!x || !y || grade === null || ![-2, -1, 0, 1, 2].includes(grade)) return null;
    answers.push({ a: x, b: y, grade, ...(r.badA === true ? { badA: true } : {}), ...(r.badB === true ? { badB: true } : {}), top: r.top === 1 ? 1 : 0, ...(word(r.kind, 40) ? { kind: word(r.kind, 40) } : {}), ms: num(r.ms) ?? 0, ...(r.again === true ? { again: true } : {}), ...(num(r.score) !== null ? { score: num(r.score) } : {}) });
  }
  const d = o.device && typeof o.device === 'object' ? o.device as Record<string, unknown> : {};
  const device = { type: word(d.type, 12) ?? '', whole: d.whole === true, pressure: d.pressure === true, width: num(d.width), dpr: num(d.dpr), screen: nums(d.screen, 2) };
  let sample: unknown[] | undefined;
  if (Array.isArray(o.sample)) {
    if (o.sample.length > 300) return null;
    let total = 0;
    sample = [];
    for (const s of o.sample as unknown[]) {
      const r = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      if (!Array.isArray(r.pts) || r.pts.length > 5000) return null;
      const pts = r.pts.map(p => nums(p, 3));
      if (pts.some(p => !p || p.length !== 3)) return null;
      total += pts.length;
      if (total > 40000) return null;
      sample.push({ pts, t: nums(r.t, 5000) ?? [], tilt: nums(r.tilt, 10000) ?? [], whole: r.whole === true, pressure: r.pressure === true });
    }
  }
  const kept = { version, dims, start: nums(o.start, 16), answers, favourites: Array.isArray(o.favourites) ? o.favourites.slice(0, 3).map(f => nums(f, 16)) : [], length: num(o.length), bias: num(o.bias), device, ...(sample ? { sample } : {}) };
  return { title: `Pen lab: ${answers.length} answers (settings v${version})${sample ? ', with the writing' : ''}`, body: JSON.stringify(kept) };
}
