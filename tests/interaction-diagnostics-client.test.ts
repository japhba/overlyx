// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { deleteSelection } from 'prosemirror-commands';
import { schema } from '../packages/core/src/schema.ts';
import { parseInteractionDetail } from '../packages/core/src/interactions.ts';
import { recordInteraction, recordUsage, pendingUsage, resetUsageForTests, interactionTarget } from '../packages/client/src/usage.ts';
import { setPref } from '../packages/client/src/prefs.ts';
import { usagePlugin } from '../packages/client/src/editor/plugins/usage.ts';

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
        await Promise.resolve();
        const event = pendingUsage().find(e => e.name === 'interaction')!;
        expect(parseInteractionDetail(event.detail)).toMatchObject({ action: 'delete', outcome: editable ? 'unchanged' : 'denied', state: { content: 'empty' } });
      } finally { view.destroy(); }
    }
  });
});
