/**
 * Section folding, Google-Docs style. A heading (Part … Subparagraph, numbered or starred) folds
 * away everything up to the next heading of the same or a higher level: an arrow left of the
 * heading (shown on hover, always shown while folded) toggles it; a right-click on the arrow — and
 * the text's right-click menu (Sections), and the View menu — fold or expand this section, every
 * heading of its level (all subsections, say), or all of them.
 *
 * Folding is a way of looking at the document, never a change of it: no step touches the document
 * (collaborators and the .tex file are unaffected), and whatever puts the cursor into folded-away
 * text — find, the outline, a jump to a label, Back — unfolds that section first. The folds are
 * the user's: kept with the account per document (/api/docs/<id>/folds — every browser, every
 * device), cached in the browser for offline use and a quick start; the newer of the two wins
 * when a document opens. A fold never moves what the reader looks at: the heading clicked (or the
 * block at the top of the view) stays where it is on screen (dispatchInPlace).
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
import { editorContext, viewDocId } from '../context';
import { showContextMenu, type MenuItem } from '../contextmenu';
import { api, API_BASE, type SavedFold } from '../../api';

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
    el.title = (closed ? `Expand this section (${hidden} hidden paragraph${hidden === 1 ? '' : 's'})` : body ? 'Fold this section' : 'Nothing to fold: the section is empty') + ' — right-click: fold or expand all of this level, or all';
    el.innerHTML = CHEVRON;
    el.addEventListener('mousedown', ev => {
      ev.preventDefault(); ev.stopPropagation();
      const p = getPos();
      if (p === undefined || ev.button !== 0) return;
      setSectionFolded(p - 1, 'toggle')(view.state, view.dispatch, view);
    });
    // right-click: this section, all of its level, all
    el.addEventListener('contextmenu', ev => {
      ev.preventDefault(); ev.stopPropagation();
      const p = getPos();
      if (p === undefined) return;
      showContextMenu(ev.clientX, ev.clientY, foldMenuItems(view, p - 1));
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
    view() {
      let restored = false;
      let lastFolded: readonly number[] = [];
      let lastJson = '[]';
      let applying = false;   // folds being put back from storage: not a change of the user's
      let touched = false;    // the user changed the folds since the document opened (a late answer from the server must not undo that)
      let pushTimer: ReturnType<typeof setTimeout> | undefined;
      let pending: { docId: string; rec: FoldRecord } | null = null;
      const push = (leaving = false) => {
        clearTimeout(pushTimer);
        const p = pending;
        pending = null;
        if (!p) return;
        if (leaving) { sendFoldsOnLeave(p.docId, p.rec); return; }
        api.setFolds(p.docId, p.rec.folds, p.rec.at).catch(() => { /* offline: the browser's copy is newer and goes up the next time */ });
      };
      // the tab closes or goes to the background with a change still waiting: send it now, in a request that outlives the page
      const onHide = (e: Event) => { if (e.type === 'pagehide' || document.visibilityState === 'hidden') push(true); };
      document.addEventListener('visibilitychange', onHide);
      window.addEventListener('pagehide', onHide);
      /** saved folds applied to the document (a fold hiding the cursor stays open: it was put back there, or moved meanwhile) */
      const putBack = (v: EditorView, saved: SavedFold[]) => {
        const heads = foldHeadings(v.state.doc);
        const want = matchSaved(heads, saved);
        const hiding = new Set(hidingAt(heads, new Set(want), v.state.selection.head).map(h => h.pos));
        const keep = want.filter(p => !hiding.has(p));
        if (!keep.length && !(foldKey.getState(v.state)?.folded.length)) return;
        applying = true;
        try { dispatchInPlace(v, foldTransaction(v.state, { set: keep }), null); } finally { applying = false; }
      };
      return {
        update(v, prev) {
          const st = foldKey.getState(v.state);
          if (!st) return;
          if (!restored) {
            if (v.state.doc === prev.doc || !foldHeadings(v.state.doc).length) return;
            restored = true;
            const docId = viewDocId(v);
            // after this update (the first content usually arrives inside y-prosemirror's own dispatch)
            void Promise.resolve().then(() => {
              if (v.isDestroyed) return;
              const local = readLocal(docId);
              if (local?.folds.length) putBack(v, local.folds);
              if (!accountSync()) return;
              api.folds(docId).then(r => {
                if (v.isDestroyed || touched) return;
                if (r.at > (local?.at ?? 0)) { writeLocal(docId, r); putBack(v, r.folds); }
                else if (local && local.at > r.at) api.setFolds(docId, local.folds, local.at).catch(() => { /* next time */ });
              }).catch(() => { /* offline: the browser's copy stands */ });
            });
            return;
          }
          if (st.folded === lastFolded) return;
          lastFolded = st.folded;
          // positions move with every keystroke; what is stored (the headings' layout and text) seldom does
          const folds = serializeFolds(v.state.doc, st.folded);
          const json = JSON.stringify(folds);
          if (json === lastJson) return;
          lastJson = json;
          if (applying) return;
          touched = true;
          const docId = viewDocId(v);
          const rec: FoldRecord = { at: Date.now(), folds };
          writeLocal(docId, rec);
          if (!accountSync()) return;
          pending = { docId, rec };
          clearTimeout(pushTimer);
          pushTimer = setTimeout(push, 500);
        },
        destroy() {
          document.removeEventListener('visibilitychange', onHide);
          window.removeEventListener('pagehide', onHide);
          push(true);
        },
      };
    },
  });
}

/* ------------------------------------------------------------------ in place: nothing jumps */

/** The editor's scrolling ancestor (the web client's .editor-scroll), or the page. */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
/** blank space added below the document so a fold near its end can keep the view where it was */
const spacers = new WeakMap<EditorView, number>();

/**
 * The element to hold still on screen: the anchor heading (the one clicked) when it is in view — or,
 * folded away by this change, the outermost heading folding it; otherwise the first block in view
 * that stays visible (a fold-all keeps the heading one is looking at), failing that the heading that
 * folds away the first block in view.
 */
function anchorElement(view: EditorView, after: EditorState, anchorPos: number | null, top: number, bottom: number): HTMLElement | null {
  const folded = new Set(foldKey.getState(after)?.folded ?? []);
  const heads = foldHeadings(after.doc);
  const shownAs = (pos: number) => { const hid = hidingAt(heads, folded, pos + 1); return hid.length ? hid[0].pos : pos; };
  const dom = (pos: number) => { const d = view.nodeDOM(pos); return d instanceof HTMLElement ? d : null; };
  const inView = (el: HTMLElement | null) => { if (!el || !el.getClientRects().length) return false; const r = el.getBoundingClientRect(); return r.bottom > top + 1 && r.top < bottom; };
  if (anchorPos !== null && inView(dom(anchorPos))) {
    const el = dom(shownAs(anchorPos));
    if (inView(el)) return el;
  }
  let firstInView: number | null = null, staying: number | null = null, done = false;
  view.state.doc.forEach((_child, off) => {
    if (done) return;
    const el = dom(off);
    if (!el || !el.getClientRects().length) return;
    const r = el.getBoundingClientRect();
    if (r.bottom <= top + 1) return;
    if (r.top >= bottom) { done = true; return; }
    if (firstInView === null) firstInView = off;
    if (!hidingAt(heads, folded, off + 1).length) { staying = off; done = true; }
  });
  if (staying !== null) return dom(staying);
  return firstInView === null ? null : dom(shownAs(firstInView));
}

/**
 * Dispatch a fold change without moving what the reader looks at (see anchorElement). The browser
 * clamps the scroll position the moment the document gets shorter, so the document first gets a
 * generous blank end, the anchor is put back where it was, and the blank end is then trimmed to
 * what that position needs (a fold near the end keeps some; it goes again with the next fold change
 * once the text is long enough).
 */
function dispatchInPlace(view: EditorView, tr: Transaction, anchorPos: number | null): void {
  if (!view.dom.isConnected) { view.dispatch(tr); return; }
  const scroller = scrollParent(view.dom);
  const page = scroller === document.scrollingElement || scroller === document.documentElement;
  const box = page ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
  const el = anchorElement(view, view.state.apply(tr), anchorPos, box.top, box.bottom);
  if (!el) { view.dispatch(tr); return; }
  const before = el.getBoundingClientRect().top;
  const roomy = (spacers.get(view) ?? 0) + scroller.scrollHeight;
  // the browser's own scroll anchoring would move the view as well (it compensates what folds away above)
  const anchoring = scroller.style.overflowAnchor;
  scroller.style.overflowAnchor = 'none';
  view.dom.style.paddingBottom = roomy + 'px';
  view.dispatch(tr);
  if (el.isConnected) scroller.scrollTop += el.getBoundingClientRect().top - before;
  const content = scroller.scrollHeight - roomy;   // the document's own height below the scroll origin
  const need = Math.max(0, Math.ceil(scroller.scrollTop + scroller.clientHeight - content));
  spacers.set(view, need);
  view.dom.style.paddingBottom = need ? need + 'px' : '';
  void scroller.scrollTop;   // lay out now, with the browser's anchoring still off
  requestAnimationFrame(() => { scroller.style.overflowAnchor = anchoring; });
}
/** a command's dispatch: in place when there is a view */
function send(tr: Transaction, dispatch: ((tr: Transaction) => void) | undefined, view: EditorView | undefined, anchorPos: number | null): void {
  if (!dispatch) return;
  if (view) dispatchInPlace(view, tr, anchorPos); else dispatch(tr);
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
  return (state, dispatch, view) => {
    const h = headingAt(state.doc, pos);
    if (!h) return false;
    const folded = foldKey.getState(state)?.folded.includes(h.pos) ?? false;
    const fold = how === 'toggle' ? !folded : how;
    if (fold === folded || (fold && !hasBody(h))) return false;
    send(foldTransaction(state, fold ? { fold: [h.pos] } : { unfold: [h.pos] }), dispatch, view, h.pos);
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

/** the headings of a level, by name: "sections", "subsections", … (the level menu entries) */
const LEVEL_PLURAL: Record<number, string> = { [-1]: 'parts', 0: 'chapters', 1: 'sections', 2: 'subsections', 3: 'subsubsections', 4: 'paragraph headings', 5: 'subparagraph headings' };

/** Fold (or expand) every heading of the level of the heading at / above `pos` — all subsections, say. */
export function setLevelFolded(pos: number, fold: boolean): Command {
  return (state, dispatch, view) => {
    const h = headingAt(state.doc, pos);
    if (!h) return false;
    const cur = new Set(foldKey.getState(state)?.folded ?? []);
    const same = foldHeadings(state.doc).filter(x => x.level === h.level);
    const change = same.filter(x => (fold ? hasBody(x) && !cur.has(x.pos) : cur.has(x.pos))).map(x => x.pos);
    if (!change.length) return false;
    send(foldTransaction(state, fold ? { fold: change } : { unfold: change }), dispatch, view, h.pos);
    return true;
  };
}
export const toggleLevelAtCursor = (fold: boolean): Command => (state, dispatch, view) => setLevelFolded(state.selection.head, fold)(state, dispatch, view);

/**
 * The folding entries for the heading at / above `pos`: this section, every heading of its level,
 * all — the arrow's right-click menu, the text's right-click Sections submenu. Entries that would do
 * nothing are disabled.
 */
export function foldMenuItems(view: EditorView, pos: number): MenuItem[] {
  const state = view.state;
  const run = (cmd: Command) => () => { cmd(view.state, view.dispatch, view); view.focus(); };
  const h = headingAt(state.doc, pos);
  const folded = new Set(foldKey.getState(state)?.folded ?? []);
  const heads = foldHeadings(state.doc);
  const items: MenuItem[] = [];
  if (h) {
    const closed = folded.has(h.pos);
    const same = heads.filter(x => x.level === h.level);
    const name = LEVEL_PLURAL[h.level] ?? 'headings of this level';
    items.push(
      { label: closed ? 'Expand this section' : 'Fold this section', disabled: !closed && !hasBody(h), action: run(setSectionFolded(h.pos, !closed)) },
      { sep: true },
      { label: `Fold all at this level (${name})`, disabled: !same.some(x => hasBody(x) && !folded.has(x.pos)), action: run(setLevelFolded(h.pos, true)) },
      { label: `Expand all at this level (${name})`, disabled: !same.some(x => folded.has(x.pos)), action: run(setLevelFolded(h.pos, false)) },
      { sep: true },
    );
  }
  items.push(
    { label: 'Fold all sections', disabled: !heads.some(x => hasBody(x) && !folded.has(x.pos)), action: run(setAllFolded(true, h?.pos ?? null)) },
    { label: 'Expand all sections', disabled: !folded.size, action: run(setAllFolded(false, h?.pos ?? null)) },
  );
  return items;
}

/**
 * Fold every heading with something under it (Google Docs' Collapse all headings), or expand them
 * all; `anchorPos`: the heading that stays put on screen (the one right-clicked), else the top of the view.
 */
export function setAllFolded(fold: boolean, anchorPos: number | null = null): Command {
  return (state, dispatch, view) => {
    const all = fold ? foldHeadings(state.doc).filter(hasBody).map(h => h.pos) : [];
    const cur = foldKey.getState(state)?.folded ?? [];
    if (fold ? !all.length || all.every(p => cur.includes(p)) : !cur.length) return false;
    send(foldTransaction(state, { set: all }), dispatch, view, anchorPos);
    return true;
  };
}
/** View ▸ Fold all sections. */
export const foldAllSections: Command = setAllFolded(true);
/** View ▸ Expand all sections. */
export const unfoldAllSections: Command = setAllFolded(false);

/** how many sections are folded (menus enable Expand all with it) */
export const foldedCount = (state: EditorState): number => foldKey.getState(state)?.folded.length ?? 0;

/* ------------------------------------------------------------------ remembered per user and document */

interface FoldRecord { /** when the user changed them (ms) */ at: number; folds: SavedFold[] }
/** the web app, signed in: the folds live with the account (elsewhere API_BASE is the VS Code extension's bridge) */
const accountSync = (): boolean => API_BASE === '' && !!editorContext.user?.id;
/** the browser's copy, per user (a shared browser keeps each person's own) */
const localKey = (docId: string): string => { const u = editorContext.user?.id; return u ? `ol.fold:${u}:${docId}` : `ol.fold:${docId}`; };
const LEGACY = (docId: string) => 'ol.fold:' + docId;

/** the last change, sent while the page goes away (a keepalive request is not cancelled with the page) */
function sendFoldsOnLeave(docId: string, rec: FoldRecord): void {
  try {
    void fetch(`/api/docs/${docId.split('/').map(encodeURIComponent).join('/')}/folds`, {
      method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folds: rec.folds, at: rec.at }),
    }).catch(() => { /* the browser's copy is newer: it goes up the next time */ });
  } catch { /* ignore */ }
}

function readLocal(docId: string): FoldRecord | null {
  if (!docId) return null;
  try {
    // an earlier build kept a plain list per browser: it counts as older than anything the account has
    const raw = localStorage.getItem(localKey(docId)) ?? localStorage.getItem(LEGACY(docId));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return { at: 1, folds: v };
    if (v && typeof v === 'object' && Array.isArray(v.folds)) return { at: Number(v.at) || 0, folds: v.folds };
  } catch { /* storage unavailable or damaged */ }
  return null;
}
function writeLocal(docId: string, rec: FoldRecord): void {
  if (!docId) return;
  try {
    localStorage.setItem(localKey(docId), JSON.stringify(rec));
    if (localKey(docId) !== LEGACY(docId)) localStorage.removeItem(LEGACY(docId));
  } catch { /* storage unavailable */ }
}

/** The folded headings by layout, text and which of the equal headings (the n-th "Results") it is — positions do not survive a reload. */
function serializeFolds(doc: PMNode, folded: readonly number[]): SavedFold[] {
  const seen = new Map<string, number>();
  const out: SavedFold[] = [];
  for (const h of foldHeadings(doc)) {
    const k = h.node.attrs.layout + '\n' + h.node.textContent;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    if (folded.includes(h.pos)) out.push({ l: String(h.node.attrs.layout), t: h.node.textContent, n });
  }
  return out;
}
function matchSaved(heads: FoldHeading[], saved: SavedFold[]): number[] {
  const seen = new Map<string, number>();
  const out: number[] = [];
  for (const h of heads) {
    const k = h.node.attrs.layout + '\n' + h.node.textContent;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    if (hasBody(h) && saved.some(x => x.l === h.node.attrs.layout && x.t === h.node.textContent && x.n === n)) out.push(h.pos);
  }
  return out;
}
