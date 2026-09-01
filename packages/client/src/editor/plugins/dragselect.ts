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
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

/** node types selected as one unit when a drag or shift-click touches them */
export const ATOMS = new Set(['math_display', 'math_inline', 'macro', 'graphics', 'command', 'leaf']);

function headOver(view: EditorView, x: number, y: number, anchor: number): number | null {
  // clamp into the editor: posAtCoords has nothing for coordinates outside it, and a drag that
  // strayed into the margins or over a panel used to stall the selection
  const box = view.dom.getBoundingClientRect();
  x = Math.min(Math.max(x, box.left + 1), box.right - 1);
  y = Math.min(Math.max(y, box.top + 1), box.bottom - 1);
  const p = view.posAtCoords({ left: x, top: y });
  let inside = p ? p.inside : -1, pos: number | null = p ? p.pos : null;
  if (pos === null || inside < 0) {
    // over a formula widget the caret probe can fail or land beside it: resolve the widget itself
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.lyx-math-display, .lyx-math-inline, .lyx-macro');
    if (el && view.dom.contains(el) && el.parentElement) {
      try { inside = view.posAtDOM(el.parentElement, Array.prototype.indexOf.call(el.parentElement.childNodes, el)); } catch { inside = -1; }
      if (inside >= 0 && pos === null) pos = inside;
    }
  }
  if (pos === null) return null;
  if (inside >= 0) {
    const n = view.state.doc.nodeAt(inside);
    if (n && ATOMS.has(n.type.name)) return pos >= anchor ? inside + n.nodeSize : inside;
  }
  return pos;
}

/**
 * Continue a drag that started inside an atom and left it (a formula being dragged out of —
 * LyX's lfunMouseMotion leaves such motions to the surrounding text): the atom [from, to) stays
 * selected whole and the selection follows the pointer on either side of it.
 */
export function dragFromAtom(view: EditorView, from: number, to: number, ev: MouseEvent): void {
  view.focus();
  const move = (mv: MouseEvent) => {
    mv.preventDefault();
    const head = headOver(view, mv.clientX, mv.clientY, from);
    if (head === null) return;
    if (head >= to) setSel(view, from, head);
    else if (head <= from) setSel(view, to, head);
    else setSel(view, from, to);
  };
  const up = () => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    view.focus();
  };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
  move(ev);
}

const setSel = (view: EditorView, from: number, to: number) => {
  try { view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(from), view.state.doc.resolve(to)))); } catch { /* stale positions */ }
};

export function dragSelectPlugin(): Plugin {
  return new Plugin({
    props: {
      // LyX paints an inset that lies inside the selection wholly in the selection colour; the
      // browser cannot (the widgets are contenteditable=false islands its native selection skips),
      // so a selected formula showed nothing. Atoms covered by the selection are decorated instead.
      decorations(state) {
        const { from, to, empty } = state.selection;
        if (empty) return null;
        const decos: Decoration[] = [];
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (ATOMS.has(node.type.name) && pos >= from && pos + node.nodeSize <= to) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'ol-selatom' }));
          return true;
        });
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
      handleDOMEvents: {
        mousedown(view, ev) {
          if (ev.button !== 0 || view.editable === false) return false;
          const t = ev.target as HTMLElement;
          if (!t.closest?.('.lyx-editor')) return false;
          // the formula editor, collapsible insets, tables, label chips and the tracked-change
          // fold markers (changes.ts) handle their own mouse
          if (t.closest('.lm-field, .lm-input, .eq-labels, .eq-meta, .lyx-tabular, .lyx-inset, .ol-change-fold')) return false;
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
          // A press on a formula / graphic itself: the *click* stays with ProseMirror (field
          // upgrade, node selection, dialogs) — but the browser's default drag from an atom is
          // exactly the broken path, so once the pointer travels the gesture becomes ours: the
          // atom is taken whole and the selection follows the pointer, and the pending click is
          // swallowed so the formula does not pop open mid-drag.
          if (start.inside >= 0) {
            const n = view.state.doc.nodeAt(start.inside);
            if (n && ATOMS.has(n.type.name)) {
              if (ev.detail !== 1) return false;
              const from = start.inside, to = start.inside + n.nodeSize;
              let took = false;
              const move = (mv: MouseEvent) => {
                if (!took) {
                  if (Math.hypot(mv.clientX - ev.clientX, mv.clientY - ev.clientY) < 6) return;
                  took = true;
                  view.focus();
                }
                mv.preventDefault();
                mv.stopPropagation();   // ProseMirror's own mouse handling must not fight the drag
                const head = headOver(view, mv.clientX, mv.clientY, from);
                if (head === null) return;
                if (head >= to) setSel(view, from, head);
                else if (head <= from) setSel(view, to, head);
                else setSel(view, from, to);
              };
              const up = (uv: MouseEvent) => {
                window.removeEventListener('mousemove', move, true);
                window.removeEventListener('mouseup', up, true);
                if (took) { uv.preventDefault(); uv.stopPropagation(); view.focus(); }
                // without a drag, the untouched mouseup completes ProseMirror's click as usual
              };
              window.addEventListener('mousemove', move, true);
              window.addEventListener('mouseup', up, true);
              return false;   // the mousedown itself stays ProseMirror's (click semantics)
            }
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
