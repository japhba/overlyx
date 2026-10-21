/**
 * Node view for text-containing insets (Note, Comment, Greyed out, ERT, Footnote, Float,
 * Caption, Box, Branch, Flex, Argument, ...): a LyX-style collapsible box with a label button.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { insetLabel, argumentLabel } from '../layouts';
import { parseHeader, commentHeader, formatTimestamp } from '@overlyx/core';
import { editorContext } from '../context';
import { toggleCommentResolved } from '../commentops';
import { recordInteraction } from '../../usage';
import { footnoteJump } from '../plugins/mdfootnotes';
import type { InteractionAction, InteractionOutcome } from '@overlyx/core/interactions.ts';

export class InsetView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  label: HTMLElement;
  anchor: HTMLElement;
  actions: HTMLElement;
  /** the classes render() sets; the others on `dom` belong to someone else (the margin layout's
   * `in-margin`, decorations, the anchor's `highlight`) and must survive a re-render */
  private own: string[] = [];
  /** what the action buttons were built for: '' (no comment), 'open' or 'resolved' */
  private controls = '';

  constructor(protected node: PMNode, protected view: EditorView, protected getPos: () => number | undefined) {
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
      ev.stopPropagation();   // PM's own mouse handling would re-place the cursor on mouseup, undoing toggle()'s selection
      if (ev.detail === 2) return;
      // a markdown footnote's number at the end of the document: back to its reference
      if (this.dom.classList.contains('fn-foot')) { const pos = this.getPos(); if (pos !== undefined) footnoteJump(this.view, pos, 'text'); return; }
      this.toggle();
    });
    this.label.addEventListener('dblclick', (ev) => { ev.preventDefault(); editorContext.openInsetDialog?.(this.view, this.getPos()); });
    this.anchor.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      // a markdown footnote's number in the text: to the note at the end of the document
      if (this.dom.classList.contains('fn-foot')) { const pos = this.getPos(); if (pos !== undefined) footnoteJump(this.view, pos, 'note'); return; }
      this.dom.classList.add('highlight');
      setTimeout(() => this.dom.classList.remove('highlight'), 1200);
      const pos = this.getPos();
      if (pos === undefined) return;
      // a comment's chip opens the thread at the end of its last message (ready to read on or add a
      // line); other notes put the cursor at their start
      const cur = this.view.state.doc.nodeAt(pos);
      const at = this.isComment() && cur && !this.dom.classList.contains('resolved') ? pos + cur.nodeSize - 2 : pos + 2;
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(at), at === pos + 2 ? 1 : -1)));
      this.view.focus();
    });
  }

  private isComment(): boolean { return this.node.attrs.name === 'Note' && this.node.attrs.arg === 'Comment'; }

  private recordAction(action: InteractionAction, outcome: InteractionOutcome): void {
    if (this.node.attrs.name !== 'Note') return;
    recordInteraction(action, outcome, {
      target: this.isComment() ? 'comment' : this.node.attrs.arg === 'Greyedout' ? 'greyedout' : 'note',
      content: this.node.content.size <= 2 ? 'empty' : 'filled',
      display: this.dom.classList.contains('in-margin') ? 'margin' : this.node.attrs.status === 'collapsed' ? 'collapsed' : 'inline',
      access: this.view.editable ? 'edit' : 'view', tracking: editorContext.trackChanges ? 'on' : 'off',
    });
  }

  private argumentOwner(): string | null {
    try {
      const pos = this.getPos();
      if (pos === undefined) return null;
      const $p = this.view.state.doc.resolve(pos);
      const outer = $p.depth >= 2 ? $p.node($p.depth - 1) : null;
      if (outer?.type.name === 'inset' && outer.attrs.name !== 'Argument') return 'inset:' + (outer.attrs.name === 'Flex' ? outer.attrs.arg : outer.attrs.name);
      return String($p.parent.attrs.layout ?? '') || null;
    } catch { return null; }
  }

  private render() {
    const a = this.node.attrs;
    const name = String(a.name), arg = String(a.arg ?? '');
    const status = a.status === 'collapsed' ? 'collapsed' : 'open';
    // (rewriting className dropped `in-margin` on every keystroke in a comment: the card fell back
    // into the text until the next layout frame — the box flashed and the text under it jumped)
    const own = ['lyx-inset', `lyx-inset-${name.toLowerCase()}`, ...(arg ? [`lyx-inset-${name.toLowerCase()}-${arg.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`] : []), status];
    for (const c of this.own) if (!own.includes(c)) this.dom.classList.remove(c);
    this.dom.classList.add(...own);
    this.own = own;
    this.dom.dataset.name = name;
    this.dom.dataset.arg = arg;
    // a float as wide as the page (figure*; an article's `<figure class="wide">`)
    if (name === 'Float' && String(a.params ?? '').includes('wide true')) this.dom.dataset.wide = ''; else delete this.dom.dataset.wide;
    this.label.textContent = insetLabel(name, arg, JSON.parse(a.params || '[]'));
    if (name === 'Argument') {
      // whose argument: the paragraph's layout, or the inset whose first paragraph holds it (LyX's label)
      const setOwner = () => {
        const owner = this.argumentOwner();
        if (owner) this.dom.dataset.owner = owner; else delete this.dom.dataset.owner;
        this.label.textContent = argumentLabel(owner, arg, this.node.textContent);
        return owner;
      };
      // (while the view is being built the position is not known yet: once it is)
      if (!setOwner()) queueMicrotask(() => { if (this.dom.isConnected || this.view) setOwner(); });
    }
    if (name === 'Note' || name === 'Foot' || name === 'Marginal' || name === 'ERT' || name === 'Float' || name === 'Caption' || name === 'Box' || name === 'Branch' || name === 'Flex' || name === 'Argument' || name === 'listings' || name === 'Index' || name === 'Wrap') {
      this.label.title = `${insetLabel(name, arg)} — click to ${status === 'open' ? 'collapse' : 'open'}, double-click for settings`;
    }
    // comment-thread controls (rebuilt only when they change: every keystroke in the thread re-renders)
    const h = this.isComment() ? parseHeader((this.node.firstChild?.textContent ?? '').trim()) : null;
    this.dom.classList.toggle('resolved', !!h?.resolved);
    if (this.isComment()) {
      // the chip in the text: how many messages the thread has, and who started it
      let n = 0;
      this.node.forEach(p => { if (parseHeader(p.textContent.trim())) n++; });
      this.anchor.dataset.count = String(Math.max(1, n));
      if (!h?.resolved) this.anchor.title = `Comment${h?.author ? ' by ' + h.author : ''}${n > 1 ? ` · ${n - 1} repl${n === 2 ? 'y' : 'ies'}` : ''} — click to open`;
    }
    const controls = this.isComment() ? (h?.resolved ? 'resolved' : 'open') : '';
    if (controls !== this.controls) {
      this.controls = controls;
      this.actions.replaceChildren();
    }
    if (controls && !this.actions.firstChild) {
      // a resolved thread leaves the text: its marker stays (the Comments panel lists it and can reopen it)
      if (h?.resolved) this.anchor.title = 'Resolved comment — click to put the cursor here; the Comments panel lists it and can reopen it';
      // Reply: a field at the foot of the open card; Resolve: the ✓ in its corner (the words stay the buttons' text)
      const reply = document.createElement('button');
      reply.type = 'button'; reply.className = 'inset-action'; reply.dataset.act = 'reply'; reply.textContent = 'Reply'; reply.title = 'Reply to this comment';
      reply.addEventListener('mousedown', (ev) => { ev.preventDefault(); this.reply(); });
      const resolve = document.createElement('button');
      resolve.type = 'button'; resolve.className = 'inset-action'; resolve.dataset.act = h?.resolved ? 'reopen' : 'resolve'; resolve.textContent = h?.resolved ? 'Reopen' : 'Resolve';
      resolve.title = h?.resolved ? 'Reopen this thread' : 'Resolve: the thread leaves the text (Ctrl+Z undoes it; the Comments panel can reopen it)';
      resolve.setAttribute('aria-label', resolve.textContent);
      resolve.addEventListener('mousedown', (ev) => { ev.preventDefault(); this.toggleResolved(); });
      this.actions.append(reply, resolve);
    }
    // the field at the card's foot writes the first message while it is empty, replies after that
    const replyBtn = this.actions.querySelector<HTMLElement>('[data-act="reply"]');
    if (replyBtn) { const lastEmpty = this.node.childCount > 1 && !this.node.lastChild?.textContent.trim(); replyBtn.textContent = lastEmpty ? 'Comment' : 'Reply'; replyBtn.title = lastEmpty ? 'Write the comment' : 'Reply to this comment'; }
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
    // an open inset with nothing in it shows only its label — there is no content to collapse
    // and no visible box to click into: the click means "let me in" (LyX opens with the cursor
    // inside too), otherwise an emptied note could never be filled again
    const empty = cur.content.size <= 2 && !cur.textContent;
    if (cur.attrs.status !== 'collapsed' && empty) {
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(pos + 2))));
      this.view.focus();
      this.recordAction('note-toggle', 'unchanged');
      return;
    }
    const status = cur.attrs.status === 'collapsed' ? 'open' : 'collapsed';
    let tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, status });
    const sel = this.view.state.selection;
    if (status === 'collapsed' && sel.from > pos && sel.from < pos + cur.nodeSize) {
      // keep the cursor out of a collapsed inset
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + cur.nodeSize)));
    } else if (status === 'open') {
      // opening by click puts the cursor inside (the box opens for real)
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2)));
    }
    this.view.dispatch(tr);
    this.recordAction('note-toggle', 'changed');
    if (status === 'open') this.view.focus();
  }

  reply() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const cur = this.view.state.doc.nodeAt(pos);
    if (!cur) return;
    // the last message still has no text (a new thread's first one): the cursor goes there — a reply
    // below it left the first message blank, an empty "U1 13:41" above the comment (live co-editing test)
    const last = cur.lastChild;
    if (last && cur.childCount > 1 && !last.textContent.trim()) {
      const inLast = pos + cur.nodeSize - 1 - last.nodeSize + 1;
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, inLast)));
      this.view.focus();
      this.recordAction('comment-reply', 'unchanged');
      return;
    }
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
    this.recordAction('comment-reply', 'changed');
  }

  toggleResolved() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const resolving = !this.dom.classList.contains('resolved');
    toggleCommentResolved(this.view, pos);
    this.recordAction('comment-resolve', 'success');
    if (resolving) {
      // the card goes away: the cursor waits right after the thread's marker, in the text
      const cur = this.view.state.doc.nodeAt(pos);
      if (cur) this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(pos + cur.nodeSize))));
      this.view.focus();
      editorContext.notify?.('Comment resolved — Ctrl+Z undoes it; the Comments panel lists it and can reopen it');
    }
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
