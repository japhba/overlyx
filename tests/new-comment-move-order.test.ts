// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { Net, par, text } from './yjs-net';
import { insertComment } from '../packages/client/src/editor/commands';
import { InsetView } from '../packages/client/src/editor/nodeviews/inset';
import { editorContext } from '../packages/client/src/editor/context';
import { parseHeader } from '../packages/core/src/comments';

for (const repair of [false, true]) it(`a new comment keeps its header before the empty message through synchronization (repair ${repair})`, () => {
  const net = new Net({ type: 'doc', content: [par(text('We explain the method here.'))] }, { repair });
  const a = net.peer('a', 100), b = net.peer('b', 200);
  const previousUser = editorContext.user;
  editorContext.user = { id: 1, name: 'Nora Test', username: 'nora', color: '#000' } as typeof editorContext.user;
  const comment = (doc: PMNode): { node: PMNode; pos: number } => {
    const found: { node: PMNode; pos: number }[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === 'inset' && node.attrs.name === 'Note' && node.attrs.arg === 'Comment') found.push({ node, pos });
    });
    expect(found).toHaveLength(1);
    return found[0];
  };
  const check = (doc: PMNode) => {
    const { node, pos } = comment(doc);
    expect(node.childCount).toBe(2);
    expect(parseHeader(node.firstChild!.textContent)?.author).toBe('Nora Test');
    expect(node.lastChild!.content.size).toBe(0);
    const view = new InsetView(node, a.view, () => pos);
    expect(view.actions.querySelector('[data-act="reply"]')?.textContent).toBe('Comment');
    expect(doc.textContent).toContain('We explain');
    expect(doc.textContent).toContain(' the method here.');
  };
  try {
    const from = a.find('explain');
    a.select(from, from + 'explain'.length);
    expect(insertComment(a.view.state, a.view.dispatch, a.view)).toBe(true);
    check(a.view.state.doc);
    net.converged();
    check(a.view.state.doc);
    check(b.view.state.doc);
    // The same header/body pair must retain its order when appended as a reply
    // to an existing thread, whose parent is no longer new in this transaction.
    a.type('First comment.');
    net.converged();
    const existing = comment(a.view.state.doc);
    const view = new InsetView(existing.node, a.view, () => existing.pos);
    expect(view.actions.querySelector('[data-act="reply"]')?.textContent).toBe('Reply');
    view.reply();
    net.converged();
    for (const peer of [a, b]) {
      const reply = comment(peer.view.state.doc).node;
      expect(reply.childCount).toBe(4);
      expect(parseHeader(reply.child(0).textContent)?.author).toBe('Nora Test');
      expect(reply.child(1).textContent).toBe('First comment.');
      expect(parseHeader(reply.child(2).textContent)?.author).toBe('Nora Test');
      expect(reply.child(3).content.size).toBe(0);
    }
  } finally {
    editorContext.user = previousUser;
    for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); }
    net.server.destroy();
  }
});
