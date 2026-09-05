/**
 * Change tracking (LyX \change_inserted / \change_deleted):
 *  - when tracking is on, typed text gets an "inserted" change mark for the current author;
 *  - Backspace/Delete over unchanged text marks it "deleted" instead of removing it;
 *  - accept/reject all changes.
 */
import { Plugin, PluginKey, TextSelection, type Command, type Transaction, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { schema, changeDomAttrs } from '@overlyx/core';
import { editorContext } from '../context';

export const changesKey = new PluginKey('lyx-changes');

function now(): number { return Math.floor(Date.now() / 1000); }

function changeMark(type: 'inserted' | 'deleted') {
  return schema.marks.change.create({ type, author: editorContext.changeAuthorId ?? 0, time: now() });
}

/** Inline nodes that never carry a tracked change of their own: a margin drawing's anchor is not text. */
const UNTRACKED_NODES = new Set(['sketch']);

/**
 * Adds the inserted-mark to what the user inserts while tracking is active: text gets the change
 * mark, an inline node (a pasted formula, a reference, a footnote…) records it in its `marks`
 * attribute — like LyX, which marks the inset's position. Only pure insertions mark nodes: a
 * node replaced by a new version of itself (a formula being edited, an inset opened or closed)
 * stays as it was — LyX does not track edits inside math either.
 */
function withChange(node: PMNode, attrs: Record<string, unknown>): Record<string, unknown> {
  const marks = JSON.parse(node.attrs.marks || '[]').filter((m: any) => m.type !== 'change');
  marks.push({ type: 'change', attrs });
  return { ...node.attrs, marks: JSON.stringify(marks) };
}

/** Keep removed original content in the document, including paragraph boundaries. */
function deletedSlice(slice: Slice): Slice {
  const del = changeMark('deleted');
  const walk = (content: Fragment, openEnd: number): Fragment => {
    const nodes: PMNode[] = [];
    let joinNext = false;
    content.forEach((node, _offset, index) => {
      const end = index === content.childCount - 1 ? openEnd : 0;
      const ch = changeOf(node);
      if (node.isInline) {
        if (UNTRACKED_NODES.has(node.type.name) || (ch?.type === 'inserted' && ch.author === editorContext.changeAuthorId)) return;
        if (ch?.type === 'deleted') nodes.push(node);
        else nodes.push(node.isText ? node.mark(del.addToSet(node.marks)) : node.type.create(withChange(node, del.attrs), node.content, node.marks));
      } else {
        const boundary = node.attrs.endChange ? JSON.parse(node.attrs.endChange) : null;
        const cancelBoundary = node.type.name === 'paragraph' && end === 0 && boundary?.type === 'inserted' && boundary.author === editorContext.changeAuthorId;
        const attrs = node.type.name === 'paragraph' && end === 0 ? { ...node.attrs, endChange: cancelBoundary ? null : JSON.stringify(del.attrs) } : node.attrs;
        const rebuilt = node.type.create(attrs, walk(node.content, Math.max(0, end - 1)), node.marks);
        if (joinNext && rebuilt.type.name === 'paragraph' && nodes.at(-1)?.type === rebuilt.type) {
          const previous = nodes.pop()!;
          nodes.push(previous.type.create({ ...previous.attrs, endChange: rebuilt.attrs.endChange }, previous.content.append(rebuilt.content), previous.marks));
        } else nodes.push(rebuilt);
        joinNext = cancelBoundary;
      }
    });
    return Fragment.from(nodes);
  };
  return new Slice(walk(slice.content, slice.openEnd), slice.openStart, slice.openEnd);
}

export function changeTrackingPlugin(): Plugin {
  return new Plugin({
    key: changesKey,
    appendTransaction(trs, _old, newState) {
      if (!editorContext.trackChanges || editorContext.changeAuthorId === undefined) return null;
      const tr = newState.tr;
      for (let ti = 0; ti < trs.length; ti++) {
        const t = trs[ti];
        if (!t.docChanged || t.getMeta('lyx-changes') || t.getMeta('y-sync$') || t.getMeta('addToHistory') === false) continue;
        const structural: { from: number; to: number }[] = [];
        const structure = (n: PMNode) => JSON.stringify([n.attrs.columns, n.content.content.map(row => row.content.content.map(cell => [cell.attrs.colspan, cell.attrs.rowspan]))]);
        t.before.descendants((old, pos) => {
          if (old.type.name !== 'table') return true;
          const next = t.doc.nodeAt(t.mapping.map(pos, 1));
          if (!next || next.type !== old.type || structure(next) === structure(old)) return false;
          structural.push({ from: pos, to: pos + old.nodeSize });
          let at = t.mapping.map(pos, 1);
          for (let j = ti + 1; j < trs.length; j++) at = trs[j].mapping.map(at, 1);
          at = tr.mapping.map(at, 1);
          const current = tr.doc.nodeAt(at);
          if (current?.type !== old.type) return false;
          // A structural table edit is one reviewable replacement. Keep the complete
          // original grid (including spans and cell formatting) so rejection is lossless.
          tr.setNodeMarkup(at, undefined, withChange(current, changeMark('inserted').attrs));
          if (!(changeOf(old)?.type === 'inserted' && changeOf(old)?.author === editorContext.changeAuthorId)) {
            tr.insert(at, old.type.create(withChange(old, changeMark('deleted').attrs), old.content));
          }
          return false;
        });
        for (let i = 0; i < t.steps.length; i++) {
          const step = t.steps[i];
          if (!(step instanceof ReplaceStep)) continue;
          if (structural.some(r => step.from >= r.from && step.from <= r.to)) continue;
          // Editing attributes of an existing formula is not a textual replacement.
          const oldNode = t.docs[i].nodeAt(step.from);
          if (step.to > step.from && oldNode && !oldNode.isText && oldNode.isAtom && step.to - step.from === oldNode.nodeSize && step.slice.content.childCount === 1 && step.slice.content.firstChild?.type === oldNode.type) continue;
          const mapToCurrent = (pos: number, assoc: number) => {
            for (let j = i + 1; j < t.mapping.maps.length; j++) pos = t.mapping.maps[j].map(pos, assoc);
            for (let j = ti + 1; j < trs.length; j++) pos = trs[j].mapping.map(pos, assoc);
            return tr.mapping.map(pos, assoc);
          };
          step.getMap().forEach((os, oe, ns, ne) => {
            const from = mapToCurrent(ns, 1), to = mapToCurrent(ne, -1);
            if (to > from) {
              const ins = changeMark('inserted');
              tr.doc.nodesBetween(from, to, (node, pos) => {
                if (node.isText) {
                  if (!changeOf(node)) tr.addMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), ins);
                } else if (node.isInline && pos >= from && pos + node.nodeSize <= to && !UNTRACKED_NODES.has(node.type.name)) {
                  if (!changeOf(node)) tr.setNodeMarkup(pos, undefined, withChange(node, ins.attrs));
                  return false;
                } else if (node.type.name === 'paragraph' && !node.attrs.endChange && pos + node.nodeSize - 1 >= from && pos + node.nodeSize - 1 < to) {
                  tr.setNodeMarkup(pos, undefined, { ...node.attrs, endChange: JSON.stringify(ins.attrs) });
                }
                return true;
              });
            }
            if (oe > os) {
              const original = t.docs[i].slice(os, oe);
              let removed = deletedSlice(original);
              let at = mapToCurrent(ns, -1);
              // Block paste expands a selection at the start of a paragraph to include
              // its opening token. Restore that partial paragraph inside the pasted
              // first paragraph, rather than inventing another paragraph boundary.
              if (!removed.openStart && removed.openEnd && removed.content.firstChild?.type.name === 'paragraph' && tr.doc.nodeAt(at)?.type.name === 'paragraph') {
                at++;
                removed = new Slice(removed.content, 1, removed.openEnd);
              }
              if (to > from && removed.openEnd === 1 && removed.content.childCount > 1 && removed.content.lastChild?.type.name === 'paragraph') {
                const destination = tr.doc.resolve(at).parent;
                if (destination.type.name === 'paragraph') {
                  const last = removed.content.lastChild;
                  const tail = last.type.create({ ...last.attrs, endChange: destination.attrs.endChange }, last.content, last.marks);
                  removed = new Slice(removed.content.replaceChild(removed.content.childCount - 1, tail), removed.openStart, removed.openEnd);
                }
              }
              if (removed.size) {
                tr.replace(at, at, removed);
              }
              // Fitting an open slice keeps the destination paragraph's attributes.
              // Restore its boundary marker, including cancellation of a new break.
              if (removed.openStart && original.content.childCount > 1 && removed.content.firstChild?.type.name === 'paragraph') {
                const $at = tr.doc.resolve(at);
                if ($at.parent.type.name === 'paragraph') tr.setNodeMarkup($at.before(), undefined, { ...$at.parent.attrs, endChange: removed.content.firstChild.attrs.endChange });
              }
            }
          });
        }
      }
      if (tr.docChanged) return tr.setMeta('lyx-changes', true);
      return null;
    },
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        const filter = changesFilterKey.getState(state);
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'paragraph' || !node.attrs.endChange) return true;
          const change = JSON.parse(node.attrs.endChange);
          if (change.type === 'inserted' ? filter?.showInsertions === false : filter?.showDeletions === false) return true;
          const at = pos + node.nodeSize - 1;
          decos.push(Decoration.widget(at, view => {
            const el = document.createElement('span');
            for (const [name, value] of Object.entries(changeDomAttrs(change))) el.setAttribute(name, value);
            el.classList.add('lyx-change-boundary');
            el.textContent = '¶';
            el.title = `${change.type === 'inserted' ? 'Inserted' : 'Deleted'} paragraph break`;
            el.setAttribute('aria-label', el.title);
            el.onmousedown = event => {
              event.preventDefault();
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at, Math.min(at + 2, view.state.doc.content.size))).setMeta('addToHistory', false));
              view.focus();
            };
            return el;
          }, { side: 1 }));
          return true;
        });
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
    },
  });
}

/**
 * Show a node's tracked change (kept in its `marks` attribute, see the schema) on the node
 * view's DOM the way the change mark shows on text: the `lyx-change-*` classes colour the
 * formula / reference / graphic in the author's colour, `data-author` picks that colour and the
 * hover tooltip reads the attributes. Node views call this whenever they (re)render their DOM.
 */
export function applyChangeAttrs(dom: HTMLElement, node: PMNode): void {
  const c = changeOf(node);
  if (!c) {
    if (dom.dataset.changed === undefined) return;
    dom.classList.remove('lyx-change', 'lyx-change-inserted', 'lyx-change-deleted');
    delete dom.dataset.changed; delete dom.dataset.author; delete dom.dataset.time;
    return;
  }
  const attrs = changeDomAttrs(c);
  dom.classList.toggle('lyx-change', true);
  dom.classList.toggle('lyx-change-inserted', c.type === 'inserted');
  dom.classList.toggle('lyx-change-deleted', c.type === 'deleted');
  for (const [k, v] of Object.entries(attrs)) if (k !== 'class' && dom.getAttribute(k) !== v) dom.setAttribute(k, v);
}

/** Backspace/Delete while tracking: mark as deleted (unless the text was inserted by tracking, then remove). */
export function trackedDelete(dir: -1 | 1): Command {
  return (state, dispatch) => {
    if (!editorContext.trackChanges || editorContext.changeAuthorId === undefined) return false;
    const sel = state.selection;
    if (!sel.empty && !sel.$from.sameParent(sel.$to)) return false;
    let from: number, to: number;
    if (!sel.empty) { from = sel.from; to = sel.to; }
    else {
      const $c = sel.$from;
      if (dir < 0) { if ($c.parentOffset === 0) return false; from = $c.pos - 1; to = $c.pos; }
      else { if ($c.parentOffset === $c.parent.content.size) return false; from = $c.pos; to = $c.pos + 1; }
      // step over a whole inline node
      const n = dir < 0 ? $c.nodeBefore : $c.nodeAfter;
      if (n && !n.isText) { if (dir < 0) from = $c.pos - n.nodeSize; else to = $c.pos + n.nodeSize; }
    }
    if (!dispatch) return true;
    let tr = state.tr;
    // Text inserted by change tracking is simply removed; other text is marked deleted.
    const del = changeMark('deleted');
    const removals: [number, number][] = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isInline) return true;
      const s = Math.max(from, pos), e = Math.min(to, pos + node.nodeSize);
      const ch = node.marks.find(m => m.type === schema.marks.change);
      if (ch && ch.attrs.type === 'inserted') removals.push([s, e]);
      else if (!(ch && ch.attrs.type === 'deleted')) {
        if (node.isText) tr = tr.addMark(s, e, del);
        else {
          const marks = JSON.parse(node.attrs.marks || '[]').filter((m: any) => m.type !== 'change');
          marks.push({ type: 'change', attrs: del.attrs });
          tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, marks: JSON.stringify(marks) });
        }
      }
      return false;
    });
    for (const [s, e] of removals.reverse()) tr = tr.delete(s, e);
    tr = tr.setSelection(TextSelection.create(tr.doc, dir < 0 ? tr.mapping.map(from) : tr.mapping.map(to)));
    dispatch(tr.setMeta('lyx-changes', true));
    return true;
  };
}

export function acceptAllChanges(): Command {
  return (state, dispatch) => {
    let tr = state.tr;
    const deletions: [number, number][] = [];
    const unmark: [number, number][] = [];
    const nodeFix: [number, PMNode][] = [];
    const joins: number[] = [];
    state.doc.descendants((node, pos) => {
      if (node.isText) {
        const ch = node.marks.find(m => m.type === schema.marks.change);
        if (ch?.attrs.type === 'deleted') { deletions.push([pos, pos + node.nodeSize]); return false; }
        else if (ch) unmark.push([pos, pos + node.nodeSize]);
      } else if (node.isInline) {
        const marks: any[] = JSON.parse(node.attrs.marks || '[]');
        const ch = marks.find(m => m.type === 'change');
        if (ch?.attrs.type === 'deleted') { deletions.push([pos, pos + node.nodeSize]); return false; }
        else if (ch) nodeFix.push([pos, node]);
      } else if (node.type.name === 'paragraph' && node.attrs.endChange) {
        nodeFix.push([pos, node]);
        const ch = JSON.parse(node.attrs.endChange);
        if (ch.type === 'deleted') joins.push(pos + node.nodeSize);
      }
      return true;
    });
    for (const [s, e] of unmark) tr = tr.removeMark(s, e, schema.marks.change);
    for (const [pos, node] of nodeFix) {
      if (node.type.name === 'paragraph') tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, endChange: null });
      else tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, marks: JSON.stringify(JSON.parse(node.attrs.marks || '[]').filter((m: any) => m.type !== 'change')) });
    }
    for (const [s, e] of deletions.sort((a, b) => b[0] - a[0])) tr = tr.delete(tr.mapping.map(s), tr.mapping.map(e));
    for (const pos of joins.sort((a, b) => b - a)) {
      const at = tr.mapping.map(pos, -1);
      if (at > 0 && at < tr.doc.content.size && tr.doc.resolve(at).nodeBefore?.type === schema.nodes.paragraph && tr.doc.resolve(at).nodeAfter?.type === schema.nodes.paragraph) tr.join(at);
    }
    if (!tr.docChanged) return false;
    dispatch?.(tr.setMeta('lyx-changes', true));
    return true;
  };
}

export function rejectAllChanges(): Command {
  return (state, dispatch) => {
    let tr = state.tr;
    const deletions: [number, number][] = [];
    const unmark: [number, number][] = [];
    const nodeFix: [number, PMNode][] = [];
    const joins: number[] = [];
    state.doc.descendants((node, pos) => {
      if (node.isText) {
        const ch = node.marks.find(m => m.type === schema.marks.change);
        if (ch?.attrs.type === 'inserted') { deletions.push([pos, pos + node.nodeSize]); return false; }
        else if (ch) unmark.push([pos, pos + node.nodeSize]);
      } else if (node.isInline) {
        const marks: any[] = JSON.parse(node.attrs.marks || '[]');
        const ch = marks.find(m => m.type === 'change');
        if (ch?.attrs.type === 'inserted') { deletions.push([pos, pos + node.nodeSize]); return false; }
        else if (ch) nodeFix.push([pos, node]);
      } else if (node.type.name === 'paragraph' && node.attrs.endChange) {
        nodeFix.push([pos, node]);
        if (JSON.parse(node.attrs.endChange).type === 'inserted') joins.push(pos + node.nodeSize);
      }
      return true;
    });
    for (const [s, e] of unmark) tr = tr.removeMark(s, e, schema.marks.change);
    for (const [pos, node] of nodeFix) {
      if (node.type.name === 'paragraph') tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, endChange: null });
      else tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, marks: JSON.stringify(JSON.parse(node.attrs.marks || '[]').filter((m: any) => m.type !== 'change')) });
    }
    for (const [s, e] of deletions.sort((a, b) => b[0] - a[0])) tr = tr.delete(tr.mapping.map(s), tr.mapping.map(e));
    for (const pos of joins.sort((a, b) => b - a)) {
      const at = tr.mapping.map(pos, -1);
      if (at > 0 && at < tr.doc.content.size && tr.doc.resolve(at).nodeBefore?.type === schema.nodes.paragraph && tr.doc.resolve(at).nodeAfter?.type === schema.nodes.paragraph) tr.join(at);
    }
    if (!tr.docChanged) return false;
    dispatch?.(tr.setMeta('lyx-changes', true));
    return true;
  };
}

export function hasChanges(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === 'paragraph' && node.attrs.endChange) found = true;
    else if (node.isText && node.marks.some(m => m.type === schema.marks.change)) found = true;
    else if (node.isInline && (node.attrs.marks || '').includes('"change"')) found = true;
    return !found;
  });
  return found;
}

/* ------------------------------------------------ single change at the cursor */

export interface ChangeRange { from: number; to: number; type: 'inserted' | 'deleted'; author: number; time: number; boundary?: boolean }

export function changeOf(node: PMNode): { type: 'inserted' | 'deleted'; author: number; time: number } | null {
  if (node.isText) {
    const m = node.marks.find(x => x.type === schema.marks.change);
    return m ? { type: m.attrs.type, author: Number(m.attrs.author), time: Number(m.attrs.time) } : null;
  }
  if (node.isInline) {
    try {
      const ch = JSON.parse(node.attrs.marks || '[]').find((x: any) => x.type === 'change');
      return ch ? { type: ch.attrs.type, author: Number(ch.attrs.author), time: Number(ch.attrs.time) } : null;
    } catch { return null; }
  }
  return null;
}

/** The tracked change (contiguous run with the same author/type) at a position, if any. */
export function changeAt(state: EditorState, pos: number): ChangeRange | null {
  const $p = state.doc.resolve(pos);
  const parent = $p.parent, base = $p.start();
  if (!parent.isTextblock) return null;
  // find the child at pos (prefer the one after the cursor, then before)
  let idx = $p.index();
  let child = parent.maybeChild(idx);
  let ch = child ? changeOf(child) : null;
  if (!ch && idx > 0) { idx--; child = parent.child(idx); ch = changeOf(child); }
  if (!ch || !child) {
    for (let depth = $p.depth; depth > 0; depth--) {
      const ancestor = $p.node(depth), change = changeOf(ancestor);
      if (change) return { from: $p.before(depth), to: $p.before(depth) + ancestor.nodeSize, ...change };
    }
    if (parent.attrs.endChange) {
      const change = JSON.parse(parent.attrs.endChange);
      return { from: base + parent.content.size, to: base + parent.content.size + 2, ...change, boundary: true };
    }
    return null;
  }
  const same = (n: PMNode) => { const c = changeOf(n); return !!c && c.type === ch!.type && c.author === ch!.author; };
  let a = idx, b = idx;
  while (a > 0 && same(parent.child(a - 1))) a--;
  while (b + 1 < parent.childCount && same(parent.child(b + 1))) b++;
  let from = base, to = base;
  for (let i = 0; i < a; i++) from += parent.child(i).nodeSize;
  to = from;
  for (let i = a; i <= b; i++) to += parent.child(i).nodeSize;
  return { from, to, ...ch };
}

/** Accept (keep insertions / drop deletions) or reject one change range. */
export function resolveChange(range: ChangeRange, accept: boolean): Command {
  return (state, dispatch) => {
    let tr = state.tr;
    const remove = accept ? range.type === 'deleted' : range.type === 'inserted';
    if (range.boundary) {
      resolveBoundary(tr, range, remove);
      if (!tr.docChanged) return false;
      dispatch?.(tr.setMeta('lyx-changes', true));
      return true;
    }
    if (remove) tr = tr.delete(range.from, range.to);
    else {
      tr = tr.removeMark(range.from, range.to, schema.marks.change);
      state.doc.nodesBetween(range.from, range.to, (node, pos) => {
        if (node.isInline && !node.isText && (node.attrs.marks || '').includes('"change"')) {
          tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, marks: JSON.stringify(JSON.parse(node.attrs.marks || '[]').filter((m: any) => m.type !== 'change')) });
        }
        return true;
      });
    }
    if (!tr.docChanged) return false;
    dispatch?.(tr.setMeta('lyx-changes', true));
    return true;
  };
}

/* ------------------------------------------------ navigation (LyX change-next / change-previous) */

/** All tracked change runs of the document in document order (adjacent same author/type merged). */
export function allChanges(doc: PMNode): ChangeRange[] {
  const out: ChangeRange[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && node.attrs.endChange) out.push({ from: pos + node.nodeSize - 1, to: pos + node.nodeSize + 1, ...JSON.parse(node.attrs.endChange), boundary: true });
    if (!node.isInline) return true;
    const c = changeOf(node);
    if (!c) return true;
    const last = out[out.length - 1];
    if (last && !last.boundary && last.to === pos && last.type === c.type && last.author === c.author) last.to = pos + node.nodeSize;
    else out.push({ from: pos, to: pos + node.nodeSize, ...c });
    return false;
  });
  return out.sort((a, b) => a.from - b.from);
}

function resolveBoundary(tr: Transaction, range: ChangeRange, remove: boolean): void {
  const $end = tr.doc.resolve(Math.min(range.from, tr.doc.content.size));
  if ($end.parent.type.name !== 'paragraph') return;
  tr.setNodeMarkup($end.before(), undefined, { ...$end.parent.attrs, endChange: null });
  const at = $end.after();
  if (remove && at < tr.doc.content.size && tr.doc.resolve(at).nodeAfter?.type.name === 'paragraph') tr.join(at);
}

/** Move the cursor to the next / previous tracked change (wraps around); selects it. */
export function gotoChange(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const all = allChanges(state.doc);
    if (!all.length) return false;
    const { from, to } = state.selection;
    let target: ChangeRange | undefined;
    if (dir > 0) target = all.find(c => c.from >= to || (c.from > from && c.to > to)) ?? all[0];
    else { for (let i = all.length - 1; i >= 0; i--) if (all[i].to <= from || (all[i].from < from && all[i].to < to)) { target = all[i]; break; } target = target ?? all[all.length - 1]; }
    if (!target) return false;
    if (dispatch) {
      const tr = state.tr.setSelection(TextSelection.create(state.doc, target.from, target.to)).scrollIntoView();
      dispatch(tr.setMeta('addToHistory', false));
    }
    return true;
  };
}

/** Accept or reject every change touching the selection (LyX change-accept / change-reject); with an
 *  empty selection, the change under the cursor. */
export function resolveSelectionChanges(accept: boolean): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const ranges = empty ? [changeAt(state, from)].filter((c): c is ChangeRange => !!c) : allChanges(state.doc).filter(c => c.from < to && c.to > from);
    if (!ranges.length) return false;
    if (!dispatch) return true;
    let tr = state.tr;
    for (const r of ranges.sort((a, b) => b.from - a.from)) {
      const remove = accept ? r.type === 'deleted' : r.type === 'inserted';
      if (r.boundary) { resolveBoundary(tr, r, remove); continue; }
      if (remove) tr = tr.delete(r.from, r.to);
      else {
        tr = tr.removeMark(r.from, r.to, schema.marks.change);
        tr.doc.nodesBetween(r.from, r.to, (node, pos) => {
          if (node.isInline && !node.isText && (node.attrs.marks || '').includes('"change"')) tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, marks: JSON.stringify(JSON.parse(node.attrs.marks || '[]').filter((m: any) => m.type !== 'change')) });
          return true;
        });
      }
    }
    if (!tr.docChanged) return false;
    dispatch(tr.setMeta('lyx-changes', true));
    return true;
  };
}

/* ------------------------------------------------ display filter (insertions / deletions) */

/**
 * Purely a *view* filter: which tracked-change types are drawn. Independent of the document
 * itself — insertions and deletions can each be hidden (both, either, or neither), e.g. to read
 * the text as it will look once deletions are accepted while still seeing what was inserted.
 * A hidden run does not vanish without a trace: a small caret with a triangle stands where it is
 * (like a folded region), and clicking it unfolds just that run — the toolbar switches then act
 * as fold / unfold *all* (flipping one clears the per-run exceptions).
 */
export interface ChangesFilterState { showInsertions: boolean; showDeletions: boolean; unfolded: ReadonlySet<string> }
export const changesFilterKey = new PluginKey<ChangesFilterState>('lyx-changes-filter');
export type ChangesFilterPatch = Partial<Pick<ChangesFilterState, 'showInsertions' | 'showDeletions'>> & { toggleRun?: string };

/** one edit's identity: stable across position shifts (an agent or user edit shares author+time) */
const runKeyOf = (c: { type: string; author: number; time: number }) => `${c.type}:${c.author}:${c.time}`;

const foldMarker = (key: string, type: string, folded: boolean) => () => {
  const el = document.createElement('span');
  el.className = `ol-change-fold ${type}${folded ? '' : ' open'}`;
  el.setAttribute('data-fold', key);
  el.title = folded ? 'A hidden tracked change — click to show it' : 'Click to hide this tracked change again';
  el.contentEditable = 'false';
  return el;
};

export function changesFilterPlugin(): Plugin<ChangesFilterState> {
  return new Plugin<ChangesFilterState>({
    key: changesFilterKey,
    state: {
      init: () => ({ showInsertions: true, showDeletions: true, unfolded: new Set<string>() }),
      apply(tr, prev) {
        const meta = tr.getMeta(changesFilterKey) as ChangesFilterPatch | undefined;
        if (!meta) return prev;
        let unfolded: ReadonlySet<string> = prev.unfolded;
        if (meta.toggleRun) {
          const next = new Set(unfolded);
          next.has(meta.toggleRun) ? next.delete(meta.toggleRun) : next.add(meta.toggleRun);
          unfolded = next;
        }
        // the toolbar switches mean fold / unfold ALL: flipping one resets the per-run exceptions
        if (meta.showInsertions !== undefined || meta.showDeletions !== undefined) unfolded = new Set();
        return { showInsertions: meta.showInsertions ?? prev.showInsertions, showDeletions: meta.showDeletions ?? prev.showDeletions, unfolded };
      },
    },
    props: {
      decorations(state) {
        const f = changesFilterKey.getState(state)!;
        if (f.showInsertions && f.showDeletions) return null;
        const decos: Decoration[] = [];
        let runKey: string | null = null;   // the filtered run the walker is currently inside
        let runEnd = -1;
        state.doc.descendants((node, pos) => {
          if (!node.isInline) { runKey = null; return true; }
          const c = changeOf(node);
          const hit = c && ((c.type === 'inserted' && !f.showInsertions) || (c.type === 'deleted' && !f.showDeletions));
          if (!hit) { runKey = null; return true; }
          const key = runKeyOf(c);
          const folded = !f.unfolded.has(key);
          if (key !== runKey || pos > runEnd) {
            runKey = key;
            decos.push(Decoration.widget(pos, foldMarker(key, c.type, folded), { side: -1, key: `fold:${key}:${folded}` }));
          }
          runEnd = pos + node.nodeSize;
          const cls = folded ? 'lyx-change-hidden' : 'lyx-change-unfolded';
          decos.push(node.isText ? Decoration.inline(pos, pos + node.nodeSize, { class: cls }) : Decoration.node(pos, pos + node.nodeSize, { class: cls }));
          return true;
        });
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
      handleDOMEvents: {
        mousedown(view, ev) {
          const fold = (ev.target as HTMLElement).closest?.('.ol-change-fold');
          if (!fold) return false;
          ev.preventDefault();
          setChangesFilter(view, { toggleRun: fold.getAttribute('data-fold') ?? '' });
          return true;
        },
      },
    },
  });
}

export function setChangesFilter(view: EditorView, patch: ChangesFilterPatch): void {
  view.dispatch(view.state.tr.setMeta(changesFilterKey, patch));
}
