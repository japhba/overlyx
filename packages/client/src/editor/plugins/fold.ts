/**
 * Section folding, Google-Docs style. A heading (Part … Subparagraph, numbered or starred) folds
 * away everything up to the next heading of the same or a higher level: an arrow left of the
 * heading (shown on hover, always shown while folded) toggles it; View ▸ Fold all sections /
 * Expand all sections, and the right-click menu on a heading, do the same for all of them.
 *
 * Folding is a way of looking at the document, never a change of it: no step touches the document
 * (collaborators and the .tex file are unaffected), the folded headings are remembered per
 * document in this browser, and whatever puts the cursor into folded-away text — find, the
 * outline, a jump to a label, Back — unfolds that section first.
 *
 * The folded headings are kept as positions and mapped through every transaction. A
 * collaborator's change arrives from y-prosemirror as a replacement of the whole document, which
 * deletes every position; y-prosemirror keeps the node objects of unchanged paragraphs, so such a
 * heading is found again by identity, and a recreated one by its layout and text.
 */
import { Plugin, PluginKey, Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { sectionLevel } from '../layouts';
import { viewDocId } from '../context';

export interface FoldState { /** document positions of the folded headings, ascending */ folded: readonly number[]; decos: DecorationSet }
export const foldKey = new PluginKey<FoldState>('lyx-fold');

type FoldMeta = { fold: number[] } | { unfold: number[] } | { set: number[] };

/** A top-level heading and the section it opens: the body is every child after it, up to `end` (exclusive). */
export interface FoldHeading { pos: number; index: number; level: number; node: PMNode; /** doc position where the section ends */ end: number; endIndex: number }

const levelOf = (n: PMNode): number | null => (n.type.name === 'paragraph' ? sectionLevel(String(n.attrs.layout)) : null);
const bodyStart = (h: FoldHeading) => h.pos + h.node.nodeSize;
const hasBody = (h: FoldHeading) => h.endIndex > h.index + 1;

/** The document's top-level headings with the extent of their sections. */
export function foldHeadings(doc: PMNode): FoldHeading[] {
  const out: FoldHeading[] = [];
  const open: FoldHeading[] = [];
  doc.forEach((child, offset, index) => {
    const level = levelOf(child);
    if (level === null) return;
    while (open.length && open[open.length - 1].level >= level) { const h = open.pop()!; h.end = offset; h.endIndex = index; }
    const h: FoldHeading = { pos: offset, index, level, node: child, end: doc.content.size, endIndex: doc.childCount };
    out.push(h);
    open.push(h);
  });
  return out;
}

/** The folded headings whose hidden body contains position `x` (outermost first). */
function hidingAt(heads: FoldHeading[], folded: ReadonlySet<number>, x: number): FoldHeading[] {
  return heads.filter(h => folded.has(h.pos) && hasBody(h) && x > bodyStart(h) && x < h.end);
}

/** top-level children hidden by the folds: [from, to) document ranges, merged */
function hiddenRanges(heads: FoldHeading[], folded: ReadonlySet<number>): [number, number][] {
  const out: [number, number][] = [];
  for (const h of heads) {
    if (!folded.has(h.pos) || !hasBody(h)) continue;
    const r: [number, number] = [bodyStart(h), h.end];
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push(r);
  }
  return out;
}

const CHEVRON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 6l3.5 4 3.5-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function toggleWidget(closed: boolean, body: boolean, hidden: number) {
  return (view: EditorView, getPos: () => number | undefined): HTMLElement => {
    const el = document.createElement('span');
    el.className = 'lyx-fold-toggle' + (closed ? ' closed' : '') + (body ? '' : ' empty');
    el.contentEditable = 'false';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-expanded', String(!closed));
    el.setAttribute('data-fold-toggle', '');
    el.title = closed ? `Expand this section (${hidden} hidden paragraph${hidden === 1 ? '' : 's'})` : body ? 'Fold this section' : 'Nothing to fold: the section is empty';
    el.innerHTML = CHEVRON;
    el.addEventListener('mousedown', ev => {
      ev.preventDefault(); ev.stopPropagation();
      const p = getPos();
      if (p === undefined || ev.button !== 0) return;
      setSectionFolded(p - 1, 'toggle')(view.state, view.dispatch, view);
    });
    return el;
  };
}

function buildDecos(doc: PMNode, folded: readonly number[]): DecorationSet {
  const heads = foldHeadings(doc);
  if (!heads.length) return DecorationSet.empty;
  const set = new Set(folded);
  const decos: Decoration[] = [];
  for (const h of heads) {
    const closed = set.has(h.pos);
    const body = hasBody(h);
    const hidden = closed ? h.endIndex - h.index - 1 : 0;
    decos.push(Decoration.widget(h.pos + 1, toggleWidget(closed, body, hidden), {
      side: -1, ignoreSelection: true, stopEvent: () => true, key: `fold:${closed ? 'c' : 'o'}:${body ? hidden || 'b' : 'e'}`,
    }));
    if (closed) decos.push(Decoration.node(h.pos, bodyStart(h), { class: 'lyx-fold-closed' }));
  }
  const ranges = hiddenRanges(heads, set);
  if (ranges.length) {
    doc.forEach((child, offset) => {
      if (ranges.some(([a, b]) => offset >= a && offset < b)) decos.push(Decoration.node(offset, offset + child.nodeSize, { class: 'lyx-fold-hidden' }));
    });
  }
  return DecorationSet.create(doc, decos);
}

/** The folded positions after a document change (see the module comment). */
function remap(folded: readonly number[], tr: Transaction, oldDoc: PMNode, newDoc: PMNode): number[] {
  const out = new Set<number>();
  let byNode: Map<PMNode, number> | null = null;
  let heads: FoldHeading[] | null = null;
  for (const p of folded) {
    const old = oldDoc.nodeAt(p);
    const r = tr.mapping.mapResult(p, 1);
    let np: number | undefined;
    if (!r.deleted && newDoc.resolve(r.pos).depth === 0) {
      const n = newDoc.nodeAt(r.pos);
      if (n && levelOf(n) !== null) np = r.pos;
    }
    if (np === undefined && old) {
      if (!byNode) { byNode = new Map(); newDoc.forEach((c, off) => { if (levelOf(c) !== null && !byNode!.has(c)) byNode!.set(c, off); }); }
      np = byNode.get(old);
    }
    if (np === undefined && old && levelOf(old) !== null) {
      heads ??= foldHeadings(newDoc);
      const same = heads.filter(h => h.node.attrs.layout === old.attrs.layout && h.node.textContent === old.textContent);
      if (same.length) np = same.reduce((a, b) => (Math.abs(b.pos - r.pos) < Math.abs(a.pos - r.pos) ? b : a)).pos;
    }
    if (np !== undefined) out.add(np);
  }
  return [...out].sort((a, b) => a - b);
}

/** A cursor or a selection inside folded-away text unfolds the sections that hide it; a selection from visible text into a fold (Select All) does not. */
function reveal(folded: readonly number[], state: EditorState): readonly number[] {
  const heads = foldHeadings(state.doc);
  const set = new Set(folded);
  const { head, anchor, empty } = state.selection;
  const hiding = hidingAt(heads, set, head);
  if (!hiding.length) return folded;
  if (!empty && !hidingAt(heads, set, anchor).length) return folded;
  const drop = new Set(hiding.map(h => h.pos));
  return folded.filter(p => !drop.has(p));
}

export function foldPlugin(): Plugin<FoldState> {
  return new Plugin<FoldState>({
    key: foldKey,
    state: {
      init: (_config, state) => ({ folded: [], decos: buildDecos(state.doc, []) }),
      apply(tr, prev, oldState, newState) {
        let folded = prev.folded;
        if (tr.docChanged && folded.length) folded = remap(folded, tr, oldState.doc, newState.doc);
        const meta = tr.getMeta(foldKey) as FoldMeta | undefined;
        if (meta) {
          const heads = new Set(foldHeadings(newState.doc).map(h => h.pos));
          if ('set' in meta) folded = meta.set.filter(p => heads.has(p));
          else if ('fold' in meta) folded = [...new Set([...folded, ...meta.fold.filter(p => heads.has(p))])];
          else folded = folded.filter(p => !meta.unfold.includes(p));
          folded = [...folded].sort((a, b) => a - b);
        }
        if (folded.length && (tr.selectionSet || tr.docChanged)) folded = reveal(folded, newState);
        if (!tr.docChanged && folded === prev.folded) return prev;
        if (!tr.docChanged && folded.length === prev.folded.length && folded.every((p, i) => p === prev.folded[i])) return prev;
        return { folded, decos: buildDecos(newState.doc, folded) };
      },
    },
    props: {
      decorations: state => foldKey.getState(state)?.decos ?? null,
      // ↑ / ↓ at the edge of a line beside a fold go to the next visible line (ProseMirror would
      // otherwise select a hidden formula or table there, and unfold the section)
      handleKeyDown(view, ev) {
        if ((ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return false;
        const st = foldKey.getState(view.state);
        if (!st?.folded.length) return false;
        const sel = view.state.selection;
        if (!sel.empty || sel.$head.depth !== 1) return false;
        const dir = ev.key === 'ArrowDown' ? 1 : -1;
        if (!view.endOfTextblock(dir > 0 ? 'down' : 'up')) return false;
        const doc = view.state.doc;
        const index = sel.$head.index(0);
        const heads = foldHeadings(doc);
        const ranges = hiddenRanges(heads, new Set(st.folded));
        const hiddenChild = (i: number) => { let off = 0; for (let k = 0; k < i; k++) off += doc.child(k).nodeSize; return ranges.some(([a, b]) => off >= a && off < b); };
        let i = index + dir;
        if (i < 0 || i >= doc.childCount || !hiddenChild(i)) return false;
        while (i >= 0 && i < doc.childCount && hiddenChild(i)) i += dir;
        if (i < 0 || i >= doc.childCount) return true;   // only folded text beyond: stay
        let off = 0;
        for (let k = 0; k < i; k++) off += doc.child(k).nodeSize;
        const target = dir > 0 ? Selection.findFrom(doc.resolve(off), 1) : Selection.findFrom(doc.resolve(off + doc.child(i).nodeSize), -1);
        if (!target) return false;
        view.dispatch(view.state.tr.setSelection(target).scrollIntoView());
        return true;
      },
    },
    view(view) {
      let restored = false;
      let last = foldKey.getState(view.state)?.folded ?? [];
      return {
        update(v, prev) {
          const st = foldKey.getState(v.state);
          if (!st) return;
          if (!restored && v.state.doc !== prev.doc && foldHeadings(v.state.doc).length) {
            restored = true;
            // after this update (the first content usually arrives inside y-prosemirror's own dispatch)
            const docId = viewDocId(v);
            void Promise.resolve().then(() => {
              if (v.isDestroyed) return;
              // a remembered fold stays open where the cursor already is (it was put back there, or moved meanwhile)
              const heads = foldHeadings(v.state.doc);
              const saved = loadFolds(docId, v.state.doc);
              const hiding = new Set(hidingAt(heads, new Set(saved), v.state.selection.head).map(h => h.pos));
              const keep = saved.filter(p => !hiding.has(p));
              if (keep.length) v.dispatch(foldTransaction(v.state, { set: keep }));
            });
            return;
          }
          if (st.folded !== last) { last = st.folded; if (restored || st.folded.length) { restored = true; saveFolds(viewDocId(v), v.state.doc, st.folded); } }
        },
      };
    },
  });
}

/* ------------------------------------------------------------------ commands */

/** A fold transaction; a cursor that would end up hidden moves to the end of the outermost heading folding it. */
function foldTransaction(state: EditorState, meta: FoldMeta): Transaction {
  const tr = state.tr.setMeta(foldKey, meta).setMeta('addToHistory', false);
  if ('unfold' in meta) return tr;
  const heads = foldHeadings(state.doc);
  const cur = new Set(foldKey.getState(state)?.folded ?? []);
  const next = 'set' in meta ? new Set(meta.set) : new Set([...cur, ...meta.fold]);
  const hiding = hidingAt(heads, next, state.selection.head);
  if (hiding.length) tr.setSelection(TextSelection.create(state.doc, bodyStart(hiding[0]) - 1));
  return tr;
}

/** the heading at or above `pos` (the section it is in), or null */
function headingAt(doc: PMNode, pos: number): FoldHeading | null {
  const heads = foldHeadings(doc);
  let best: FoldHeading | null = null;
  for (const h of heads) if (h.pos <= pos && pos < h.end) best = h;   // the innermost: later headings nest deeper
  return best;
}

/** Fold / unfold / toggle the section of the heading at `pos` (or, not a heading, the section `pos` is in). */
export function setSectionFolded(pos: number, how: boolean | 'toggle'): Command {
  return (state, dispatch) => {
    const h = headingAt(state.doc, pos);
    if (!h) return false;
    const folded = foldKey.getState(state)?.folded.includes(h.pos) ?? false;
    const fold = how === 'toggle' ? !folded : how;
    if (fold === folded || (fold && !hasBody(h))) return false;
    dispatch?.(foldTransaction(state, fold ? { fold: [h.pos] } : { unfold: [h.pos] }));
    return true;
  };
}

/** Fold or expand the section the cursor is in (View ▸ Fold / expand this section). */
export const toggleSectionAtCursor: Command = (state, dispatch, view) => setSectionFolded(state.selection.head, 'toggle')(state, dispatch, view);

/** the section at the cursor: folded or not (the right-click menu's label); null outside a section */
export function sectionFoldState(state: EditorState, pos = state.selection.head): { folded: boolean; foldable: boolean } | null {
  const h = headingAt(state.doc, pos);
  if (!h) return null;
  return { folded: foldKey.getState(state)?.folded.includes(h.pos) ?? false, foldable: hasBody(h) };
}

/** View ▸ Fold all sections: every heading with something under it (Google Docs' Collapse all headings). */
export const foldAllSections: Command = (state, dispatch) => {
  const all = foldHeadings(state.doc).filter(hasBody).map(h => h.pos);
  if (!all.length) return false;
  dispatch?.(foldTransaction(state, { set: all }));
  return true;
};

/** View ▸ Expand all sections. */
export const unfoldAllSections: Command = (state, dispatch) => {
  if (!foldKey.getState(state)?.folded.length) return false;
  dispatch?.(foldTransaction(state, { set: [] }));
  return true;
};

/** how many sections are folded (menus enable Expand all with it) */
export const foldedCount = (state: EditorState): number => foldKey.getState(state)?.folded.length ?? 0;

/* ------------------------------------------------------------------ remembered per document */

interface SavedFold { l: string; t: string; n: number }
const storageKey = (docId: string) => 'ol.fold:' + docId;

function saveFolds(docId: string, doc: PMNode, folded: readonly number[]): void {
  if (!docId) return;
  try {
    if (!folded.length) { localStorage.removeItem(storageKey(docId)); return; }
    const heads = foldHeadings(doc);
    const seen = new Map<string, number>();
    const out: SavedFold[] = [];
    for (const h of heads) {
      const k = h.node.attrs.layout + '\n' + h.node.textContent;
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      if (folded.includes(h.pos)) out.push({ l: String(h.node.attrs.layout), t: h.node.textContent, n });
    }
    localStorage.setItem(storageKey(docId), JSON.stringify(out));
  } catch { /* storage unavailable */ }
}

function loadFolds(docId: string, doc: PMNode): number[] {
  if (!docId) return [];
  let saved: SavedFold[] = [];
  try { saved = JSON.parse(localStorage.getItem(storageKey(docId)) ?? '[]'); } catch { return []; }
  if (!Array.isArray(saved) || !saved.length) return [];
  const heads = foldHeadings(doc);
  const seen = new Map<string, number>();
  const out: number[] = [];
  for (const h of heads) {
    const k = h.node.attrs.layout + '\n' + h.node.textContent;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    if (hasBody(h) && saved.some(s => s.l === h.node.attrs.layout && s.t === h.node.textContent && s.n === n)) out.push(h.pos);
  }
  return out;
}
