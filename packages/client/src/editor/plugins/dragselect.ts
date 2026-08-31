/**
 * LyX-like mouse selection. The browser's native drag cannot cross the formula widgets (their
 * KaTeX DOM and hidden textarea break it: the selection used to stop at a display equation, or
 * jump far past it), and ProseMirror's internal mouse handling resets whatever a plugin dispatches
 * mid-drag. So gestures that start on top-level text are owned here completely and dispatched
 * synchronously: click = caret, drag = TextSelection that takes a formula under the pointer as a
 * whole, double click = word, triple click = paragraph, shift click = extend (formulas included).
 * Clicks and drags on the formulas and other atoms themselves, inside collapsible insets and
 * tables, and dragging an existing selection stay with ProseMirror and the browser.
 */
import { Plugin, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

/** node types selected as one unit when a drag or shift-click touches them */
const ATOMS = new Set(['math_display', 'math_inline', 'macro', 'graphics', 'command', 'leaf']);

function headOver(view: EditorView, x: number, y: number, anchor: number): number | null {
  const p = view.posAtCoords({ left: x, top: y });
  if (!p) return null;
  if (p.inside >= 0) {
    const n = view.state.doc.nodeAt(p.inside);
    if (n && ATOMS.has(n.type.name)) return p.pos >= anchor ? p.inside + n.nodeSize : p.inside;
  }
  return p.pos;
}

const setSel = (view: EditorView, from: number, to: number) => {
  try { view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(from), view.state.doc.resolve(to)))); } catch { /* stale positions */ }
};

export function dragSelectPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown(view, ev) {
          if (ev.button !== 0 || view.editable === false) return false;
          const t = ev.target as HTMLElement;
          if (!t.closest?.('.lyx-editor')) return false;
          // the formula editor, collapsible insets, tables and label chips handle their own mouse
          if (t.closest('.lm-field, .lm-input, .eq-labels, .eq-meta, .lyx-tabular, .lyx-inset')) return false;
          const start = view.posAtCoords({ left: ev.clientX, top: ev.clientY });
          if (!start) return false;
          // shift-click: extend the selection from its anchor — a formula is taken whole
          if (ev.shiftKey) {
            if (ev.detail !== 1) return false;
            ev.preventDefault();
            view.focus();
            const anchor = view.state.selection.anchor;
            const head = headOver(view, ev.clientX, ev.clientY, anchor);
            if (head !== null) setSel(view, anchor, head);
            return true;
          }
          // clicks and drags on a formula / graphic itself: ProseMirror's node handling (field upgrade, dialogs …)
          if (start.inside >= 0) {
            const n = view.state.doc.nodeAt(start.inside);
            if (n && ATOMS.has(n.type.name)) return false;
          }
          // double click = word, triple click = paragraph (dispatched synchronously — the native
          // word selection arrives through selectionchange too late for an immediate Ctrl+B)
          if (ev.detail === 2 || ev.detail === 3) {
            ev.preventDefault();
            view.focus();
            const $p = view.state.doc.resolve(start.pos);
            const base = $p.start();
            if (ev.detail === 3) { setSel(view, base, base + $p.parent.content.size); return true; }
            const text = $p.parent.textBetween(0, $p.parent.content.size, '\0', '\0');
            const isw = (c?: string) => !!c && /[\p{L}\p{N}'’]/u.test(c);
            let i = start.pos - base;
            if (!isw(text[i]) && isw(text[i - 1])) i--;
            if (isw(text[i])) {
              let a = i, b = i + 1;
              while (isw(text[a - 1])) a--;
              while (isw(text[b])) b++;
              setSel(view, base + a, base + b);
            } else setSel(view, start.pos, start.pos);
            return true;
          }
          if (ev.detail !== 1) return false;
          // press inside the current selection: the native drag-and-drop of that selection
          const s0 = view.state.selection;
          if (!s0.empty && start.pos > s0.from && start.pos < s0.to) return false;
          ev.preventDefault();
          view.focus();
          const anchor = start.pos;
          let dragging = false;
          const move = (mv: MouseEvent) => {
            if (!dragging && Math.hypot(mv.clientX - ev.clientX, mv.clientY - ev.clientY) < 4) return;
            const head = headOver(view, mv.clientX, mv.clientY, anchor);
            if (head === null) return;
            dragging = true;
            mv.preventDefault();
            setSel(view, anchor, head);
          };
          const up = () => {
            window.removeEventListener('mousemove', move, true);
            window.removeEventListener('mouseup', up, true);
            if (!dragging) {
              try { view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(anchor)))); } catch { /* ignore */ }
            }
            view.focus();
          };
          window.addEventListener('mousemove', move, true);
          window.addEventListener('mouseup', up, true);
          return true;   // the gesture is ours: ProseMirror's MouseDown must not fight it
        },
      },
    },
  });
}
