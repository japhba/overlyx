/**
 * The font size box of the standard toolbar (both shells, toolbars.tsx): − / + step through
 * LaTeX's sizes (on layout pages through a point ladder), the field takes any point size, the list
 * offers the named sizes with their points at the document's base size. Works on text, table cells,
 * a formula (as a whole) and a selected text box (editor/fontsize.ts).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { applyFontSize, activeFormula, baseSize, currentSize, stepSize, sizeTable, NAMED_SIZES, NAMED_LABELS, LAYOUT_LADDER, withNodeMark, ptToSize } from '../editor/fontsize';
import { isLayoutDoc } from '../editor/layout/commands';

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function FontSizeBox({ view }: { view: EditorView }) {
  const cur = currentSize(view);
  const [text, setText] = useState(fmt(cur.pt));
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  /** the formula being edited when the field took the focus (the formula loses it to the field) */
  const formula = useRef<{ pos: number } | null>(null);
  useEffect(() => { if (!focused) setText(fmt(cur.pt)); }, [cur.pt, focused]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const apply = (pt: number) => {
    if (!(pt > 0)) return;
    const f = formula.current;
    formula.current = null;
    if (f && !activeFormula(view)) {
      // back into the formula the field took the focus from
      const node = view.state.doc.nodeAt(f.pos);
      if (node && (node.type.name === 'math_inline' || node.type.name === 'math_display')) {
        view.dispatch(view.state.tr.setNodeMarkup(f.pos, undefined, withNodeMark(node, 'size', ptToSize(pt, baseSize(view), !isLayoutDoc(view.state.doc)))));
        return;
      }
    }
    applyFontSize(view, pt);
    if (!activeFormula(view)) view.focus();
  };
  const layout = isLayoutDoc(view.state.doc);
  const base = baseSize(view);
  const table = sizeTable(base);
  return (
    <span ref={ref} class="fs-box" data-fontsize>
      <button type="button" class="tb-btn fs-step" title="Smaller (Ctrl+[ in LyX: \small, \footnotesize…)" onClick={() => apply(stepSize(view, cur.pt, -1))}>−</button>
      <input class="fs-input" value={text} inputMode="decimal" title="Font size in points (Enter applies)"
        onMouseDown={() => { formula.current = activeFormula(view); }}
        onFocus={e => { setFocused(true); (e.target as HTMLInputElement).select(); }}
        onBlur={() => setFocused(false)}
        onInput={e => setText((e.target as HTMLInputElement).value)}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); apply(Number(text.replace(',', '.'))); (e.target as HTMLInputElement).blur(); }
          else if (e.key === 'Escape') { setText(fmt(cur.pt)); (e.target as HTMLInputElement).blur(); view.focus(); }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const v = stepSize(view, Number(text) || cur.pt, e.key === 'ArrowUp' ? 1 : -1); setText(fmt(v)); apply(v); }
        }} />
      <button type="button" class="tb-btn fs-drop" title="Font sizes" onClick={() => setOpen(o => !o)}>▾</button>
      <button type="button" class="tb-btn fs-step" title="Larger" onClick={() => apply(stepSize(view, cur.pt, 1))}>+</button>
      {open && (
        <div class="tb-popup list fs-list" role="menu">
          {!layout && <div class="tb-popup-title">LaTeX sizes at {fmt(base)} pt</div>}
          {!layout && NAMED_SIZES.map((n, i) => (
            <button key={n} type="button" class={'tb-pal-item' + (Math.abs(table[i] - cur.pt) < 0.05 ? ' active' : '')} onMouseDown={e => e.preventDefault()} onClick={() => { setOpen(false); apply(table[i]); }}>
              <span class="tb-pal-label">{NAMED_LABELS[n]}</span><span class="fs-pt">{fmt(table[i])} pt</span>
            </button>
          ))}
          {layout && <div class="tb-popup-title">Point sizes</div>}
          {layout && LAYOUT_LADDER.map(v => (
            <button key={v} type="button" class={'tb-pal-item' + (Math.abs(v - cur.pt) < 0.05 ? ' active' : '')} onMouseDown={e => e.preventDefault()} onClick={() => { setOpen(false); apply(v); }}>
              <span class="tb-pal-label" style={{ fontSize: `${Math.min(22, 9 + v / 6)}px` }}>{v}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
