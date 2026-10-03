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
 * half by a similarity score: with formulas in the paragraph it often kept the *second* half, rewrote
 * the paragraph's first text run with it and deleted the run behind it, so whatever somebody offline
 * had typed into that run was lost on reconnect, and two people splitting one paragraph duplicated
 * both halves. A split here always keeps the first half in place, its text runs trimmed (never
 * deleted): text typed meanwhile on another device survives (after the split point it lands at the end
 * of the first half), and two concurrent splits share their first half — only the stretch after both
 * split points can appear twice (a new paragraph's copy is all Yjs can do).
 */
import { Plugin, TextSelection } from 'prosemirror-state';
import type { Node as PMNode, MarkType } from 'prosemirror-model';
import * as Y from 'yjs';
import { ySyncPluginKey, updateYFragment } from 'y-prosemirror';

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

/**
 * Apply the change of the text run around the cursor of `doc` to its Y.XmlText, anchored at the
 * cursor — when the Yjs structure down to that run still matches the document's (it does while
 * one types; a split paragraph or a new node is left to y-prosemirror).
 */
export function anchorTypedText(fragment: Y.XmlFragment, doc: PMNode, head: number): void {
  const $head = doc.resolve(head);
  if (!$head.parent.inlineContent) return;
  let y: Y.XmlFragment | Y.XmlElement = fragment;
  for (let d = 0; d < $head.depth; d++) {
    const node = $head.node(d), i = $head.index(d);
    const groups = groupsOf(node);
    if (y.length !== groups.length) return;
    const g = groups.findIndex(gr => gr.firstChild <= i && i <= gr.lastChild);
    const child = y.get(g);
    if (!(child instanceof Y.XmlElement) || child.nodeName !== node.child(i).type.name) return;
    y = child;
  }
  const block = $head.parent, offset = $head.parentOffset;
  const groups = groupsOf(block);
  if (y.length !== groups.length) return;
  const g = groups.findIndex(gr => gr.text && gr.from <= offset && offset <= gr.to);
  if (g < 0) return;
  const ytext = y.get(g);
  if (!(ytext instanceof Y.XmlText)) return;
  const before = ytextString(ytext);
  if (before === null) return;
  const after = block.textBetween(groups[g].from, groups[g].to);
  if (before === after) return;
  const edit = anchoredEdit(before, after, offset - groups[g].from);
  if (!edit) return;
  // the inserted text takes the formatting on its left; y-prosemirror sets the marks the document has
  if (edit.remove) ytext.delete(edit.index, edit.remove);
  if (edit.insert) ytext.insert(edit.index, edit.insert);
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
 * cells and insets are found too. True when it applied one.
 */
export function anchorSplit(binding: SyncBinding, y: Y.XmlFragment | Y.XmlElement, node: PMNode): boolean {
  const ys = y.toArray(), ps = normalized(node);
  const min = Math.min(ys.length, ps.length);
  let left = 0;
  while (left < min && sameSynced(binding.mapping.get(ys[left]), ps[left])) left++;
  let right = 0;
  while (right < min - left && sameSynced(binding.mapping.get(ys[ys.length - 1 - right]), ps[ps.length - 1 - right])) right++;
  const yMid = ys.length - left - right, pMid = ps.length - left - right;
  const el = ys[left], a = ps[left], b = ps[left + 1];
  if (!(el instanceof Y.XmlElement) || Array.isArray(a)) return false;
  if (yMid === 1 && pMid === 1) return el.nodeName === a.type.name && anchorSplit(binding, el, a);
  if (yMid !== 1 || pMid !== 2 || Array.isArray(b)) return false;
  const old = binding.mapping.get(el);
  if (!old || Array.isArray(old) || !old.inlineContent || a.type !== old.type || b.type !== old.type) return false;
  if (!a.content.append(b.content).eq(old.content)) return false;
  const doc = y.doc!;
  updateYFragment(doc, el, a, binding);   // the first half: same element, its runs trimmed
  const second = new Y.XmlElement(b.type.name);
  y.insert(left + 1, [second]);
  updateYFragment(doc, second, b, binding);
  return true;
}

/** Installs the anchoring in front of y-prosemirror's own PM → Yjs sync (place it right after ySyncPlugin). */
export function typingAnchorPlugin(): Plugin {
  return new Plugin({
    view(view) {
      const binding = (ySyncPluginKey.getState(view.state) as { binding?: SyncBinding } | undefined)?.binding;
      if (!binding || typeof binding._prosemirrorChanged !== 'function') return {};
      const sync = binding._prosemirrorChanged.bind(binding);
      let synced: PMNode | null = null;
      binding._prosemirrorChanged = (doc: PMNode) => {
        // one Yjs transaction with y-prosemirror's own origin (the undo manager tracks it as a local edit)
        binding.type.doc!.transact(() => {
          const sel = binding.prosemirrorView?.state.selection;
          if (doc !== synced) {
            try {
              if (!anchorSplit(binding, binding.type, doc) && sel instanceof TextSelection) anchorTypedText(binding.type, doc, sel.head);
            } catch (e) { console.warn('[typing anchor]', e); }
          }
          synced = doc;
          sync(doc);
        }, ySyncPluginKey);
      };
      return {};
    },
  });
}
