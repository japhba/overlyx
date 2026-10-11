/**
 * LyX's formula editor on a slide: the runtime (runtime/mathedit.ts) asks for a formula of a text
 * being retyped to be edited (`mathEdit`: where it is drawn, its colour) and this lays a
 * LyxMathField — the one of documents: LyX's cursor, keys, Alt+M, undo, the math toolbar — exactly
 * over it, so that editing a formula looks like the formula itself taking the cursor: the same font
 * as the slide's MathJax (DeliverableEditor sets New Computer Modern), its em as MathJax drew it
 * (scaled to the text's x-height), on its baseline, growing from the side its line grows from
 * (a centred formula both ways). The field shows only once it is drawn (`onShown`: the runtime
 * then hides the formula under it); it sends the formula back as it changes and when it is left
 * (an arrow key or Escape out of it, a click elsewhere), and stays — still, without its frame —
 * until the formula is shown again under it (`closing`, the runtime's mathClose).
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { LyxMathField, stripMathDelims } from '../editor/lyxmath/field';
import { parseFormula, writeFormula, type MacroTable } from '@overlyx/core';
import type { MathBox, KeyPress } from './protocol';
import { INVERT_FILTER } from '../app/darkslides';

/** LyX's Alt+M N on a displayed formula: numbered (an equation environment, as LaTeX's) or not; every row of a grid alike */
export function toggleNumbering(f: LyxMathField, macros: MacroTable = {}): void {
  const h = parseFormula(f.latex, macros);
  if (h.type === 'simple') return;
  const on = !h.numberedRows.every(n => n === true);
  h.numberedRows = h.numberedRows.map(() => on);
  f.setLatex(writeFormula(h));
}

/** a label on the row of a displayed formula the cursor is in (numbering it): what \ref / \eqref point to */
export function labelFormula(f: LyxMathField, name: string, macros: MacroTable = {}): void {
  const h = parseFormula(f.latex, macros);
  if (h.type === 'simple') return;
  const row = Math.min(f.topRow(), h.rows.length - 1);
  h.labels[row] = name.trim() || undefined;
  if (name.trim()) h.numberedRows[row] = true;
  f.setLatex(writeFormula(h));
}

/** the label of the row the cursor is in */
export function formulaLabel(f: LyxMathField, macros: MacroTable = {}): string {
  const h = parseFormula(f.latex, macros);
  return h.labels[Math.min(f.topRow(), h.labels.length - 1)] ?? '';
}

export interface MathEditState {
  id: number; tex: string; display: boolean; box: MathBox; color: string; at: { x: number; y: number } | null; where: 'start' | 'end';
  /** opened by typing `$` / `$$` in the text */
  dollar?: '$' | '$$';
  /** left: shown (not editable) until the formula is there again under it */
  closing?: boolean;
}

/** what is still part of editing the formula when it gets the pointer or the focus (the toolbars, their palettes) */
const OURS = '.dl-mathedit, .toolbar, .tb-popup, .dl-ctx, .dl-floatpop, .ctx-menu, .dialog-backdrop';

/** the field's own rendering is there (not its source while the math font's data is on its way) */
const drawn = (f: LyxMathField) => !!f.dom.querySelector('.lm-content mjx-container') && !f.dom.querySelector('.lm-content .lm-pending');

/** what the toolbar does to the formula open (the math row's Number and Label) */
export interface MathOps { number(): void; label(name: string): void; labelNow(): string; display: boolean }

export function MathOverlay({ st, frame, scale, macros, onSet, onDone, onShown, onDisplay, onRest, keysIn, ops, typeAhead, invert }: {
  st: MathEditState;
  /** the slides are shown light on dark (app/darkslides.ts): the field over a formula is too */
  invert?: boolean;
  /** set here while the field is open */
  ops?: { current: MathOps | null };
  /** the macros of the .tex files the page links (core html/deckextras.ts) */
  macros?: MacroTable;
  frame: HTMLIFrameElement | null;
  scale: number;
  onSet(tex: string): void;
  onDone(tex: string, dir: 'forward' | 'backward' | null, putBack?: string): void;
  /** the field is drawn over the formula */
  onShown(): void;
  /** `$$` typed into the empty inline formula `$` opened: a displayed formula instead */
  onDisplay(): void;
  /** keys typed ahead that came after the formula was left by them (`$x$ and`): for the text */
  onRest(keys: KeyPress[]): void;
  /** set here: takes the keys typed in the page before the field had the keyboard (the runtime's mathKeys) */
  keysIn: { current: ((id: number, keys: KeyPress[]) => void) | null };
  /** taken (and emptied) once the field has the keyboard */
  typeAhead?: { current: string[] | null };
}) {
  const box = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(false);
  const cb = useRef({ onSet, onDone, onShown, onDisplay, onRest }); cb.current = { onSet, onDone, onShown, onDisplay, onRest };
  const fr = frame?.getBoundingClientRect();
  const b = st.box;
  /** the baseline the field sits on (window px) */
  const baseline = useRef(0);
  baseline.current = (fr?.top ?? 0) + b.baseline * scale;

  /** the field's baseline put on the formula's (its height above the baseline changes as it is edited) */
  const place = () => {
    const el = box.current, m = base.current;
    if (!el || !m) return;
    const off = m.getBoundingClientRect().top - el.getBoundingClientRect().top;
    el.style.top = `${baseline.current - off}px`;
  };

  useLayoutEffect(() => {
    if (!box.current || !base.current) return;
    let done = false;
    let field: LyxMathField | null = null;
    // the formula as it was when nothing was changed (its source is kept: LyX's writer would normalise it)
    let initial = '';
    /** `$$` made it a displayed formula: what is typed after that is the new formula's */
    let toDisplay = false;
    const texNow = () => { const t = field ? stripMathDelims(field.latex) : st.tex; return t === initial ? st.tex : t; };
    const finish = (dir: 'forward' | 'backward' | null, putBack?: string) => {
      if (done) return;
      done = true;
      cb.current.onDone(texNow(), dir, putBack);
    };
    field = new LyxMathField({
      // (a numbered formula is its environment, as written)
      latex: /^\s*\\begin\{/.test(st.tex) ? st.tex : st.display ? `\\[${st.tex}\\]` : `$${st.tex}$`,
      display: st.display,
      macros: macros ?? {},
      onChange: () => cb.current.onSet(texNow()),
      onMoveOut: (dir, o) => finish(dir === 'backward' || dir === 'upward' ? 'backward' : 'forward', o.putBack),
      onCommand: k => {
        if (k === '$$' && !done) { done = true; toDisplay = true; cb.current.onDisplay(); }
        else if (k === 'n' && field && st.display) { toggleNumbering(field, macros); cb.current.onSet(texNow()); }
      },
      // the focus went into the page (a click on the slide) or somewhere else that is not the toolbar
      onBlur: () => setTimeout(() => {
        const a = document.activeElement as HTMLElement | null;
        if (done || !a || a === document.body || field?.dom.contains(a) || a.closest(OURS)) return;
        finish(null);
      }, 0),
    });
    base.current.before(field.dom);
    const f = field;
    initial = stripMathDelims(f.latex);
    if (st.dollar) f.dollar = st.dollar;
    // Keys typed in the page after the formula was opened there, before this field had the keyboard,
    // come from the runtime once the field is drawn (mathKeys); keys typed here meanwhile wait for
    // them, so that everything lands in the order it was typed — the part after a closing `$` in the text.
    let holding = true;
    const here: KeyPress[] = [];
    const typeIn = (keys: KeyPress[]) => {
      for (let i = 0; i < keys.length; i++) {
        if (done) {
          const rest = keys.slice(i);
          if (!toDisplay) cb.current.onRest(rest);
          else if (typeAhead) {
            const chars = rest.filter(k => k.key.length === 1 && !k.ctrl && !k.meta).map(k => k.key);
            typeAhead.current = chars;
            setTimeout(() => { if (typeAhead.current === chars) typeAhead.current = null; }, 2000);
          }
          return;
        }
        const k = keys[i];
        if (k.key.length === 1 && !k.ctrl && !k.meta && !k.alt) f.typeText(k.key);
        else f.pressKey({ key: k.key, shiftKey: !!k.shift, ctrlKey: !!k.ctrl, altKey: !!k.alt, metaKey: !!k.meta });
      }
    };
    // (keys typed in the editor before the field opened — a formula placed, then typed into at once — come first)
    const early: KeyPress[] = (typeAhead?.current ?? []).map(key => ({ key }));
    if (typeAhead) typeAhead.current = null;
    const release = (ahead: KeyPress[]) => {
      if (!holding) return;
      holding = false;
      clearTimeout(holdTimer);
      typeIn([...early, ...ahead, ...here]);
    };
    const holdTimer = setTimeout(() => release([]), 1500);
    // every key typed here waits meanwhile (an arrow key must not overtake the letters before it)
    const hold = (e: KeyboardEvent) => {
      if (!holding || ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      here.push({ key: e.key, shift: e.shiftKey || undefined, ctrl: e.ctrlKey || undefined, alt: e.altKey || undefined, meta: e.metaKey || undefined });
    };
    box.current.addEventListener('keydown', hold, true);
    keysIn.current = (id, keys) => { if (id === st.id) release(keys); };
    if (ops) ops.current = {
      display: st.display,
      number: () => { if (done || !st.display) return; toggleNumbering(f, macros); cb.current.onSet(texNow()); f.focus(); },
      label: name => { if (done || !st.display) return; labelFormula(f, name, macros); cb.current.onSet(texNow()); f.focus(); },
      labelNow: () => formulaLabel(f, macros),
    };
    // shown once drawn (the formula under it stays until then); kept on its baseline as it changes
    let ok = false;
    setShown(false);
    const check = () => {
      place();
      if (ok || !drawn(f)) return;
      ok = true;
      setShown(true);
      cb.current.onShown();
    };
    const ro = new ResizeObserver(check);
    ro.observe(f.dom);
    const mo = new MutationObserver(check);
    mo.observe(f.dom, { childList: true, subtree: true });
    check();
    // a press anywhere else of the editor (not the toolbars) ends it too
    const onDown = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.(OURS)) finish(null); };
    document.addEventListener('pointerdown', onDown, true);
    // the keyboard at once (typing may follow the click straight away); the cursor at the click once laid out
    f.focus(st.where);
    if (st.at) requestAnimationFrame(() => {
      if (done) return;
      const r = frame?.getBoundingClientRect();
      if (r) f.focusAt(r.left + st.at!.x * scale, r.top + st.at!.y * scale);
    });
    const el = box.current;
    return () => {
      ro.disconnect(); mo.disconnect(); clearTimeout(holdTimer);
      el?.removeEventListener('keydown', hold, true);
      document.removeEventListener('pointerdown', onDown, true);
      if (keysIn.current) keysIn.current = null;
      if (ops) ops.current = null;
      done = true; f.destroy(); f.dom.remove();
    };
  }, [st.id]);

  // the formula moved or was typeset again, the canvas scrolled or zoomed: the field follows
  useLayoutEffect(place);

  if (!fr) return null;
  const x = fr.left + (b.align === 'left' ? b.rect.x : b.align === 'center' ? b.rect.x + b.rect.w / 2 : b.rect.x + b.rect.w) * scale;
  return (
    <div ref={box} class={'dl-mathedit' + (shown ? '' : ' pending') + (st.display ? ' display' : '') + (st.closing ? ' closing' : '')} data-dl-mathedit
      style={{ left: `${x}px`, transform: b.align === 'left' ? undefined : `translateX(${b.align === 'center' ? -50 : -100}%)`, fontSize: `${b.em * scale}px`, color: st.color, filter: invert ? INVERT_FILTER : undefined }}>
      <span ref={base} class="dl-mathedit-base" />
    </div>
  );
}
