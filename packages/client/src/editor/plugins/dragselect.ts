/**
 * LyX-like mouse selection (a port of Text3.cpp LFUN_MOUSE_PRESS / MOTION and
 * TextMetrics::setCursorFromCoordinates).
 *
 * The browser's native drag cannot cross the formula widgets (their KaTeX DOM and hidden textarea
 * break it), ProseMirror's own mouse handling resets whatever a plugin dispatches mid-drag, and a
 * press inside an existing selection starts a drag-and-drop of that text (LyX has no such thing:
 * a press always places the cursor, a drag always selects). So every gesture that starts on text
 * — top-level or inside an inset — is owned here and dispatched synchronously:
 *
 * - click = caret, drag = selection, double click = word (a drag then extends by words), triple
 *   click = paragraph (a drag extends by paragraphs), shift click = extend from the anchor;
 * - the selection never dives deeper than the anchor's text (LyX ignores motions nested deeper
 *   than the anchor — they bubble up to the text holding the anchor): a formula, footnote, table,
 *   graphic … the pointer enters from outside is taken whole, the head landing on its closest edge
 *   (Row::Element::x2pos rounds an inset to its nearer side);
 * - conversely a drag that leaves the inset it started in continues in the surrounding text with
 *   that inset taken whole (the normalized anchor of LyX's selectionBegin/End), and shrinks back
 *   into it when the pointer returns;
 * - dragging beyond the visible part of the document scrolls it (LyX's synthetic mouse events).
 *
 * Presses on a formula editor's own DOM, inset labels and buttons, label chips, table cells (the
 * prosemirror-tables cell selection) and the tracked-change fold markers stay with their owners.
 */
import { Plugin, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node, ResolvedPos } from 'prosemirror-model';

/** node types selected as one unit when a drag or shift-click touches them */
export const ATOMS = new Set(['math_display', 'math_inline', 'macro', 'graphics', 'command', 'leaf']);

/** what a drag hangs on: a caret (from == to) or a node / inset taken whole */
export type Range = { from: number; to: number };

const OWN_WIDGETS = '.lyx-math-display, .lyx-math-inline, .lyx-macro, .lyx-inset, .lyx-tabular, .lyx-graphics';

/** every container on $p's chain, outermost first: the document, then each inset / table / cell */
function containerChain($p: ResolvedPos): number[] {
  const out = [0];
  for (let d = 1; d <= $p.depth; d++) if (!$p.node(d).isTextblock) out.push(d);
  return out;
}

/** the pointer's document position; coordinates are clamped into the visible part of the editor */
function hitAt(view: EditorView, x: number, y: number): { pos: number; inside: number } | null {
  const box = view.dom.getBoundingClientRect();
  const vis = visibleBox(view);
  x = Math.min(Math.max(x, Math.max(box.left, vis.left) + 1), Math.min(box.right, vis.right) - 1);
  y = Math.min(Math.max(y, Math.max(box.top, vis.top) + 1), Math.min(box.bottom, vis.bottom) - 1);
  const p = view.posAtCoords({ left: x, top: y });
  let inside = p ? p.inside : -1, pos: number | null = p ? p.pos : null;
  if (pos === null || inside < 0) {
    // over a widget the caret probe can fail or land beside it: resolve the widget itself
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest(OWN_WIDGETS);
    if (el && view.dom.contains(el) && el.parentElement) {
      try { inside = view.posAtDOM(el.parentElement, Array.prototype.indexOf.call(el.parentElement.childNodes, el)); } catch { inside = -1; }
      if (inside >= 0 && pos === null) pos = inside;
    }
  }
  return pos === null ? null : { pos, inside };
}

/** the part of the editor that is on screen (its scroll container minus the toolbars docked over its bottom) */
function visibleBox(view: EditorView): { left: number; top: number; right: number; bottom: number } {
  const sc = scroller(view);
  if (!sc) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const r = sc.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(sc).scrollPaddingBottom) || 0;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom - pad };
}

function scroller(view: EditorView): HTMLElement | null {
  for (let el = view.dom.parentElement; el; el = el.parentElement) {
    const o = getComputedStyle(el).overflowY;
    if (o === 'auto' || o === 'scroll') return el;
  }
  return null;
}

/**
 * The side of a node taken whole on which the head lands: LyX rounds an inset to its nearer side
 * by x. An inline inset wrapped over several lines is compared along its lines; a box of its own
 * (a display formula, a float, a table) by its nearer edge in both directions, so that a vertical
 * drag passes it at its middle.
 */
function closestEdge(view: EditorView, r: Range, x: number, y: number): number {
  const dom = view.nodeDOM(r.from) as HTMLElement | null;
  if (!dom || !dom.getClientRects) return r.from;
  const rects = Array.from(dom.getClientRects()).filter(b => b.width > 0 && b.height > 0);
  if (!rects.length) return r.from;
  if (rects.length > 1) {
    let i = 0, best = Infinity;
    rects.forEach((b, k) => { const d = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0; if (d < best) { best = d; i = k; } });
    const mid = (rects.length - 1) / 2;
    if (i < mid) return r.from;
    if (i > mid) return r.to;
    return x > (rects[i].left + rects[i].right) / 2 ? r.to : r.from;
  }
  const b = rects[0];
  if (getComputedStyle(dom).display === 'inline') return x > (b.left + b.right) / 2 ? r.to : r.from;
  const dl = Math.abs(x - b.left), dr = Math.abs(b.right - x), dt = Math.abs(y - b.top), db = Math.abs(b.bottom - y);
  return Math.min(dr, db) < Math.min(dl, dt) ? r.to : r.from;
}

/**
 * The selection of a drag anchored on `anchor` with the pointer at (x, y): the head clamped to the
 * anchor's text level (an inset off it taken whole at its closest edge), and the anchor's own
 * container taken whole when the pointer has left it.
 */
export function dragSelection(view: EditorView, anchor: Range, x: number, y: number): { anchor: number; head: number } | null {
  const hit = hitAt(view, x, y);
  if (!hit) return null;
  const doc = view.state.doc;
  if (hit.pos > doc.content.size) return null;
  const $a = doc.resolve(anchor.from), $h = doc.resolve(hit.pos);
  // the deepest container of the anchor that also holds the pointer
  const chain = containerChain($a);
  let level = 0;
  for (let i = chain.length - 1; i > 0; i--) {
    const d = chain[i];
    if (hit.pos >= $a.start(d) && hit.pos <= $a.end(d)) { level = i; break; }
  }
  const cd = chain[level];
  // the head: the first node off the anchor's text between that level and the pointer is taken whole
  let taken: Range | null = null;
  for (let d = cd + 1; d <= $h.depth; d++) {
    if (!$h.node(d).isTextblock) { taken = { from: $h.before(d), to: $h.after(d) }; break; }
  }
  if (!taken && hit.inside >= 0 && hit.inside < doc.content.size) {
    const n = doc.nodeAt(hit.inside);
    if (n && n.isInline && (ATOMS.has(n.type.name) || !n.isTextblock) && hit.pos >= hit.inside && hit.pos <= hit.inside + n.nodeSize) taken = { from: hit.inside, to: hit.inside + n.nodeSize };
  }
  const head = taken ? closestEdge(view, taken, x, y) : hit.pos;
  // the anchor: its container the pointer has left (or the node it hangs on) is taken whole
  let a = anchor;
  if (level < chain.length - 1) { const d = chain[level + 1]; a = { from: $a.before(d), to: $a.after(d) }; }
  if (a.from === a.to) return { anchor: a.from, head };
  if (head >= a.to) return { anchor: a.from, head };
  if (head <= a.from) return { anchor: a.to, head };
  return { anchor: a.from, head: a.to };
}

const isWordChar = (c?: string) => !!c && /[\p{L}\p{N}'’]/u.test(c);

/** the word around pos in its paragraph (LyX selectWord); the caret position itself when not on a word */
function wordRange(doc: Node, pos: number): Range {
  const $p = doc.resolve(pos);
  if (!$p.parent.isTextblock) return { from: pos, to: pos };
  const base = $p.start();
  // one character per position: an inset / formula / table counts as nodeSize non-word characters
  let text = '';
  $p.parent.forEach(n => { text += n.isText ? n.text! : '\0'.repeat(n.nodeSize); });
  let i = pos - base;
  if (!isWordChar(text[i]) && isWordChar(text[i - 1])) i--;
  if (!isWordChar(text[i])) return { from: pos, to: pos };
  let a = i, b = i + 1;
  while (isWordChar(text[a - 1])) a--;
  while (isWordChar(text[b])) b++;
  return { from: base + a, to: base + b };
}

function paragraphRange(doc: Node, pos: number): Range {
  const $p = doc.resolve(pos);
  if (!$p.parent.isTextblock) return { from: pos, to: pos };
  return { from: $p.start(), to: $p.end() };
}

const setSel = (view: EditorView, anchor: number, head: number) => {
  try { view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head)))); } catch { /* stale positions */ }
};

type DragOpts = {
  /** word / paragraph mode after a double / triple click: the selection grows in those units */
  unit?: 'word' | 'paragraph';
  /** the press was not ours (a press on an atom stays a ProseMirror click): only take over after a real motion */
  deferred?: boolean;
  /** pixels of motion before a deferred press becomes a drag */
  threshold?: number;
};

/**
 * Own a drag from `ev` (a mousedown) anchored on `anchor` until the mouse is released. The
 * selection follows the pointer with LyX's rules (see dragSelection), the document scrolls when
 * the pointer leaves its visible part, and the pending click is swallowed once a drag happened.
 */
export function startDrag(view: EditorView, anchor: Range, ev: MouseEvent, opts: DragOpts = {}): void {
  const sc = scroller(view);
  let dragging = !opts.deferred;
  let last: { x: number; y: number } | null = null;
  let raf = 0;
  const unitRange = (pos: number): Range => opts.unit === 'word' ? wordRange(view.state.doc, pos) : opts.unit === 'paragraph' ? paragraphRange(view.state.doc, pos) : { from: pos, to: pos };
  const apply = (x: number, y: number) => {
    const s = dragSelection(view, anchor, x, y);
    if (!s) return;
    if (opts.unit && s.anchor === anchor.from) {
      // grow by whole words / paragraphs on the head side, keeping the anchor unit
      const u = unitRange(s.head);
      if (s.head >= anchor.to) setSel(view, anchor.from, Math.max(u.to, s.head));
      else setSel(view, anchor.to, Math.min(u.from, s.head));
    } else setSel(view, s.anchor, s.head);
  };
  // dragging past the visible part of the document scrolls it, the selection following
  const autoscroll = () => {
    raf = 0;
    if (!last || !sc) return;
    const vis = visibleBox(view);
    const dy = last.y < vis.top + 16 ? last.y - (vis.top + 16) : last.y > vis.bottom - 16 ? last.y - (vis.bottom - 16) : 0;
    if (!dy) return;
    const before = sc.scrollTop;
    sc.scrollTop += Math.sign(dy) * Math.min(Math.max(2, Math.abs(dy) * 0.35), 24);
    if (sc.scrollTop !== before) apply(last.x, last.y);
    raf = requestAnimationFrame(autoscroll);
  };
  const move = (mv: MouseEvent) => {
    if (!dragging) {
      if (Math.hypot(mv.clientX - ev.clientX, mv.clientY - ev.clientY) < (opts.threshold ?? 4)) return;
      dragging = true;
      view.focus();
    }
    mv.preventDefault();
    mv.stopPropagation();   // ProseMirror's own mouse handling must not fight the drag
    last = { x: mv.clientX, y: mv.clientY };
    apply(mv.clientX, mv.clientY);
    if (!raf) raf = requestAnimationFrame(autoscroll);
  };
  const up = (uv: MouseEvent) => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    if (raf) cancelAnimationFrame(raf);
    // a drag swallows the pending click; without one, an untouched deferred mouseup completes
    // ProseMirror's click as usual
    if (dragging && opts.deferred) { uv.preventDefault(); uv.stopPropagation(); }
    if (dragging || !opts.deferred) view.focus();
  };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
}

/**
 * Continue a drag that started inside an atom and left it (a formula being dragged out of —
 * LyX's lfunMouseMotion leaves such motions to the surrounding text): the atom [from, to) stays
 * selected whole and the selection follows the pointer on either side of it.
 */
export function dragFromAtom(view: EditorView, from: number, to: number, ev: MouseEvent): void {
  view.focus();
  startDrag(view, { from, to }, ev);
  const s = dragSelection(view, { from, to }, ev.clientX, ev.clientY);
  if (s) setSel(view, s.anchor, s.head);
}

export function dragSelectPlugin(): Plugin {
  return new Plugin({
    props: {
      // LyX paints an inset that lies inside the selection wholly in the selection colour; the
      // browser cannot (the widgets are contenteditable=false islands its native selection skips),
      // so a selected formula showed nothing. Atoms and insets covered by the selection are decorated.
      decorations(state) {
        const { from, to, empty } = state.selection;
        if (empty) return null;
        const decos: Decoration[] = [];
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.isInline && !node.isText && pos >= from && pos + node.nodeSize <= to) { decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'ol-selatom' })); return false; }
          return true;
        });
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
      handleDOMEvents: {
        mousedown(view, ev) {
          if (ev.button !== 0 || view.editable === false) return false;
          const t = ev.target as HTMLElement;
          if (!t.closest?.('.lyx-editor')) return false;
          // the formula editor, inset labels / buttons, label chips, table cells (prosemirror-tables'
          // cell selection) and the tracked-change fold markers (changes.ts) handle their own mouse
          if (t.closest('.lm-field, .lm-input, .eq-labels, .eq-meta, .lyx-tabular, .inset-label, .inset-actions, .inset-anchor, .ol-change-fold')) return false;
          const start = hitAt(view, ev.clientX, ev.clientY);
          if (!start) return false;
          // shift-click: extend the selection from its anchor — a formula / inset is taken whole
          if (ev.shiftKey) {
            if (ev.detail !== 1) return false;
            ev.preventDefault();
            view.focus();
            const a = view.state.selection.anchor;
            const s = dragSelection(view, { from: a, to: a }, ev.clientX, ev.clientY);
            if (s) setSel(view, s.anchor, s.head);
            return true;
          }
          // A press on a formula / graphic / reference itself: the *click* stays with ProseMirror
          // (field upgrade, node selection, dialogs on double click) — but once the pointer travels
          // the gesture becomes ours: the atom is taken whole and the selection follows the pointer.
          if (start.inside >= 0) {
            const n = view.state.doc.nodeAt(start.inside);
            if (n && ATOMS.has(n.type.name)) {
              if (ev.detail !== 1) return false;
              startDrag(view, { from: start.inside, to: start.inside + n.nodeSize }, ev, { deferred: true, threshold: 6 });
              return false;   // the mousedown itself stays ProseMirror's (click semantics)
            }
          }
          if (ev.detail > 3) return false;
          ev.preventDefault();
          view.focus();
          // double click = word, triple click = paragraph (dispatched synchronously — the native
          // word selection arrives through selectionchange too late for an immediate Ctrl+B); a
          // drag from there grows the selection by the same unit (LyX's wordSelection)
          const unit = ev.detail === 2 ? 'word' : ev.detail === 3 ? 'paragraph' : undefined;
          const anchor = unit === 'word' ? wordRange(view.state.doc, start.pos) : unit === 'paragraph' ? paragraphRange(view.state.doc, start.pos) : { from: start.pos, to: start.pos };
          // LyX sets the cursor at the press itself (no drag-and-drop of a selection to wait for)
          if (unit) setSel(view, anchor.from, anchor.to);
          else { try { view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(start.pos)))); } catch { /* ignore */ } }
          startDrag(view, anchor, ev, { unit });
          return true;   // the gesture is ours: ProseMirror's MouseDown must not fight it
        },
      },
    },
  });
}
