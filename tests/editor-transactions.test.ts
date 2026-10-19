// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { schema } from '@overlyx/core';
import { writeDocument } from '@overlyx/core/collab/index.ts';
import { dispatchTransactionProp } from '../packages/client/src/editor/assembly';
import { collabSync, cursorPlugin } from '../packages/client/src/editor/collab';

it('keeps the document when a queued awareness update outlives a replaced editor view', async () => {
  const ydoc = new Y.Doc(), awareness = new Awareness(ydoc);
  ydoc.transact(() => writeDocument(schema, ydoc, schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unsaved draft' }] }] })));
  const mount = () => {
    const sync = collabSync(ydoc);
    const view: EditorView = new EditorView(document.createElement('div'), { state: EditorState.create({ doc: sync.doc, plugins: [sync.plugin, cursorPlugin(awareness)] }), dispatchTransaction: dispatchTransactionProp(() => view, () => false) });
    return { view, sync };
  };
  const first = mount();
  awareness.setLocalStateField('user', { name: 'Author', color: '#123456' });
  first.view.destroy(); first.sync.destroy();
  const replacement = mount();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(replacement.view.state.doc.textContent).toBe('Unsaved draft');
  replacement.view.dispatch(replacement.view.state.tr.insertText(' survives', replacement.view.state.doc.content.size - 1));
  expect(replacement.view.state.doc.textContent).toBe('Unsaved draft survives');
  replacement.view.destroy(); replacement.sync.destroy();
  awareness.destroy(); ydoc.destroy();
});
