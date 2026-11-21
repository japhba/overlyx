/**
 * Slide transitions and timed advance in an HTML deck — two attributes, read by the presenting
 * runtime (client deliverable/runtime/present.ts) and written by the editor's Animation pane:
 *
 *     <body data-ol-transition="fade">                       every slide comes in fading
 *     <section class="slide" data-ol-transition="push 0.8s"> this one pushed in, in 0.8 s
 *     <section class="slide" data-ol-transition="none">      this one cut to, whatever the deck's
 *     <section class="slide" data-ol-advance="5s">           its clicks (steps, then the next slide) come by themselves every 5 s
 *
 * - `data-ol-transition`: how a slide comes in when presenting — `none`, `fade`, `push` (the slide
 *   before pushed out, sideways), `wipe` (revealed from one side) — and optionally how long (`0.6s`,
 *   `600ms`). A slide's own value wins over the `<body>`'s, the deck's for every slide. Going back,
 *   push and wipe run the other way. Not in the rail, the PDF or the pictures: those show slides.
 * - `data-ol-advance`: the slide goes on by itself — each of its steps, then to the next slide —
 *   that many seconds after it (or the step) came; a click or a key still goes on at once. On the
 *   `<body>`: every slide's (a kiosk deck). PowerPoint's "Advance slide: After", Keynote's "Delay".
 */

export const TRANSITION_ATTR = 'data-ol-transition';
export const ADVANCE_ATTR = 'data-ol-advance';

export type TransitionKind = 'none' | 'fade' | 'push' | 'wipe';
export interface Transition { kind: TransitionKind; /** seconds */ secs: number }

export const TRANSITION_KINDS: { kind: TransitionKind; label: string }[] = [
  { kind: 'none', label: 'None' },
  { kind: 'fade', label: 'Fade' },
  { kind: 'push', label: 'Push' },
  { kind: 'wipe', label: 'Wipe' },
];

/** how long a transition takes unless it says (seconds) */
export const TRANSITION_SECS = 0.5;
/** the durations offered as rungs (seconds): Fast, Medium, Slow */
export const TRANSITION_RUNGS: { secs: number; label: string }[] = [{ secs: 0.3, label: 'Fast' }, { secs: 0.5, label: 'Medium' }, { secs: 1, label: 'Slow' }];
/** the timed advance's rungs (seconds) */
export const ADVANCE_RUNGS = [2, 5, 10, 30];

/** a length of time as written (`0.6s`, `600ms`, `2`): seconds, or null */
export function parseSecs(v: string | null | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(ms|s)?\s*$/i.exec(v ?? '');
  if (!m) return null;
  const n = Number(m[1]) / (m[2]?.toLowerCase() === 'ms' ? 1000 : 1);
  return Number.isFinite(n) ? n : null;
}

/** an attribute's transition: its kind and length (an unknown kind: a fade; empty: null) */
export function parseTransition(v: string | null | undefined): Transition | null {
  const words = (v ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const kind = (TRANSITION_KINDS.find(k => k.kind === words[0])?.kind ?? 'fade') as TransitionKind;
  const secs = parseSecs(words[1]);
  return { kind, secs: secs !== null ? Math.max(0.05, Math.min(5, secs)) : TRANSITION_SECS };
}

const secsText = (s: number) => `${Math.round(s * 100) / 100}s`;

/** the attribute's value for a transition (the usual length left out) */
export function formatTransition(t: Transition): string {
  return t.kind === 'none' || Math.abs(t.secs - TRANSITION_SECS) < 0.005 ? t.kind : `${t.kind} ${secsText(t.secs)}`;
}

/** the transition a slide comes in with: its own, else the deck's (the body's); none: null */
export function transitionOf(slideAttr: string | null | undefined, bodyAttr: string | null | undefined): Transition | null {
  const t = parseTransition(slideAttr) ?? parseTransition(bodyAttr);
  return t && t.kind !== 'none' ? t : null;
}

/** the seconds after which a slide goes on by itself (its own, else the deck's); null: on a click */
export function advanceOf(slideAttr: string | null | undefined, bodyAttr: string | null | undefined): number | null {
  const own = (slideAttr ?? '').trim().toLowerCase();
  if (own === 'click' || own === 'none') return null;
  const s = parseSecs(own) ?? parseSecs(bodyAttr);
  return s !== null && s > 0 ? Math.max(0.5, s) : null;
}

/** an advance as written (`5s`) */
export const formatAdvance = (secs: number): string => secsText(secs);
