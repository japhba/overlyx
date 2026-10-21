/**
 * Footnotes of a markdown document as its readers see them: a superscript number in the text, and the
 * notes themselves numbered at the end of the document, where they are written (Google Docs, a
 * rendered README). A note is still the Foot inset at its reference (core md/ writes `[^label]` there
 * and the definition at the end): its box is only moved there visually, absolutely positioned over
 * the space kept free below the last paragraph (a widget), so editing, collaboration, comments and
 * tracked changes work in it as anywhere else.
 *  - a click on the number in the text puts the caret at the end of the note, the note's own number
 *    takes it back to the text, as do Escape, → at the note's end and ← at its start;
 *  - the caret steps over a reference (← / →); Backspace / Delete beside one selects it first;
 *  - typing `[^label]` makes a footnote — the note of that label again when the document has one.
 * Only footnotes in the text itself: one inside a comment, a note or another footnote stays inline.
 */
import { InputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { chainCommands } from 'prosemirror-commands';
import { undoInputRule } from 'prosemirror-inputrules';
import { NodeSelection, Plugin, PluginKey, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { documentViewScale } from '../viewscale';
import { inRawText } from '../rawtext';
import { editorContext } from '../context';

interface Note { pos: number; node: PMNode }
interface FootState { notes: Note[] }

const key = new PluginKey<FootState>('md-footnotes');
const isFoot = (n: PMNode | null | undefined): n is PMNode => !!n && n.type.name === 'inset' && n.attrs.name === 'Foot';

/** the footnotes in the text itself, in document order (not those inside other insets) */
function notesOf(doc: PMNode): Note[] {
  const out: Note[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name !== 'inset') return true;
    if (n.attrs.name === 'Foot') out.push({ pos, node: n });
    return false;
  });
  return out;
}

/** the note around `pos` when it is one shown at the end (its outermost inset is that footnote) */
function noteAround(state: EditorState, pos: number): Note | null {
  const $p = state.doc.resolve(pos);
  for (let d = 1; d <= $p.depth; d++) {
    const n = $p.node(d);
    if (n.type.name === 'inset') return isFoot(n) ? { pos: $p.before(d), node: n } : null;
  }
  return null;
}

/** a footnote reference at `pos` shown as a number (not inside another inset) */
function inText(state: EditorState, pos: number): boolean {
  const $p = state.doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'inset') return false;
  return true;
}

const labelOf = (n: PMNode): string | undefined =>
  /^label "(.*)"$/.exec((JSON.parse(String(n.attrs.params || '[]')) as string[]).find(l => l.startsWith('label ')) ?? '')?.[1];

/** the caret's place at the end of a note's text */
const noteEnd = (n: Note) => n.pos + n.node.nodeSize - 2;

/**
 * A click on a footnote's number: in the text (`to` 'note') the caret goes to the end of the note —
 * the first of its label when the reference repeats one —, at the end ('text') back after the reference.
 */
export function footnoteJump(view: EditorView, pos: number, to: 'note' | 'text'): void {
  const node = view.state.doc.nodeAt(pos);
  if (!isFoot(node)) return;
  let target: Note = { pos, node };
  if (to === 'note') {
    const label = labelOf(node);
    const first = label === undefined ? null : key.getState(view.state)?.notes.find(n => labelOf(n.node) === label && n.node.content.eq(node.content));
    if (first) target = first;
  }
  const at = to === 'note' ? noteEnd(target) : pos + node.nodeSize;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at), to === 'note' ? -1 : 1)).scrollIntoView());
  view.focus();
  const dom = view.nodeDOM(target.pos) as HTMLElement | null;
  dom?.classList.add('highlight');
  setTimeout(() => dom?.classList.remove('highlight'), 1200);
}

/** ← / → step over a reference; at the start / end of a note they go back into the text beside it */
function arrow(dir: -1 | 1, extend: boolean): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || (!sel.empty && !extend)) return false;
    const $h = sel.$head;
    const n = dir > 0 ? $h.nodeAfter : $h.nodeBefore;
    if (isFoot(n) && inText(state, $h.pos)) {
      const p = $h.pos + dir * n.nodeSize;
      dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, extend ? sel.anchor : p, p)).scrollIntoView());
      return true;
    }
    if (extend) return false;
    const note = noteAround(state, $h.pos);
    if (!note || $h.pos !== (dir > 0 ? noteEnd(note) : note.pos + 2)) return false;
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, dir > 0 ? note.pos + note.node.nodeSize : note.pos)).scrollIntoView());
    return true;
  };
}

/** Backspace / Delete beside a reference select it (the next one deletes the footnote) */
function selectBeside(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) return false;
    const n = dir > 0 ? sel.$head.nodeAfter : sel.$head.nodeBefore;
    if (!isFoot(n) || !inText(state, sel.head)) return false;
    dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, dir > 0 ? sel.head : sel.head - n.nodeSize)));
    return true;
  };
}

/** Escape in a note (not in a comment inside it): back to the text, after its reference */
const leaveNote: Command = (state, dispatch) => {
  const $f = state.selection.$from;
  let inner = -1;
  for (let d = $f.depth; d > 0; d--) if ($f.node(d).type.name === 'inset') { inner = d; break; }
  if (inner < 0 || !isFoot($f.node(inner))) return false;
  const note = noteAround(state, $f.pos);
  if (!note || note.pos !== $f.before(inner)) return false;
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, note.pos + note.node.nodeSize)).scrollIntoView());
  return true;
};

/** `[^label]` typed: that note again when the document has one, else a new footnote with the caret in it */
const footnoteRule = new InputRule(/\[\^([^\]\s"^]+)\]$/, (state, m, start, end) => {
  if (inRawText(state) || noteAround(state, start)) return null;
  const label = m[1];
  const same = notesOf(state.doc).find(n => labelOf(n.node) === label);
  const marks = editorContext.trackChanges && editorContext.changeAuthorId !== undefined
    ? JSON.stringify([{ type: 'change', attrs: { type: 'inserted', author: editorContext.changeAuthorId, time: Math.floor(Date.now() / 1000) } }]) : undefined;
  const node = same
    ? same.node.type.create({ ...same.node.attrs, ...(marks ? { marks } : {}) }, same.node.content)
    : schema.nodes.inset.create({ name: 'Foot', arg: '', params: JSON.stringify([`label "${label}"`]), status: 'open', ...(marks ? { marks } : {}) },
      schema.nodes.paragraph.create({ layout: 'Plain Layout' }));
  const tr = state.tr.replaceWith(start, end, node);
  const caret = same ? start + node.nodeSize : start + 2;
  return tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView();
});

/* ------------------------------------------------------------------ the notes at the end */

/** room above the first note (the rule) and between notes, in CSS px */
const HEAD = 22, GAP = 6;

function areaDom(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'md-fn-area';
  el.contentEditable = 'false';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** Place the notes' boxes, in order, over the area at the end of the document and make it as tall as they are. */
function layout(view: EditorView): void {
  const notes = key.getState(view.state)?.notes ?? [];
  const area = view.dom.querySelector<HTMLElement>(':scope > .md-fn-area');
  if (!area) return;
  const boxes: HTMLElement[] = [];
  for (const n of notes) {
    const dom = view.nodeDOM(n.pos) as HTMLElement | null;
    const box = dom?.querySelector<HTMLElement>(':scope > .inset-box');
    if (!dom || !box) continue;
    // the reference's tooltip: the note's text
    const anchor = dom.querySelector<HTMLElement>(':scope > .inset-anchor');
    const text = n.node.textContent.replace(/\s+/g, ' ').trim();
    if (anchor) anchor.title = text ? (text.length > 240 ? text.slice(0, 239) + '…' : text) : 'Empty footnote — click to write it';
    if (!dom.hasAttribute('data-repeat')) boxes.push(box);
  }
  const width = area.clientWidth;
  for (const b of boxes) b.style.width = width + 'px';
  // measure everything first (one layout), then place
  const scale = documentViewScale(view.dom);
  const a = area.getBoundingClientRect();
  const placed = boxes.map(b => {
    const op = b.offsetParent as HTMLElement | null;   // null: hidden (a folded section)
    return op && b.getClientRects().length ? { b, op, r: op.getBoundingClientRect(), h: b.offsetHeight } : null;
  });
  let y = HEAD;
  for (const p of placed) {
    if (!p) continue;
    p.b.style.top = `${(a.top - p.r.top) / scale + p.op.scrollTop + y}px`;
    p.b.style.left = `${(a.left - p.r.left) / scale + p.op.scrollLeft}px`;
    y += p.h + GAP;
  }
  area.style.height = `${y}px`;
}

/** Footnotes at the end of a markdown document (see the top of this file). */
export function markdownFootnotes(): Plugin[] {
  return [
    new Plugin<FootState>({
      key,
      state: {
        init: (_c, state) => ({ notes: notesOf(state.doc) }),
        apply: (tr, old, _o, state) => (tr.docChanged ? { notes: notesOf(state.doc) } : old),
      },
      props: {
        decorations(state) {
          const notes = key.getState(state)?.notes ?? [];
          if (!notes.length) return null;
          const active = noteAround(state, state.selection.from)?.pos;
          const decos = notes.map(n => Decoration.node(n.pos, n.pos + n.node.nodeSize, { class: n.pos === active ? 'fn-foot fn-active' : 'fn-foot' }));
          decos.push(Decoration.widget(state.doc.content.size, areaDom, { side: 1, key: 'md-fn-area', ignoreSelection: true, stopEvent: () => true }));
          return DecorationSet.create(state.doc, decos);
        },
      },
      view(view) {
        let raf = 0;
        const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (!view.isDestroyed) layout(view); }); };
        const observer = new ResizeObserver(schedule);
        observer.observe(view.dom);
        schedule();
        return {
          update: (v, prev) => {
            if (!key.getState(v.state)?.notes.length && !key.getState(prev)?.notes.length) return;
            // typing in a note: placed at once, so the caret ProseMirror scrolls to is where the note is
            if (noteAround(v.state, v.state.selection.head) && (v.state.doc !== prev.doc || !v.state.selection.eq(prev.selection))) { cancelAnimationFrame(raf); layout(v); }
            else if (v.state.doc !== prev.doc) schedule();
          },
          destroy: () => { observer.disconnect(); cancelAnimationFrame(raf); },
        };
      },
    }),
    keymap({
      ArrowRight: arrow(1, false), ArrowLeft: arrow(-1, false),
      'Shift-ArrowRight': arrow(1, true), 'Shift-ArrowLeft': arrow(-1, true),
      Backspace: chainCommands(undoInputRule, selectBeside(-1)),
      Delete: selectBeside(1),
      Escape: leaveNote,
    }),
  ];
}

export { footnoteRule };
