/**
 * The Animation pane's slide part: how the slide comes in when presenting (None · Fade · Push · Wipe,
 * how fast on a slider with rungs) and whether it goes on by itself (On click · After n seconds, a
 * slider with rungs) — for the slide shown, or the slides selected in the slide list; *Apply to all
 * slides* makes it the deck's (the `<body>`'s) and drops the slides' own. Written as
 * `data-ol-transition` / `data-ol-advance` (core html/transitions.ts), each choice one change of the
 * text — one undo step, a suggestion while Suggesting. Presenting reads them (runtime transition.ts).
 */
import { useEffect, useState } from 'preact/hooks';
import { parseSource, attr, pathOf, htmlElement, elementChildren, type HtmlOp, type Path } from '@overlyx/core/html/source.ts';
import { slideElements } from '@overlyx/core/html/deliverable.ts';
import {
  TRANSITION_ATTR, ADVANCE_ATTR, TRANSITION_KINDS, TRANSITION_RUNGS, TRANSITION_SECS, ADVANCE_RUNGS,
  parseTransition, formatTransition, advanceOf, formatAdvance, type TransitionKind,
} from '@overlyx/core/html/transitions.ts';
import './slidefx.css';

/** the deck's settings and each slide's own (the attributes as written) */
export interface SlideFxState {
  body: Path | null;
  deck: { transition: string | null; advance: string | null };
  slides: { path: Path; transition: string | null; advance: string | null }[];
}

export function slideFxIn(text: string): SlideFxState {
  const { doc } = parseSource(text);
  const html = htmlElement(doc);
  const body = html ? elementChildren(html).find(e => e.tagName === 'body') : undefined;
  return {
    body: body?.sourceCodeLocation ? pathOf(body) : null,
    deck: { transition: body ? attr(body, TRANSITION_ATTR) : null, advance: body ? attr(body, ADVANCE_ATTR) : null },
    slides: slideElements(doc).map(el => ({ path: pathOf(el), transition: attr(el, TRANSITION_ATTR), advance: attr(el, ADVANCE_ATTR) })),
  };
}

interface Props {
  fx: SlideFxState;
  /** the slides it is for (indices): the one shown, or those selected in the slide list */
  slides: number[];
  readOnly: boolean;
  apply(ops: HtmlOp[]): void;
}

const T_MIN = 0.15, T_MAX = 2, A_MIN = 1, A_MAX = 120, STEPS = 1000;
const logPos = (v: number, lo: number, hi: number) => Math.round((Math.log(v / lo) / Math.log(hi / lo)) * STEPS);
const logVal = (p: number, lo: number, hi: number) => lo * Math.exp((p / STEPS) * Math.log(hi / lo));
const near = (p: number, rungs: number[], lo: number, hi: number) => { for (const r of rungs) if (Math.abs(logPos(r, lo, hi) - p) <= STEPS * 0.03) return r; return null; };
const secsLabel = (s: number) => s < 10 ? `${Math.round(s * 10) / 10} s` : `${Math.round(s)} s`;

export function SlideFx({ fx, slides, readOnly, apply }: Props) {
  const own = slides.map(i => fx.slides[i]).filter(Boolean);
  const first = own[0];
  const deckT = parseTransition(fx.deck.transition);
  // what the (first) slide comes in with: its own, else the deck's
  const shownT = parseTransition(first?.transition) ?? deckT ?? { kind: 'none' as TransitionKind, secs: TRANSITION_SECS };
  const shownA = first ? advanceOf(first.advance, fx.deck.advance) : null;
  const fromDeck = !!first && first.transition === null && !!deckT;
  const [secs, setSecs] = useState(shownT.secs);
  const [after, setAfter] = useState(shownA ?? 5);
  useEffect(() => setSecs(shownT.secs), [shownT.secs, slides.join()]);
  useEffect(() => { if (shownA !== null) setAfter(shownA); }, [shownA, slides.join()]);
  if (!first) return null;
  const many = own.length > 1;

  /** the selected slides' own attribute set to `value` — none where the deck's says the same */
  const setOwn = (name: string, value: string | null, deckValue: string | null) => {
    const v = value !== null && value === deckValue ? null : value;
    const ops: HtmlOp[] = own.filter(s => (name === TRANSITION_ATTR ? s.transition : s.advance) !== v).map(s => ({ t: 'attr', path: s.path, name, value: v }));
    if (ops.length) apply(ops);
  };
  // (None where the deck has none: no attribute at all)
  const setKind = (kind: TransitionKind) => setOwn(TRANSITION_ATTR, kind === 'none' && !deckT ? null : formatTransition({ kind, secs }), fx.deck.transition);
  const setSpeed = (s: number) => { setSecs(s); if (shownT.kind !== 'none') setOwn(TRANSITION_ATTR, formatTransition({ kind: shownT.kind, secs: s }), fx.deck.transition); };
  const setAdvance = (s: number | null) => setOwn(ADVANCE_ATTR, s === null ? (fx.deck.advance ? 'click' : null) : formatAdvance(s), fx.deck.advance);
  const applyAll = () => {
    if (!fx.body) return;
    const t = shownT.kind === 'none' ? null : formatTransition({ kind: shownT.kind, secs });
    const a = shownA === null ? null : formatAdvance(shownA);
    const ops: HtmlOp[] = [];
    if (t !== fx.deck.transition) ops.push({ t: 'attr', path: fx.body, name: TRANSITION_ATTR, value: t });
    if (a !== fx.deck.advance) ops.push({ t: 'attr', path: fx.body, name: ADVANCE_ATTR, value: a });
    for (const s of fx.slides) {
      if (s.transition !== null) ops.push({ t: 'attr', path: s.path, name: TRANSITION_ATTR, value: null });
      if (s.advance !== null) ops.push({ t: 'attr', path: s.path, name: ADVANCE_ATTR, value: null });
    }
    if (ops.length) apply(ops);
  };
  const tRungs = TRANSITION_RUNGS.map(r => r.secs);
  const tPos = logPos(Math.max(T_MIN, Math.min(T_MAX, secs)), T_MIN, T_MAX), aPos = logPos(Math.max(A_MIN, Math.min(A_MAX, after)), A_MIN, A_MAX);

  return <div class="dl-fx" data-dl-slidefx>
    <div class="dl-fx-head">{many ? `${own.length} slides` : 'This slide'} comes in{fromDeck ? <span class="dl-fx-note"> (as every slide)</span> : null}</div>
    <div class="dl-fx-kinds" role="radiogroup" aria-label="Transition">
      {TRANSITION_KINDS.map(k => <button type="button" key={k.kind} class={'dl-btn' + (shownT.kind === k.kind ? ' on' : '')} role="radio" aria-checked={shownT.kind === k.kind} disabled={readOnly}
        data-fx-kind={k.kind} onClick={() => setKind(k.kind)}>{k.label}</button>)}
    </div>
    {shownT.kind !== 'none' && <div class="dl-fx-slider">
      <span class="dl-fx-label">Speed</span><span class="dl-fx-value">{secsLabel(secs)}</span>
      <input type="range" min={0} max={STEPS} value={tPos} disabled={readOnly} aria-label="How long the transition takes" data-fx-speed
        onInput={e => { const p = Number((e.target as HTMLInputElement).value); setSecs(near(p, tRungs, T_MIN, T_MAX) ?? Math.round(logVal(p, T_MIN, T_MAX) * 20) / 20); }}
        onChange={e => { const p = Number((e.target as HTMLInputElement).value); setSpeed(near(p, tRungs, T_MIN, T_MAX) ?? Math.round(logVal(p, T_MIN, T_MAX) * 20) / 20); }} />
      <span class="dl-fx-rungs" aria-hidden="true">{TRANSITION_RUNGS.map(r => <button type="button" key={r.secs} class={Math.abs(r.secs - secs) < 0.01 ? 'on' : ''} disabled={readOnly}
        style={{ left: `${(logPos(r.secs, T_MIN, T_MAX) / STEPS) * 100}%` }} onClick={() => setSpeed(r.secs)}>{r.label}</button>)}</span>
    </div>}
    <div class="dl-fx-head">Goes on</div>
    <div class="dl-fx-kinds" role="radiogroup" aria-label="Goes on">
      <button type="button" class={'dl-btn' + (shownA === null ? ' on' : '')} role="radio" aria-checked={shownA === null} disabled={readOnly} data-fx-advance="click" onClick={() => setAdvance(null)}>On a click</button>
      <button type="button" class={'dl-btn' + (shownA !== null ? ' on' : '')} role="radio" aria-checked={shownA !== null} disabled={readOnly} data-fx-advance="after" onClick={() => setAdvance(after)}
        title="Each of its steps, then the next slide, comes by itself after this long (a click still goes on at once)">By itself</button>
    </div>
    {shownA !== null && <div class="dl-fx-slider">
      <span class="dl-fx-label">After</span><span class="dl-fx-value">{secsLabel(after)}</span>
      <input type="range" min={0} max={STEPS} value={aPos} disabled={readOnly} aria-label="Seconds before it goes on" data-fx-after
        onInput={e => { const p = Number((e.target as HTMLInputElement).value); setAfter(near(p, ADVANCE_RUNGS, A_MIN, A_MAX) ?? Math.round(logVal(p, A_MIN, A_MAX))); }}
        onChange={e => { const p = Number((e.target as HTMLInputElement).value); setAdvance(near(p, ADVANCE_RUNGS, A_MIN, A_MAX) ?? Math.round(logVal(p, A_MIN, A_MAX))); }} />
      <span class="dl-fx-rungs" aria-hidden="true">{ADVANCE_RUNGS.map(r => <button type="button" key={r} class={Math.abs(r - after) < 0.01 ? 'on' : ''} disabled={readOnly}
        style={{ left: `${(logPos(r, A_MIN, A_MAX) / STEPS) * 100}%` }} onClick={() => { setAfter(r); setAdvance(r); }}>{r} s</button>)}</span>
    </div>}
    {!readOnly && fx.slides.length > 1 && <button type="button" class="dl-btn dl-fx-all" data-fx-all onClick={applyAll}
      title="Every slide comes in and goes on like this one (the deck's setting; slides' own settings dropped)">Apply to all slides</button>}
  </div>;
}
