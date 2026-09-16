// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ySyncPlugin, yCursorPlugin, prosemirrorJSONToYXmlFragment, initProseMirrorDoc } from 'y-prosemirror';
import { schema } from '@overlyx/core';
import { editorTransactions } from '../packages/client/src/editor/transactions';

it('keeps the document when a queued awareness update outlives a replaced editor view', async () => {
  const ydoc = new Y.Doc(), awareness = new Awareness(ydoc), fragment = ydoc.getXmlFragment('prosemirror');
  prosemirrorJSONToYXmlFragment(schema, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unsaved draft' }] }] }, fragment);
  const mount = () => {
    const { doc, mapping } = initProseMirrorDoc(fragment, schema);
    return new EditorView(document.createElement('div'), { state: EditorState.create({ doc, plugins: [ySyncPlugin(fragment, { mapping }), yCursorPlugin(awareness)] }), dispatchTransaction: editorTransactions(() => false) });
  };
  const first = mount();
  awareness.setLocalStateField('user', { name: 'Author', color: '#123456' });
  first.destroy();
  const replacement = mount();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(replacement.state.doc.textContent).toBe('Unsaved draft');
  replacement.dispatch(replacement.state.tr.insertText(' survives', replacement.state.doc.content.size - 1));
  expect(replacement.state.doc.textContent).toBe('Unsaved draft survives');
  replacement.destroy();
  awareness.destroy(); ydoc.destroy();
});
