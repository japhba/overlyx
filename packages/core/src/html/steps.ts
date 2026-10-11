/**
 * Steps on a slide — beamer's overlays, PowerPoint's animation order. Step 1 is the slide as it
 * comes up; each click when presenting goes one step on. An object's `data-step` says which steps it
 * shows on, as a beamer overlay specification:
 *
 *   data-step="3"     from step 3 on (as after two \pause; PowerPoint: appears on the second click)
 *   data-step="-3"    until step 3, gone from step 4 (PowerPoint: disappears on the third click)
 *   data-step="2-4"   steps 2 to 4 (appears, later disappears)
 *   data-step="1,3-"  step 1, and from step 3 on (any other specification as beamer reads it)
 *
 * The editor's Animate tools edit a slide's sequence — every object's appearances and
 * disappearances by step — rather than these strings: objects added in the order they are clicked,
 * moved earlier or later one notch at a time, removed (runtime/edit.ts writes the result back).
 * Runtime-safe: no imports.
 */

/** steps an object shows on: [from, to] (to null: to the end), sorted and apart */
export type Interval = [number, number | null];

function normalise(iv: Interval[]): Interval[] {
  const s = iv.map(([a, b]) => [a, b] as Interval).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && (last[1] === null || a <= last[1] + 1)) { if (last[1] !== null) last[1] = b === null ? null : Math.max(last[1], b); }
    else out.push([a, b]);
  }
  return out;
}

/** the steps a data-step value shows the object on (none or unreadable: all of them) */
export function parseSteps(spec: string | null | undefined): Interval[] {
  const s = (spec ?? '').replace(/[<>\s]/g, '');
  if (!s) return [[1, null]];
  if (/^\d+$/.test(s)) return [[Math.max(1, Number(s)), null]];
  const out: Interval[] = [];
  for (const part of s.split(',')) {
    const p = part.replace(/^[a-z]+@/i, '');   // beamer's alert@2- …: the steps
    const m = /^(\d*)-(\d*)$/.exec(p);
    if (m && (m[1] || m[2])) {
      const a = m[1] ? Math.max(1, Number(m[1])) : 1, b = m[2] ? Number(m[2]) : null;
      if (b === null || b >= a) out.push([a, b]);
    } else if (/^\d+$/.test(p)) { const n = Math.max(1, Number(p)); out.push([n, n]); }
  }
  return out.length ? normalise(out) : [[1, null]];
}

/** the data-step value for the steps given (null: shown throughout, no attribute) */
export function formatSteps(iv: Interval[]): string | null {
  const n = normalise(iv);
  if (!n.length) return null;
  if (n.length === 1) {
    const [a, b] = n[0];
    if (b === null) return a <= 1 ? null : String(a);
    return a <= 1 ? `-${b}` : `${a}-${b}`;
  }
  return n.map(([a, b]) => (b === null ? `${a}-` : a === b ? String(a) : a <= 1 ? `-${b}` : `${a}-${b}`)).join(',');
}

export function stepVisible(iv: Interval[], n: number): boolean {
  return iv.some(([a, b]) => n >= a && (b === null || n <= b));
}

/** the step from which an object shows (a list's data-steps: its first item's) */
export function stepOf(value: string | null | undefined): number {
  return parseSteps(value)[0][0];
}

/* ------------------------------------------------------------------ a slide's sequence */

/** an object (by its index among the slide's) appears or disappears at a step */
export interface StepEvent { obj: number; kind: 'appear' | 'disappear'; step: number }

/** an object's appearances and disappearances (at steps after the first) */
export function eventsOf(iv: Interval[], obj: number): StepEvent[] {
  const out: StepEvent[] = [];
  for (const [a, b] of normalise(iv)) {
    if (a > 1) out.push({ obj, kind: 'appear', step: a });
    if (b !== null) out.push({ obj, kind: 'disappear', step: b + 1 });
  }
  return out;
}

/** the slide's sequence: every object's events, by step (within a step, in the slide's order) */
export function sequence(objs: Interval[][]): StepEvent[] {
  return objs.flatMap((iv, i) => eventsOf(iv, i)).sort((x, y) => x.step - y.step || x.obj - y.obj);
}

/** the number of steps a slide has */
export function lastStep(objs: Interval[][]): number {
  return Math.max(1, ...sequence(objs).map(e => e.step));
}

function intervalsFrom(ev: StepEvent[]): Interval[] {
  const e = ev.slice().sort((x, y) => x.step - y.step);
  const out: Interval[] = [];
  let from: number | null = !e.length || e[0].kind === 'disappear' ? 1 : null;
  for (const x of e) {
    if (x.kind === 'appear') { if (from === null) from = x.step; }
    else if (from !== null) { if (x.step - 1 >= from) out.push([from, x.step - 1]); from = null; }
  }
  if (from !== null) out.push([from, null]);
  return out;
}

const intervalsOf = (ev: StepEvent[], n: number): Interval[][] => Array.from({ length: n }, (_, i) => intervalsFrom(ev.filter(e => e.obj === i)));

/** the steps used numbered 2, 3, … with no click where nothing happens */
function compact(ev: StepEvent[]): StepEvent[] {
  const rank = new Map([...new Set(ev.map(e => e.step))].sort((a, b) => a - b).map((s, i) => [s, i + 2]));
  return ev.map(e => ({ ...e, step: rank.get(e.step)! }));
}

/** an object made to appear or disappear (`together`: on the same click as the step before) */
export interface StepPick { obj: number; kind: 'appear' | 'disappear'; together?: boolean }

/**
 * Objects made to appear / disappear on the clicks after the slide's last step, in the order they
 * were picked — PowerPoint's adding an animation. An object's own last appearance (disappearance)
 * moves there rather than getting a second one, so clicking a slide's objects again in another order
 * puts them in that order.
 */
export function appendSteps(objs: Interval[][], picks: StepPick[]): Interval[][] {
  let ev = compact(sequence(objs));
  for (const p of picks) {
    const own = ev.filter(e => e.obj === p.obj);
    const lastOwn = own[own.length - 1];
    if (lastOwn && lastOwn.kind === p.kind) ev = compact(ev.filter(e => e !== lastOwn));
    const last = Math.max(1, ...ev.map(e => e.step));
    let s = p.together && last > 1 ? last : last + 1;
    if (ev.some(e => e.obj === p.obj && e.step >= s)) s = last + 1;
    ev = compact([...ev, { obj: p.obj, kind: p.kind, step: s }]);
  }
  return intervalsOf(ev, objs.length);
}

/**
 * The event at `at` one notch earlier (-1) or later (1): notches alternate between "on its own
 * click" and "together with" the neighbouring step, so pressing ↑ on the last of A, B, C first puts
 * C with B, then before B, then with A, then first. Null where it cannot go (before the first click,
 * after the last, past the object's own other events).
 */
export function moveStep(objs: Interval[][], at: { obj: number; step: number }, dir: -1 | 1): Interval[][] | null {
  const raw = sequence(objs);
  const i = raw.findIndex(e => e.obj === at.obj && e.step === at.step);
  if (i < 0) return null;
  const ev = compact(raw), me = ev[i];
  const others = ev.filter(e => e !== me);
  const steps = [...new Set(others.map(e => e.step))].sort((a, b) => a - b);
  // notches: 2j = its own click before steps[j] (2·length: after the last), 2j + 1 = with steps[j]
  const j = steps.indexOf(me.step);
  const notch = (j >= 0 ? 2 * j + 1 : 2 * steps.filter(s => s < me.step).length) + dir;
  if (notch < 0 || notch > 2 * steps.length) return null;
  const s = notch % 2 ? steps[(notch - 1) / 2] : notch / 2 < steps.length ? steps[notch / 2] - 0.5 : (steps[steps.length - 1] ?? 1) + 1;
  // an object's own events keep their order (an appearance stays before the disappearance after it)
  const own = others.filter(e => e.obj === me.obj);
  const prev = own.filter(e => e.step < me.step).pop(), next = own.find(e => e.step > me.step);
  if ((prev && s <= prev.step) || (next && s >= next.step)) return null;
  return intervalsOf(compact([...others, { ...me, step: s }]), objs.length);
}

/** the event at `at` removed (an object no longer appearing at all shows throughout) */
export function removeStep(objs: Interval[][], at: { obj: number; step: number }): Interval[][] {
  const ev = sequence(objs);
  const me = ev.find(e => e.obj === at.obj && e.step === at.step);
  if (!me) return objs;
  // what is left of the object's events alternating again: a disappearance goes with the
  // reappearance after it (one stretch shown), and of two alike in a row the first stays
  const all = ev.filter(e => e.obj === at.obj);
  const after = all[all.indexOf(me) + 1];
  const own = all.filter(e => e !== me && !(me.kind === 'disappear' && e === after && e.kind === 'appear'));
  const keep = own.filter((e, i) => i === 0 || e.kind !== own[i - 1].kind);
  return intervalsOf(compact([...ev.filter(e => e.obj !== at.obj), ...keep]), objs.length);
}

/** the objects shown throughout (their events removed) */
export function clearSteps(objs: Interval[][], which: number[]): Interval[][] {
  return intervalsOf(compact(sequence(objs).filter(e => !which.includes(e.obj))), objs.length);
}
