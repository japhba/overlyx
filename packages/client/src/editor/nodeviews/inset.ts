/**
 * Node view for text-containing insets (Note, Comment, Greyed out, ERT, Footnote, Float,
 * Caption, Box, Branch, Flex, Argument, ...): a LyX-style collapsible box with a label button.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { insetLabel } from '../layouts';
import { parseHeader, commentHeader, formatTimestamp } from '@overlyx/core';
import { editorContext } from '../context';

export class InsetView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  label: HTMLElement;
  anchor: HTMLElement;
  actions: HTMLElement;

  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('span');
    this.anchor = document.createElement('span');
    this.anchor.className = 'inset-anchor';
    this.anchor.contentEditable = 'false';
    this.label = document.createElement('span');
    this.label.className = 'inset-label';
    this.label.contentEditable = 'false';
    this.actions = document.createElement('span');
    this.actions.className = 'inset-actions';
    this.actions.contentEditable = 'false';
    this.contentDOM = document.createElement('span');
    this.contentDOM.className = 'inset-content';
    const box = document.createElement('span');
    box.className = 'inset-box';
    box.append(this.label, this.actions, this.contentDOM);
    this.dom.append(this.anchor, box);
    this.render();

    this.label.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      if (ev.detail === 2) return;
      this.toggle();
    });
    this.label.addEventListener('dblclick', (ev) => { ev.preventDefault(); editorContext.openInsetDialog?.(this.view, this.getPos()); });
    this.anchor.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      this.dom.classList.add('highlight');
      setTimeout(() => this.dom.classList.remove('highlight'), 1200);
      const pos = this.getPos();
      if (pos !== undefined) {
        this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(pos + 2))));
        this.view.focus();
      }
    });
  }

  private isComment(): boolean { return this.node.attrs.name === 'Note' && this.node.attrs.arg === 'Comment'; }

  private render() {
    const a = this.node.attrs;
    const name = String(a.name), arg = String(a.arg ?? '');
    const status = a.status === 'collapsed' ? 'collapsed' : 'open';
    this.dom.className = `lyx-inset lyx-inset-${name.toLowerCase()}${arg ? ' lyx-inset-' + name.toLowerCase() + '-' + arg.toLowerCase().replace(/[^a-z0-9]+/g, '-') : ''} ${status}`;
    this.dom.dataset.name = name;
    this.dom.dataset.arg = arg;
    this.label.textContent = insetLabel(name, arg, JSON.parse(a.params || '[]'));
    if (name === 'Note' || name === 'Foot' || name === 'Marginal' || name === 'ERT' || name === 'Float' || name === 'Caption' || name === 'Box' || name === 'Branch' || name === 'Flex' || name === 'Argument' || name === 'listings' || name === 'Index' || name === 'Wrap') {
      this.label.title = `${insetLabel(name, arg)} — click to ${status === 'open' ? 'collapse' : 'open'}, double-click for settings`;
    }
    // comment-thread controls
    this.actions.replaceChildren();
    if (this.isComment()) {
      const first = this.node.firstChild?.textContent ?? '';
      const h = parseHeader(first.trim());
      this.dom.classList.toggle('resolved', !!h?.resolved);
      const reply = document.createElement('button');
      reply.type = 'button'; reply.className = 'inset-action'; reply.textContent = 'Reply'; reply.title = 'Reply to this comment';
      reply.addEventListener('mousedown', (ev) => { ev.preventDefault(); this.reply(); });
      const resolve = document.createElement('button');
      resolve.type = 'button'; resolve.className = 'inset-action'; resolve.textContent = h?.resolved ? 'Reopen' : 'Resolve'; resolve.title = 'Mark this thread as resolved';
      resolve.addEventListener('mousedown', (ev) => { ev.preventDefault(); this.toggleResolved(); });
      this.actions.append(reply, resolve);
    }
    // change-tracking / font marks of the inset position
    try {
      const marks: { type: string; attrs?: Record<string, unknown> }[] = JSON.parse(a.marks || '[]');
      const ch = marks.find(m => m.type === 'change');
      if (ch) { this.dom.dataset.change = String(ch.attrs?.type); this.dom.dataset.author = String(ch.attrs?.author); this.dom.dataset.time = String(ch.attrs?.time ?? ''); }
      else { delete this.dom.dataset.change; delete this.dom.dataset.author; delete this.dom.dataset.time; }
    } catch { /* ignore */ }
  }

  toggle() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const cur = this.view.state.doc.nodeAt(pos);
    if (!cur) return;
    const status = cur.attrs.status === 'collapsed' ? 'open' : 'collapsed';
    let tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, status });
    // keep the cursor out of a collapsed inset
    const sel = this.view.state.selection;
    if (status === 'collapsed' && sel.from > pos && sel.from < pos + cur.nodeSize) {
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + cur.nodeSize)));
    }
    this.view.dispatch(tr);
  }

  reply() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const cur = this.view.state.doc.nodeAt(pos);
    if (!cur) return;
    const schema = this.view.state.schema;
    const user = editorContext.user?.name ?? 'Anonymous';
    const header = schema.nodes.paragraph.create({ layout: 'Plain Layout' }, schema.text(commentHeader(user, formatTimestamp())));
    const body = schema.nodes.paragraph.create({ layout: 'Plain Layout' });
    const end = pos + cur.nodeSize - 1; // before the closing token of the inset
    let tr = this.view.state.tr.insert(end, [header, body]);
    if (cur.attrs.status === 'collapsed') tr = tr.setNodeMarkup(pos, undefined, { ...cur.attrs, status: 'open' });
    tr = tr.setSelection(TextSelection.create(tr.doc, end + header.nodeSize + 1));
    this.view.dispatch(tr);
    this.view.focus();
  }

  toggleResolved() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const cur = this.view.state.doc.nodeAt(pos);
    if (!cur || !cur.firstChild) return;
    const first = cur.firstChild;
    const h = parseHeader(first.textContent.trim());
    const schema = this.view.state.schema;
    const user = editorContext.user?.name ?? 'Anonymous';
    if (!h) {
      // a plain LyX comment: turn it into a thread by prepending a header
      const header = schema.nodes.paragraph.create({ layout: 'Plain Layout' }, schema.text(commentHeader(user, formatTimestamp(), true)));
      this.view.dispatch(this.view.state.tr.insert(pos + 1, header));
      return;
    }
    const text = commentHeader(h.author, h.time, !h.resolved);
    const from = pos + 1, to = pos + 1 + first.nodeSize;
    const para = schema.nodes.paragraph.create(first.attrs, schema.text(text));
    this.view.dispatch(this.view.state.tr.replaceWith(from, to, para));
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  stopEvent(ev: Event) {
    return this.actions.contains(ev.target as Node);
  }
  ignoreMutation(m: MutationRecord | { type: 'selection' }) {
    if (m.type === 'selection') return false;
    return !this.contentDOM.contains((m as MutationRecord).target);
  }
}
