/**
 * Comment threads while writing (client editor/plugins/commentui.ts): the thread under the cursor is
 * marked, Ctrl+Enter leaves it, and a message left empty goes when the cursor leaves the thread — the
 * user's own only. A resolved thread is not in the text (unless shown): the caret steps over it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { commentHeader } from '../packages/core/src/index.ts';
import { commentUiPlugin, emptyTail, threadAt, hiddenThreadsPlugin } from '../packages/client/src/editor/plugins/commentui.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';
import { setPref } from '../packages/client/src/prefs.ts';

const plain = (text = '') => schema.nodes.paragraph.create({ layout: 'Plain Layout' }, text ? schema.text(text) : undefined);
const header = (who: string) => plain(commentHeader(who, '2026-10-10 12:00'));
const thread = (...pars: PMNode[]) => schema.nodes.inset.create({ name: 'Note', arg: 'Comment', params: '[]', status: 'open' }, pars);
const docWith = (t: PMNode) => schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ layout: 'Standard' }, [schema.text('Before '), t, schema.text(' after.')])]);

describe('emptyTail', () => {
  it('takes the last message when it is mine and empty, the whole thread when it was the only one', () => {
    expect(emptyTail(thread(header('Ada'), plain()), 'Ada')).toBe('thread');
    const t = thread(header('Bob'), plain('Check this.'), header('Ada'), plain());
    const cut = emptyTail(t, 'Ada');
    expect(cut).not.toBeNull();
    expect(cut).not.toBe('thread');
    const { from, to } = cut as { from: number; to: number };
    // what stays is Bob's message
    const kept = t.content.cut(0, from - 1);
    expect(kept.childCount).toBe(2);
    expect(to).toBe(t.content.size + 1);
  });
  it('leaves written messages and other people’s empty ones alone', () => {
    expect(emptyTail(thread(header('Ada'), plain('Written.')), 'Ada')).toBeNull();
    expect(emptyTail(thread(header('Bob'), plain()), 'Ada')).toBeNull();
    expect(emptyTail(thread(plain('a plain LyX comment')), 'Ada')).toBeNull();
  });
});

describe('the plugin', () => {
  beforeEach(() => { editorContext.user = { id: 1, name: 'Ada', username: 'ada', color: '#000' } as typeof editorContext.user; });
  const setup = (t: PMNode) => {
    const doc = docWith(t);
    let start = -1;
    doc.descendants((n, pos) => { if (n.type.name === 'inset') { start = pos; return false; } return true; });
    return { state: EditorState.create({ doc, plugins: [commentUiPlugin()] }), start, node: doc.nodeAt(start)! };
  };
  it('a new comment left empty goes when the cursor leaves it', () => {
    const { state, start, node } = setup(thread(header('Ada'), plain()));
    const inside = state.apply(state.tr.setSelection(TextSelection.create(state.doc, start + node.nodeSize - 2)));
    expect(threadAt(inside, inside.selection.head)?.pos).toBe(start);
    const out = inside.applyTransaction(inside.tr.setSelection(TextSelection.create(inside.doc, start + node.nodeSize + 2))).state;
    let threads = 0;
    out.doc.descendants(n => { if (n.type.name === 'inset') threads++; });
    expect(threads).toBe(0);
    expect(out.doc.textContent).toBe('Before  after.');
  });
  it('an empty reply goes, the written thread stays', () => {
    const { state, start, node } = setup(thread(header('Bob'), plain('Check this.'), header('Ada'), plain()));
    const inside = state.apply(state.tr.setSelection(TextSelection.create(state.doc, start + node.nodeSize - 2)));
    const out = inside.applyTransaction(inside.tr.setSelection(TextSelection.create(inside.doc, 2))).state;
    const t = out.doc.nodeAt(start)!;
    expect(t.childCount).toBe(2);
    expect(t.lastChild!.textContent).toBe('Check this.');
  });
  it('moving inside the thread takes nothing away', () => {
    const { state, start, node } = setup(thread(header('Ada'), plain()));
    const a = state.apply(state.tr.setSelection(TextSelection.create(state.doc, start + node.nodeSize - 2)));
    const b = a.applyTransaction(a.tr.setSelection(TextSelection.create(a.doc, start + 3))).state;
    expect(b.doc.nodeAt(start)?.type.name).toBe('inset');
  });
});

describe('resolved threads are not in the text', () => {
  const resolved = thread(plain(commentHeader('Bob', '2026-10-10 12:00', true)), plain('Old remark.'));
  const setup = () => {
    const doc = docWith(resolved);
    let start = -1;
    doc.descendants((n, pos) => { if (n.type.name === 'inset') { start = pos; return false; } return true; });
    const plugin = hiddenThreadsPlugin();
    const view = { state: EditorState.create({ doc, plugins: [plugin] }), dispatch(tr: Transaction) { view.state = view.state.apply(tr); } };
    const key = (k: string) => (plugin.props.handleKeyDown as any)(view, { key: k, shiftKey: false });
    const at = (pos: number) => { view.state = view.state.applyTransaction(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))).state; };
    return { view, key, at, start, end: start + doc.nodeAt(start)!.nodeSize };
  };
  it('Backspace and Delete next to one go past it first (the key then takes the character beyond)', () => {
    const { view, key, at, start, end } = setup();
    at(end);
    expect(key('Backspace')).toBe(false);
    expect(view.state.selection.head).toBe(start);
    expect(key('Delete')).toBe(false);
    expect(view.state.selection.head).toBe(end);
    expect(key('ArrowLeft')).toBe(false);
    expect(view.state.selection.head).toBe(start);
  });
  it('a cursor put inside one waits right after it', () => {
    const { view, at, start, end } = setup();
    at(start + 3);
    expect(view.state.selection.head).toBe(end);
  });
  it('shown in the text (View ▸ Resolved comments in the text), it is an inset like any other', () => {
    setPref('showResolvedComments', true);
    try {
      const { view, key, at, start, end } = setup();
      at(start + 3);
      expect(view.state.selection.head).toBe(start + 3);
      at(end);
      key('Backspace');
      expect(view.state.selection.head).toBe(end);
    } finally { setPref('showResolvedComments', false); }
  });
});

