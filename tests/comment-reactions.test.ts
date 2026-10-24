/**
 * Reactions to comment messages (core comments.ts, client editor/plugins/reactions.ts): kept in the
 * message's header — "Bob (time) (👍: Ada, Kirsten; Yes: Ada):" — read back, toggled per person,
 * kept when the thread is resolved, and allowed on other people's messages.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { commentHeader, parseHeader, parseThread } from '../packages/core/src/index.ts';
import { toggled, toggleReaction } from '../packages/client/src/editor/plugins/reactions.ts';
import { commentGuardPlugin } from '../packages/client/src/editor/plugins/commentguard.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';

describe('the header', () => {
  it('writes and reads reactions after the time (and after [resolved])', () => {
    const h = commentHeader('Bob', '2026-10-10 12:00', true, [{ key: '👍', who: ['Ada', 'Kirsten'] }, { key: 'Yes', who: ['Ada'] }]);
    expect(h).toBe('Bob (2026-10-10 12:00) [resolved] (👍: Ada, Kirsten; Yes: Ada):');
    expect(parseHeader(h)).toEqual({ author: 'Bob', time: '2026-10-10 12:00', resolved: true, reactions: [{ key: '👍', who: ['Ada', 'Kirsten'] }, { key: 'Yes', who: ['Ada'] }] });
    expect(parseHeader('Bob (2026-10-10 12:00):')!.reactions).toEqual([]);
  });
  it('merges two groups (two people reacting at once) and drops what cannot be stored', () => {
    expect(parseHeader('Bob (2026-10-10 12:00) (👍: Ada) (👍: Kirsten; No: Ada):')!.reactions).toEqual([{ key: '👍', who: ['Ada', 'Kirsten'] }, { key: 'No', who: ['Ada'] }]);
    expect(commentHeader('Bob', '2026-10-10 12:00', false, [{ key: 'ok; (x)', who: ['A, B'] }, { key: '🎉', who: [] }])).toBe('Bob (2026-10-10 12:00) (ok x: A B):');
  });
  it('a thread with reactions still reads as its messages', () => {
    const t = parseThread([
      { items: [{ kind: 'text', text: 'Bob (2026-10-10 12:00) (👍: Ada):' }] },
      { items: [{ kind: 'text', text: 'Ship it?' }] },
    ] as never);
    expect(t.messages).toEqual([{ author: 'Bob', time: '2026-10-10 12:00', text: 'Ship it?' }]);
  });
});

describe('toggling', () => {
  const mine = (n: string) => n === 'Ada';
  it('adds one’s own, takes it back, keeps the others', () => {
    expect(toggled([], 'Yes', 'Ada', mine)).toEqual([{ key: 'Yes', who: ['Ada'] }]);
    expect(toggled([{ key: 'Yes', who: ['Bob'] }], 'Yes', 'Ada', mine)).toEqual([{ key: 'Yes', who: ['Bob', 'Ada'] }]);
    expect(toggled([{ key: 'Yes', who: ['Bob', 'Ada'] }], 'Yes', 'Ada', mine)).toEqual([{ key: 'Yes', who: ['Bob'] }]);
    expect(toggled([{ key: 'Yes', who: ['Ada'] }, { key: '👍', who: ['Bob'] }], 'Yes', 'Ada', mine)).toEqual([{ key: '👍', who: ['Bob'] }]);
  });

  beforeEach(() => { editorContext.user = { id: 1, name: 'Ada', username: 'ada', color: '#000' } as typeof editorContext.user; editorContext.myNames = []; });
  it('reacting to someone else’s message changes only the header, past the comment guard', () => {
    const plain = (text: string) => schema.nodes.paragraph.create({ layout: 'Plain Layout' }, schema.text(text));
    const thread = schema.nodes.inset.create({ name: 'Note', arg: 'Comment', params: '[]', status: 'open' }, [plain(commentHeader('Bob', '2026-10-10 12:00')), plain('Ship it?')]);
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ layout: 'Standard' }, [schema.text('Text '), thread])]);
    let start = -1;
    doc.descendants((n: PMNode, pos: number) => { if (n.type.name === 'inset') { start = pos; return false; } return true; });
    const view = { state: EditorState.create({ doc, plugins: [commentGuardPlugin()] }), dispatch(tr: Transaction) { view.state = view.state.apply(tr); } };
    toggleReaction(view as unknown as EditorView, start + 1, 'Yes');
    expect(view.state.doc.nodeAt(start)!.firstChild!.textContent).toBe('Bob (2026-10-10 12:00) (Yes: Ada):');
    toggleReaction(view as unknown as EditorView, start + 1, '👍');
    expect(view.state.doc.nodeAt(start)!.firstChild!.textContent).toBe('Bob (2026-10-10 12:00) (Yes: Ada; 👍: Ada):');
    toggleReaction(view as unknown as EditorView, start + 1, 'Yes');
    toggleReaction(view as unknown as EditorView, start + 1, '👍');
    expect(view.state.doc.nodeAt(start)!.firstChild!.textContent).toBe('Bob (2026-10-10 12:00):');
    expect(view.state.doc.nodeAt(start)!.lastChild!.textContent).toBe('Ship it?');
  });
});
