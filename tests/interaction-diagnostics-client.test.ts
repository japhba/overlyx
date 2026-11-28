// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { deleteSelection } from 'prosemirror-commands';
import { schema } from '../packages/core/src/schema.ts';
import { parseInteractionDetail } from '../packages/core/src/interactions.ts';
import { recordInteraction, recordUsage, pendingUsage, resetUsageForTests, interactionTarget } from '../packages/client/src/usage.ts';
import { setPref } from '../packages/client/src/prefs.ts';
import { usagePlugin, awaitOutcome } from '../packages/client/src/editor/plugins/usage.ts';
import { ySyncPluginKey } from '../packages/client/src/editor/collab.ts';

beforeEach(() => { resetUsageForTests(); setPref('usageStats', true); });
afterEach(() => { resetUsageForTests(); delete (navigator as any).globalPrivacyControl; document.body.replaceChildren(); });

describe('content-free detailed diagnostics', () => {
  it('honours opt-out and GPC and rejects data outside the fixed vocabulary', () => {
    setPref('usageStats', false);
    recordInteraction('delete', 'unchanged', { target: 'note' });
    expect(pendingUsage()).toEqual([]);
    setPref('usageStats', true);
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: true });
    recordInteraction('click', 'attempt');
    expect(pendingUsage()).toEqual([]);
    delete (navigator as any).globalPrivacyControl;
    recordInteraction('delete', 'unchanged', { target: 'note', content: 'empty', display: 'margin', durationMs: 251 });
    recordInteraction('private note text' as any, 'failed');
    recordInteraction('delete', 'failed', { target: 'private-project' as any });
    recordUsage('interaction', 'delete failed private document', { where: 'note' });
    const events = pendingUsage();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'interaction', where: 'note', dt: 500 });
    expect(parseInteractionDetail(events[0].detail)?.state).toMatchObject({ content: 'empty', display: 'margin' });
    setPref('usageStats', false); setPref('usageStats', true);
    expect(pendingUsage()).toEqual([]);
  });

  it('classifies surfaces without using document labels or values', () => {
    const el = document.createElement('div');
    el.innerHTML = '<div class="filetree" data-project="secret/project"><button>Private title</button></div><span class="lyx-inset-note lyx-inset-note-comment"><input value="secret text"></span>';
    expect(interactionTarget(el.querySelector('button'))).toBe('files');
    expect(interactionTarget(el.querySelector('input'))).toBe('comment');
  });

  it('observes deletion of a selected note and records no text or positions', async () => {
    const note = schema.nodes.inset.create({ name: 'Note', arg: 'Note' }, schema.nodes.paragraph.create(null, schema.text('Confidential note')));
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.text('Before'), note, schema.text('After')]));
    const pos = 1 + 'Before'.length;
    const view = new EditorView(document.body.appendChild(document.createElement('div')), {
      state: EditorState.create({ doc, selection: NodeSelection.create(doc, pos), plugins: [usagePlugin()] }),
      handleKeyDown: (v, ev) => ev.key === 'Delete' && deleteSelection(v.state, v.dispatch),
    });
    try {
      view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
      await Promise.resolve();
      expect(view.state.doc.textContent).toBe('BeforeAfter');
      const event = pendingUsage().find(e => e.name === 'interaction')!;
      expect(parseInteractionDetail(event.detail)).toMatchObject({ action: 'delete', outcome: 'removed', state: { selection: 'node', content: 'filled', access: 'edit' } });
      expect(event.where).toBe('note');
      expect(JSON.stringify(pendingUsage())).not.toMatch(/Confidential|Before|After|notePos|private/);
    } finally { view.destroy(); }
  });

  it('distinguishes an unchanged empty note from a read-only deletion attempt', async () => {
    for (const editable of [true, false]) {
      resetUsageForTests();
      const note = schema.nodes.inset.create({ name: 'Note', arg: 'Note' }, schema.nodes.paragraph.create());
      const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.text('x'), note]));
      const view = new EditorView(document.body.appendChild(document.createElement('div')), {
        state: EditorState.create({ doc, selection: TextSelection.create(doc, 4), plugins: [usagePlugin()] }), editable: () => editable,
      });
      try {
        view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
        // nothing is known yet for a key that may still act; the next action settles it
        expect(pendingUsage().filter(e => e.name === 'interaction')).toHaveLength(editable ? 0 : 1);
        view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const event = pendingUsage().find(e => e.name === 'interaction')!;
        expect(parseInteractionDetail(event.detail)).toMatchObject({ action: 'delete', outcome: editable ? 'unchanged' : 'denied', state: { content: 'empty' } });
      } finally { view.destroy(); }
    }
  });

  // What every real Backspace in a text is: the browser deletes the character as the key's default
  // action — after the microtask checkpoint that follows each listener — and ProseMirror reads the
  // change from the DOM. Decided in a microtask of the keydown listener, all of them read "unchanged".
  it('records a key whose change arrives after the keydown listeners as changed, a dead key as unchanged', async () => {
    vi.useFakeTimers();
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('word')));
    const view = new EditorView(document.body.appendChild(document.createElement('div')), {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 5), plugins: [usagePlugin()] }),
    });
    const outcomes = () => pendingUsage().filter(e => e.name === 'interaction').map(e => { const d = parseInteractionDetail(e.detail)!; return `${d.action} ${d.outcome}`; });
    try {
      view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
      await Promise.resolve();
      view.dispatch(view.state.tr.delete(4, 5));   // the native deletion, read from the DOM
      expect(outcomes()).toEqual(['backspace changed']);
      // a co-author's change is not this key's doing
      view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
      view.dispatch(view.state.tr.insertText('!', 1).setMeta(ySyncPluginKey, { isChangeOrigin: true }));
      vi.advanceTimersByTime(300);
      expect(outcomes()).toEqual(['backspace changed', 'backspace unchanged']);
      // a paste parsed on the server: decided when the answer is in
      let answer!: () => void;
      view.dom.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
      void awaitOutcome(view, new Promise<void>(r => { answer = r; }));
      vi.advanceTimersByTime(2000);
      expect(outcomes()).toHaveLength(2);
      view.dispatch(view.state.tr.insertText('pasted', 1));
      answer();
      expect(outcomes()).toEqual(['backspace changed', 'backspace unchanged', 'paste changed']);
    } finally { view.destroy(); vi.useRealTimers(); }
  });
});
