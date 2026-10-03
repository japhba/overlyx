import { Plugin, PluginKey, TextSelection, type SelectionBookmark } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Fragment, Slice } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { api } from '../../api';

const key = new PluginKey<Map<object, SelectionBookmark>>('paste-targets');
export function pasteTargetsPlugin(): Plugin {
  return new Plugin({
    key,
    state: {
      init: () => new Map(),
      apply(tr, previous) {
        const next = new Map([...previous].map(([id, bookmark]) => [id, bookmark.map(tr.mapping)]));
        const action = tr.getMeta(key);
        if (action?.add) next.set(action.add, tr.selection.getBookmark());
        if (action?.remove) next.delete(action.remove);
        return next;
      },
    },
  });
}

/** Hold the paste selection through edits and cursor movement while parsing is in flight. */
export async function pasteLatex(view: EditorView, docId: string, text: string): Promise<void> {
  const id = {};
  view.dispatch(view.state.tr.setMeta(key, { add: id }));
  let slice: Slice;
  try {
    const r = await api.parseClip(docId, text);
    const blocks = r.blocks.map(b => schema.nodeFromJSON(b)).filter(n => n.type.name !== 'doc');
    if (!blocks.length) throw new Error('empty parsed paste');
    const single = blocks.length === 1 && blocks[0].type.name === 'paragraph' && blocks[0].attrs.layout === 'Standard' && !blocks[0].attrs.depth;
    slice = new Slice(single ? blocks[0].content : Fragment.from(blocks), 0, 0);
  } catch (e) {
    console.warn('LaTeX paste fell back to plain text:', e);
    const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => schema.nodes.paragraph.create({ layout: 'Standard' }, p ? schema.text(p.replace(/\n/g, ' ')) : null));
    slice = paragraphs.length === 1 ? new Slice(paragraphs[0].content, 0, 0) : new Slice(Fragment.from(paragraphs), 1, 1);
  }
  if (view.isDestroyed) return;
  const bookmark = key.getState(view.state)?.get(id);
  if (!bookmark) return;
  const target = bookmark.resolve(view.state.doc);
  const current = view.state.selection;
  const moved = !current.eq(target);
  const tr = view.state.tr.setSelection(target).replaceSelection(slice).setMeta(key, { remove: id });
  if (moved) tr.setSelection(current.map(tr.doc, tr.mapping));
  view.dispatch(moved ? tr : tr.scrollIntoView());
}

/**
 * Several blocks pasted into an empty paragraph take its place, so that the first keeps its layout —
 * a pasted heading stays a heading (ProseMirror would pour its text into the empty paragraph, which
 * keeps its own layout). One paragraph, or blocks pasted into text, are left to ProseMirror: they
 * merge with the paragraph, or split it.
 */
export function pasteBlocksIntoEmpty(view: EditorView, slice: Slice): boolean {
  const sel = view.state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return false;
  const { $from } = sel;
  if ($from.parent.type !== schema.nodes.paragraph || $from.parent.content.size || slice.content.childCount < 2) return false;
  let blocks = true;
  slice.content.forEach(n => { if (n.type !== schema.nodes.paragraph) blocks = false; });
  if (!blocks) return false;
  const at = $from.before();
  const tr = view.state.tr.replaceWith(at, $from.after(), slice.content);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + slice.content.size - 1), -1));
  view.dispatch(tr.scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
  return true;
}
