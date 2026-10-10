/**
 * LyX's formula editor on a slide: the runtime (runtime/mathedit.ts) asks for a formula of a text
 * being retyped to be edited (`mathEdit`: its box in the frame, font size, colour) and this puts a
 * LyxMathField — the one of documents: LyX's cursor, keys, Alt+M, undo, the math toolbar — exactly
 * over it, at the canvas's zoom, sending the formula back as it changes and when it is left (an
 * arrow key or Escape out of it, a click elsewhere).
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import { LyxMathField, stripMathDelims } from '../editor/lyxmath/field';
import type { Rect } from './protocol';

export interface MathEditState { id: number; tex: string; display: boolean; rect: Rect; fontPx: number; color: string; at: { x: number; y: number } | null; where: 'start' | 'end' }

/** what is still part of editing the formula when it gets the pointer or the focus (the toolbars, their palettes) */
const OURS = '.dl-mathedit, .toolbar, .tb-popup, .dl-ctx, .dl-floatpop, .ctx-menu, .dialog-backdrop';

/** keys typed before the field had the keyboard (a new formula placed, then typed into at once) */
function replay(f: LyxMathField, keys: string[]): void {
  for (const k of keys) {
    if (k === '^') f.execute('moveToSuperscript');
    else if (k === '_') f.execute('moveToSubscript');
    else if (/^[\p{L}\p{N}+\-=*/<>!|,.;:'()[\]]$/u.test(k)) f.execute('insert', k === '\\' ? '\\backslash' : k);
  }
}

export function MathOverlay({ st, frame, scale, onSet, onDone, typeAhead }: {
  st: MathEditState;
  frame: HTMLIFrameElement | null;
  scale: number;
  onSet(tex: string): void;
  onDone(tex: string, dir: 'forward' | 'backward' | null): void;
  /** taken (and emptied) once the field has the keyboard */
  typeAhead?: { current: string[] | null };
}) {
  const box = useRef<HTMLDivElement>(null);
  const cb = useRef({ onSet, onDone }); cb.current = { onSet, onDone };
  const fr = frame?.getBoundingClientRect();

  useLayoutEffect(() => {
    if (!box.current) return;
    let done = false;
    let field: LyxMathField | null = null;
    const finish = (dir: 'forward' | 'backward' | null) => {
      if (done) return;
      done = true;
      cb.current.onDone(field ? stripMathDelims(field.latex) : st.tex, dir);
    };
    field = new LyxMathField({
      latex: st.display ? `\\[${st.tex}\\]` : `$${st.tex}$`,
      display: st.display,
      macros: {},
      onChange: latex => cb.current.onSet(stripMathDelims(latex)),
      onMoveOut: dir => finish(dir === 'backward' || dir === 'upward' ? 'backward' : 'forward'),
      // the focus went into the page (a click on the slide) or somewhere else that is not the toolbar
      onBlur: () => setTimeout(() => {
        const a = document.activeElement as HTMLElement | null;
        if (done || !a || a === document.body || field?.dom.contains(a) || a.closest(OURS)) return;
        finish(null);
      }, 0),
    });
    box.current.replaceChildren(field.dom);
    // a press anywhere else of the editor (not the toolbars) ends it too
    const onDown = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.(OURS)) finish(null); };
    document.addEventListener('pointerdown', onDown, true);
    const f = field;
    // the keyboard at once (typing may follow the click straight away); the cursor at the click once laid out
    f.focus(st.where);
    const keys = typeAhead?.current;
    if (typeAhead) typeAhead.current = null;
    if (keys?.length) replay(f, keys);
    if (st.at) requestAnimationFrame(() => {
      if (done) return;
      const r = frame?.getBoundingClientRect();
      if (r) f.focusAt(r.left + st.at!.x * scale, r.top + st.at!.y * scale);
    });
    return () => { document.removeEventListener('pointerdown', onDown, true); done = true; f.destroy(); };
  }, [st.id]);

  if (!fr) return null;
  return (
    <div ref={box} class={'dl-mathedit' + (st.display ? ' display' : '')} data-dl-mathedit
      style={{ left: `${fr.left + st.rect.x * scale}px`, top: `${fr.top + st.rect.y * scale}px`, minHeight: `${st.rect.h * scale}px`, fontSize: `${st.fontPx * scale}px`, color: st.color }} />
  );
}
