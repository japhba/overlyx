/**
 * Typing is anchored where it happens. y-prosemirror turns every local change into Yjs operations by
 * diffing each changed text run against its Y.XmlText (lib0 `simpleDiff`: longest common prefix
 * first). That is ambiguous whenever a typed character equals the one after the cursor — "q" typed
 * in front of "queries" — and the diff then puts the new character *behind* the existing one, so the
 * rest of the word hangs off the old text instead of off the character typed before it. Nothing shows
 * locally, but two people typing at the same place (one of them offline for a while, so their edits
 * meet only on reconnect) got their words spliced into each other mid-word —
 * "values and  Zc2on Zc1offq0006Z q0000Z queries" — where a CRDT merge puts one insertion after the
 * other. (The splice also forged a copy of a token typed elsewhere: Zc1off + q0006Z.)
 *
 * Before y-prosemirror's diff runs, the text run at the cursor is brought up to date here with an
 * ambiguous insertion placed so that it ends at the cursor (a deletion so that it starts there);
 * y-prosemirror then finds that run unchanged. Only the choice between placements that give the same
 * text changes; whatever this does not recognise is left to y-prosemirror as before.
 *
 * Enter in the middle of a paragraph is a second case. Yjs cannot move text, so a split keeps one half
 * in the paragraph's Yjs element and copies the other into a new one — and y-prosemirror picked the
 * half by a similarity score and aligned the text runs from the left: with formulas in the paragraph
 * it rewrote the paragraph's *first* text run with the second half and deleted the run that was
 * split, so whatever somebody offline had typed into that run was lost on reconnect, and two people
 * splitting one paragraph duplicated both halves. Here the larger half stays in place (the first one
 * on a tie) with the split run trimmed, never deleted, and only the smaller half is copied: text typed
 * meanwhile on another device into the split run survives (inside the copied part it lands at the
 * split point), and two people typing at the start of a paragraph and pressing Enter no longer
 * duplicate it. What a copy cannot keep: text typed meanwhile into the copied half beyond the split
 * run, and — when two people split one paragraph — the stretch both copied.
 */
import { Plugin, TextSelection } from 'prosemirror-state';
import type { Node as PMNode, MarkType } from 'prosemirror-model';
import * as Y from 'yjs';
import { ySyncPluginKey, updateYFragment, absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from 'y-prosemirror';
import { recordCopies, followMoves } from '../../../../core/src/moves';

/** The parts of y-prosemirror's ProsemirrorBinding used here. */
interface SyncBinding {
  type: Y.XmlFragment;
  /** Yjs type → the ProseMirror node (or run of text nodes) it was last synced with */
  mapping: Map<Y.AbstractType<any>, PMNode | PMNode[]>;
  /** y-prosemirror's cache of which mark types may overlap */
  isOMark: Map<MarkType, boolean>;
  _prosemirrorChanged(doc: PMNode): void;
  prosemirrorView: { state: { selection: unknown } } | null;
}

/** A child of a node as y-prosemirror stores it: one Y.XmlText per run of adjacent text nodes, one element per other node. */
interface Group { text: boolean; from: number; to: number; firstChild: number; lastChild: number }

function groupsOf(node: PMNode): Group[] {
  const groups: Group[] = [];
  let pos = 0;
  node.forEach((child, _offset, i) => {
    const last = groups[groups.length - 1];
    if (child.isText && last?.text) { last.to = pos + child.nodeSize; last.lastChild = i; }
    else groups.push({ text: child.isText, from: pos, to: pos + child.nodeSize, firstChild: i, lastChild: i });
    pos += child.nodeSize;
  });
  return groups;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;

/**
 * `before` → `after` as one insertion or deletion placed at `cursor` (an offset in `after`: where an
 * insertion ends, where a deletion was) when that placement is as valid as the prefix-first one
 * `simpleDiff` picks; null when the change is something else, or the prefix-first placement is it.
 */
export function anchoredEdit(before: string, after: string, cursor: number): { index: number; remove: number; insert: string } | null {
  const n = after.length - before.length;
  if (n === 0) return null;
  const min = Math.min(before.length, after.length);
  let left = 0;
  while (left < min && before.charCodeAt(left) === after.charCodeAt(left)) left++;
  let right = 0;
  while (right < min && before.charCodeAt(before.length - 1 - right) === after.charCodeAt(after.length - 1 - right)) right++;
  // an insertion of n characters at i is valid for i ≤ left and before.length − i ≤ right (a deletion likewise, with after)
  const lo = Math.max(0, (n > 0 ? before.length : after.length) - right);
  if (lo > left) return null;   // not a pure insertion / deletion
  const index = Math.min(left, Math.max(lo, n > 0 ? cursor - n : cursor));
  if (index === left) return null;
  if (index > 0 && isHigh(before.charCodeAt(index - 1))) return null;   // never between the halves of a surrogate pair
  return n > 0 ? { index, remove: 0, insert: after.slice(index, index + n) } : { index, remove: -n, insert: '' };
}

/** The visible text of a Y.XmlText (null: it holds something else than text). */
function ytextString(t: Y.XmlText): string | null {
  let s = '';
  for (const op of t.toDelta() as { insert: unknown }[]) { if (typeof op.insert !== 'string') return null; s += op.insert; }
  return s;
}

/** A Yjs type and the document node(s) it now stands for (y-prosemirror's `mapping` entry). */
export type Synced = [Y.AbstractType<any>, PMNode | PMNode[]];

/**
 * Apply the change of the text run around the cursor of `doc` to its Y.XmlText, anchored at the
 * cursor — when the Yjs structure down to that run still matches the document's (it does while
 * one types; a split paragraph or a new node is left to y-prosemirror). Returns the Yjs types on the
 * way to the run with their new nodes when it changed the run (null otherwise): the caller records
 * them in y-prosemirror's `mapping` once y-prosemirror has synced the document.
 *
 * "Matches" is checked child by child: on every level down to the run, each child other than the one
 * on the cursor's path must still be the very node its Yjs counterpart was last synced with
 * (y-prosemirror's `mapping`), or a run with its text. Counting children and comparing node names was
 * not enough: with an inset deleted or added elsewhere in the paragraph, the cursor's comment thread
 * could line up with another thread's Yjs element, and the cursor run's text was written into that
 * other thread.
 */
export function anchorTypedText(fragment: Y.XmlFragment, doc: PMNode, head: number, mapping: SyncBinding['mapping']): Synced[] | null {
  const $head = doc.resolve(head);
  if (!$head.parent.inlineContent) return null;
  /**
   * every child of `node` but the `keep`th stands for its Yjs child: a node is the one that child was
   * synced with, a run of text has that child's text (y-prosemirror renders runs afresh, it maps nodes)
   */
  const aligned = (y: Y.XmlFragment | Y.XmlElement, node: PMNode, keep: number): boolean => {
    const ps = normalized(node), ys = y.toArray();
    if (ys.length !== ps.length) return false;
    for (let j = 0; j < ps.length; j++) {
      if (j === keep) continue;
      const yj = ys[j], pj = ps[j];
      if (yj instanceof Y.XmlText ? !Array.isArray(pj) || ytextString(yj) !== pj.map(t => t.text).join('') : !sameSynced(mapping.get(yj), pj)) return false;
    }
    return true;
  };
  const path: Synced[] = [];
  let y: Y.XmlFragment | Y.XmlElement = fragment;
  for (let d = 0; d < $head.depth; d++) {
    const node = $head.node(d), i = $head.index(d);
    const groups = groupsOf(node);
    if (y.length !== groups.length) return null;
    const g = groups.findIndex(gr => gr.firstChild <= i && i <= gr.lastChild);
    const child = y.get(g);
    if (!(child instanceof Y.XmlElement) || child.nodeName !== node.child(i).type.name || !aligned(y, node, g)) return null;
    path.push([child, node.child(i)]);
    y = child;
  }
  const block = $head.parent, offset = $head.parentOffset;
  const groups = groupsOf(block);
  if (y.length !== groups.length) return null;
  const g = groups.findIndex(gr => gr.text && gr.from <= offset && offset <= gr.to);
  if (g < 0 || !aligned(y, block, g)) return null;
  const ytext = y.get(g);
  if (!(ytext instanceof Y.XmlText)) return null;
  const before = ytextString(ytext);
  if (before === null) return null;
  const after = block.textBetween(groups[g].from, groups[g].to);
  if (before === after) return null;
  const edit = anchoredEdit(before, after, offset - groups[g].from);
  if (!edit) return null;
  // the inserted text takes the formatting on its left; y-prosemirror sets the marks the document has
  if (edit.remove) ytext.delete(edit.index, edit.remove);
  if (edit.insert) ytext.insert(edit.index, edit.insert);
  path.push([ytext, normalized(block)[g]]);
  return path;
}

/** A node's children as y-prosemirror stores them: runs of adjacent text nodes, other nodes one by one. */
function normalized(node: PMNode): (PMNode | PMNode[])[] {
  const out: (PMNode | PMNode[])[] = [];
  node.forEach(child => {
    const last = out[out.length - 1];
    if (child.isText && Array.isArray(last)) last.push(child);
    else out.push(child.isText ? [child] : child);
  });
  return out;
}

const sameSynced = (mapped: PMNode | PMNode[] | undefined, p: PMNode | PMNode[]): boolean =>
  mapped === p || (Array.isArray(mapped) && Array.isArray(p) && mapped.length === p.length && mapped.every((n, i) => n === p[i]));

/**
 * Find a paragraph split in `doc` against the Yjs tree (the one element whose synced node is now two
 * nodes of its type, the halves' content together the old content) and apply it with the first
 * half kept in place. Descends through the one changed child of each level, so splits inside table
 * cells and insets are found too. Returns the elements it descended through with their new nodes
 * when it applied one (for y-prosemirror's `mapping`, as anchorTypedText), null when it did not.
 */
export function anchorSplit(binding: SyncBinding, y: Y.XmlFragment | Y.XmlElement, node: PMNode): Synced[] | null {
  const ys = y.toArray(), ps = normalized(node);
  const min = Math.min(ys.length, ps.length);
  let left = 0;
  while (left < min && sameSynced(binding.mapping.get(ys[left]), ps[left])) left++;
  let right = 0;
  while (right < min - left && sameSynced(binding.mapping.get(ys[ys.length - 1 - right]), ps[ps.length - 1 - right])) right++;
  const yMid = ys.length - left - right, pMid = ps.length - left - right;
  const el = ys[left], a = ps[left], b = ps[left + 1];
  if (!(el instanceof Y.XmlElement) || Array.isArray(a)) return null;
  if (yMid === 1 && pMid === 1) {
    if (el.nodeName !== a.type.name) return null;
    const inner = anchorSplit(binding, el, a);
    return inner && [[el, a], ...inner];
  }
  if (yMid !== 1 || pMid !== 2 || Array.isArray(b)) return null;
  const old = binding.mapping.get(el);
  if (!old || Array.isArray(old) || !old.inlineContent || a.type !== old.type || b.type !== old.type) return null;
  if (!a.content.append(b.content).eq(old.content)) return null;
  const doc = y.doc!;
  if (b.content.size <= a.content.size) {
    updateYFragment(doc, el, a, binding);   // the first half: same element, the split run trimmed, what follows it deleted
    const second = new Y.XmlElement(b.type.name);
    y.insert(left + 1, [second]);
    updateYFragment(doc, second, b, binding);
    return [];
  }
  // the second half is the larger one (Enter near the start): it stays, the first half is copied
  const at = splitPoint(old, a.content.size);
  const kids = el.toArray();
  if (!at || kids.length !== normalized(old).length || (at.offset > 0 && !(kids[at.index] instanceof Y.XmlText))) return null;
  if (at.offset > 0) (kids[at.index] as Y.XmlText).delete(0, at.offset);
  if (at.index > 0) el.delete(0, at.index);
  updateYFragment(doc, el, b, binding);
  const first = new Y.XmlElement(a.type.name);
  y.insert(left, [first]);
  updateYFragment(doc, first, a, binding);
  return [];
}

/** Where content offset `pos` of a textblock falls among its children as Yjs stores them: before child `index`, `offset` characters into it (a text run only). */
function splitPoint(node: PMNode, pos: number): { index: number; offset: number } | null {
  const groups = normalized(node);
  for (let index = 0; index < groups.length; index++) {
    if (pos === 0) return { index, offset: 0 };
    const g = groups[index];
    const size = Array.isArray(g) ? g.reduce((n, t) => n + t.nodeSize, 0) : g.nodeSize;
    if (pos < size) return Array.isArray(g) ? { index, offset: pos } : null;
    pos -= size;
  }
  return null;   // at the very end: no second half to keep
}

/** Installs the anchoring in front of y-prosemirror's own PM → Yjs sync (place it right after ySyncPlugin). */
/**
 * The cursor stays after what its owner typed. After a change from elsewhere y-prosemirror puts the
 * cursor back "before the character on its right" — so when two people type at the same place, each
 * one's next letter lands behind the other's last one and their words interleave letter by letter
 * ("IsU 10. 1 Unm2"), and a Backspace then deletes the other person's letters (usability test,
 * co-authoring a heading). Here the cursor is anchored to the character on its *left* instead — the
 * one its owner just typed —, as Google Docs keeps it: before a change from elsewhere that character
 * is remembered (a Yjs relative position), after it the cursor goes back right behind it, if it is
 * still there and still that character. At the start of a paragraph the cursor stays at the start.
 * Selections and anything else keep y-prosemirror's placement.
 */
type PMView = { state: import('prosemirror-state').EditorState; dispatch(tr: import('prosemirror-state').Transaction): void };
function caretStaysWithItsText(b: SyncBinding): () => void {
  const binding = b as unknown as Omit<SyncBinding, 'prosemirrorView'> & { prosemirrorView?: PMView | null };
  const ydoc = binding.type.doc!;
  let anchor: { rel: Y.RelativePosition; ch: string } | null = null;
  // the cursor at the start of its paragraph: what is there (or the paragraph's end, when it is empty)
  let atStart: Y.RelativePosition | null = null;
  const before = (tr: Y.Transaction) => {
    anchor = null; atStart = null;
    if (tr.local) return;
    const st = binding.prosemirrorView?.state;
    const sel = st?.selection;
    if (!st || !(sel instanceof TextSelection) || !sel.empty) return;
    if (sel.$head.parentOffset === 0) {
      try { atStart = absolutePositionToRelativePosition(sel.head, binding.type, binding.mapping as never); } catch { atStart = null; }
      return;
    }
    const prev = sel.$head.nodeBefore;
    if (!prev?.isText) return;
    try {
      const rel = absolutePositionToRelativePosition(sel.head - 1, binding.type, binding.mapping as never);
      anchor = { rel, ch: st.doc.textBetween(sel.head - 1, sel.head) };
    } catch { anchor = null; }
  };
  const after = (tr: Y.Transaction) => {
    const a = anchor, start = atStart;
    anchor = null; atStart = null;
    const view = binding.prosemirrorView;
    if (tr.local || !view) return;
    // somebody typed at the start of the paragraph the cursor stands at the start of: the cursor
    // stays at the start, before their text — y-prosemirror put it in front of the old first
    // character, after the first letters that had arrived, and the rest of their word then landed on
    // the other side of it ("S" + my words + "AMEA1", live co-editing test)
    if (start) {
      const st = view.state, sel = st.selection;
      if (!(sel instanceof TextSelection) || !sel.empty) return;
      let at: number | null = null;
      try { at = relativePositionToAbsolutePosition(ydoc, binding.type, start, binding.mapping as never); } catch { at = null; }
      if (at === null || at !== sel.head) return;
      const $at = sel.$head;
      if (!$at.parent.isTextblock || $at.parentOffset === 0) return;
      view.dispatch(st.tr.setSelection(TextSelection.create(st.doc, $at.start())).setMeta('addToHistory', false));
      return;
    }
    if (!a) return;
    const st = view.state, sel = st.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) return;
    let at: number | null = null;
    try { at = relativePositionToAbsolutePosition(ydoc, binding.type, a.rel, binding.mapping as never); } catch { at = null; }
    if (at === null || at + 1 > st.doc.content.size || at + 1 === sel.head) return;
    if (st.doc.textBetween(at, at + 1) !== a.ch) return;
    const $t = st.doc.resolve(at + 1);
    if (!$t.parent.isTextblock || $t.parent !== sel.$head.parent) return;
    view.dispatch(st.tr.setSelection(TextSelection.create(st.doc, at + 1)).setMeta('addToHistory', false));
  };
  ydoc.on('beforeTransaction', before);
  ydoc.on('afterTransaction', after);
  return () => { ydoc.off('beforeTransaction', before); ydoc.off('afterTransaction', after); };
}

export function typingAnchorPlugin(): Plugin {
  return new Plugin({
    view(view) {
      const binding = (ySyncPluginKey.getState(view.state) as { binding?: SyncBinding } | undefined)?.binding;
      if (!binding || typeof binding._prosemirrorChanged !== 'function') return {};
      const sync = binding._prosemirrorChanged.bind(binding);
      let synced: PMNode | null = null;
      binding._prosemirrorChanged = (doc: PMNode) => {
        // one Yjs transaction with y-prosemirror's own origin (the undo manager tracks it as a local edit)
        binding.type.doc!.transact(tr => {
          const sel = binding.prosemirrorView?.state.selection;
          let typed: Synced[] | null = null;
          if (doc !== synced) {
            try {
              typed = anchorSplit(binding, binding.type, doc);
              if (!typed && sel instanceof TextSelection) typed = anchorTypedText(binding.type, doc, sel.head, binding.mapping);
            } catch (e) { console.warn('[typing anchor]', e); }
          }
          synced = doc;
          sync(doc);
          // With the run (or the split paragraph) already brought up to date, y-prosemirror finds the
          // outermost changed paragraph equal and records only that one: the inset, the inner paragraph
          // and the run inside it kept the nodes from before the keystroke. The next change from
          // elsewhere in that paragraph re-rendered the inset from those, the keystrokes (or the new
          // paragraph) vanished from the screen, and the next local edit wrote the old text back —
          // characters typed into comments and footnotes were lost.
          if (typed) for (const [type, node] of typed) binding.mapping.set(type, node);
          // a split, a join or a run cut by an inline node copied text: recorded, for the server to place what others typed into the original
          try { recordCopies(tr); } catch (e) { console.warn('[moves]', e); }
        }, ySyncPluginKey);
      };
      // moved text keeps the cursor and the undo history on it when the move comes from elsewhere
      const stopMoves = followMoves(binding.type.doc!);
      const stopCaret = caretStaysWithItsText(binding);
      return { destroy: () => { stopMoves(); stopCaret(); } };
    },
  });
}
