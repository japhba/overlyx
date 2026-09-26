/**
 * Hyperlinks as in Google Docs. ⌘K / Ctrl+K opens the link box under the selection: the address
 * for the selected text, text and address for a new link, or the link under the cursor to change
 * it. A link under the cursor shows a bubble with its address (a click opens it), Copy, Edit and
 * Remove. Both work in the text (LyX's hyperlink inset, a `command` node with cmd `href`) and in
 * formulas (`\href{…}{…}` in the math model — a link in a table's `\text{…}` cell, say).
 */
import type { EditorView } from 'prosemirror-view';
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode, Mark } from 'prosemirror-model';
import { paramMap, quote, unquote, schema, FONT_KEYS } from '@overlyx/core';
import { menuIcon, type MenuIcon } from './menuicons';
import { editorContext } from './context';
import { activeMathField, mathCursorListeners, mathFocusListeners, type LyxMathField } from './lyxmath/field';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const LINK_KEY = isMac ? '⌘K' : 'Ctrl+K';

/* ------------------------------------------------------------------ addresses */

/** What was typed or pasted into the link box, as a link target: `arxiv.org/abs/1` → `https://arxiv.org/abs/1`, `a@b.org` → `mailto:a@b.org`. */
export function normalizeLinkInput(input: string): string {
  const s = input.trim();
  if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || /^[#/.]/.test(s)) return s;
  if (/^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(s)) return 'mailto:' + s;
  if (/^(localhost|[^\s/:?#]+\.[a-z]{2,})(:\d+)?([/?#]|$)/i.test(s)) return 'https://' + s;
  return s;
}

/** The address a link may be opened at in a new tab: web, mail and ftp addresses (scheme-less ones as https); null for any other scheme (javascript:, data: …). */
export function openableUrl(target: string): string | null {
  const t = target.trim();
  if (!t) return null;
  if (/^(https?|ftp|mailto):/i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null;
  return 'https://' + t.replace(/^\/+/, '');
}

/** Open a link in a new tab — by a click on an anchor, which the VS Code webview also passes on to the system browser. */
export function openLink(target: string): void {
  const url = openableUrl(target);
  if (!url) { editorContext.notify?.('This link cannot be opened from the editor', 'error'); return; }
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** A URL as the target of a formula's `\href` (LaTeX: `%` and `#` escaped, a backslash or brace percent-encoded). */
export function mathLinkTarget(url: string): string {
  return url.replace(/\\/g, '%5C').replace(/\{/g, '%7B').replace(/\}/g, '%7D').replace(/%/g, '\\%').replace(/#/g, '\\#');
}
/** The URL a formula's `\href` target stands for. */
export function mathLinkUrl(target: string): string {
  return target.replace(/\\([%#&_$~])/g, '$1');
}

/* ------------------------------------------------------------------ links in the text */

const isHref = (n: PMNode | null | undefined): n is PMNode => !!n && n.type.name === 'command' && n.attrs.cmd === 'href';

/** The hyperlink inset selected, or the one the (empty) cursor touches. */
export function hrefAt(state: EditorState): { node: PMNode; pos: number } | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection) return isHref(sel.node) ? { node: sel.node, pos: sel.from } : null;
  if (!sel.empty) {
    const n = state.doc.nodeAt(sel.from);
    return isHref(n) && sel.to === sel.from + n.nodeSize ? { node: n, pos: sel.from } : null;
  }
  const { nodeBefore, nodeAfter } = sel.$from;
  if (isHref(nodeBefore)) return { node: nodeBefore, pos: sel.from - nodeBefore.nodeSize };
  if (isHref(nodeAfter)) return { node: nodeAfter, pos: sel.from };
  return null;
}

/** A hyperlink inset's address (its `type` prefix — mailto:, file: — put back) and text. */
export function hrefOf(node: PMNode): { url: string; name: string; literal: boolean } {
  let p: Map<string, string>;
  try { p = paramMap(JSON.parse(node.attrs.params || '[]')); } catch { p = new Map(); }
  const target = unquote(p.get('target')), type = unquote(p.get('type'));
  return { url: type && !target.startsWith(type) ? type + target : target, name: unquote(p.get('name')), literal: unquote(p.get('literal')) === 'true' };
}

/** The params of a hyperlink inset (LyX's InsetHyperlink: name, target, type, literal). */
export function hrefParams(url: string, name: string, literal = false): string[] {
  let target = url, type = '';
  if (/^mailto:/i.test(url)) { type = 'mailto:'; target = url.slice(7); }
  else if (/^file:/i.test(url)) { type = 'file:'; target = url.slice(5); }
  const p = ['LatexCommand href'];
  if (name && name !== url) p.push('name ' + quote(name));
  p.push('target ' + quote(target));
  if (type) p.push('type ' + quote(type));
  p.push('literal ' + quote(literal ? 'true' : 'false'), '');
  return p;
}

/** Font marks as an inline node's `marks` attr (y-prosemirror keeps no marks on non-text nodes: schema.ts). */
const fontAttr = (marks: readonly Mark[]) => JSON.stringify(marks.filter(m => (FONT_KEYS as readonly string[]).includes(m.type.name)).map(m => ({ type: m.type.name, attrs: m.attrs })));
/** …and back: the font of a hyperlink inset for the text that replaces it */
function fontOf(node: PMNode): Mark[] {
  try {
    return (JSON.parse(node.attrs.marks || '[]') as { type: string; attrs?: Record<string, unknown> }[])
      .filter(m => (FONT_KEYS as readonly string[]).includes(m.type) && schema.marks[m.type]).map(m => schema.marks[m.type].create(m.attrs));
  } catch { return []; }
}

/** The selection as the text of a new link: plain text within one paragraph, else why not. */
function selectedLinkText(state: EditorState, from = state.selection.from, to = state.selection.to): { text: string; marks: readonly Mark[] } | { error: string } {
  const $from = state.doc.resolve(from), $to = state.doc.resolve(to);
  if (!$from.sameParent($to) || !$from.parent.inlineContent) return { error: 'A link can only be made within one paragraph' };
  let text = '', marks: readonly Mark[] | null = null, other = false;
  state.doc.nodesBetween(from, to, (n, pos) => {
    if (n.isText) { const s = n.text!.slice(Math.max(0, from - pos), to - pos); text += s; marks ??= n.marks; }
    else if (n.isInline) other = true;
    return true;
  });
  if (other) return { error: 'A link can hold only text: select the text without formulas or insets' };
  return { text, marks: marks ?? [] };
}

/** the range the link box works on while it is open (drawn as selected: the editor has lost the focus) */
const pendingKey = new PluginKey<{ from: number; to: number } | null>('linkPending');

/** Open the link box for the text editor's selection / cursor / the link under it. */
export function openLinkBox(view: EditorView): void {
  if (!view.editable) return;
  const state = view.state;
  const at = hrefAt(state);
  const { from, to, empty } = state.selection;
  const anchorAt = (a: number, b: number) => {
    const s = view.coordsAtPos(a), e = view.coordsAtPos(b, -1);
    const oneLine = Math.abs(s.top - e.top) < 4;
    return { left: oneLine ? s.left : e.left, top: s.top, bottom: e.bottom };
  };
  if (at) {
    const cur = hrefOf(at.node);
    const dom = view.nodeDOM(at.pos) as HTMLElement | null;
    const r = dom?.getBoundingClientRect?.();
    showBox(view, {
      anchor: r ? { left: r.left, top: r.top, bottom: r.bottom } : anchorAt(at.pos, at.pos + at.node.nodeSize),
      text: cur.name || cur.url, url: cur.url,
      onApply: (url, text, r) => {
        const pos = r?.from ?? at.pos;
        const node = view.state.doc.nodeAt(pos);
        if (!isHref(node)) return;
        const name = text.trim() || url;
        const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, params: JSON.stringify(hrefParams(url, name, cur.literal && name === cur.name)) });
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize)));
      },
      onRemove: r => unlinkText(view, r?.from ?? at.pos),
      range: { from: at.pos, to: at.pos + at.node.nodeSize },
    });
    return;
  }
  if (!empty) {
    const sel = selectedLinkText(state);
    if ('error' in sel) { editorContext.notify?.(sel.error, 'error'); return; }
    showBox(view, {
      anchor: anchorAt(from, to), text: null, url: /^\S+$/.test(sel.text.trim()) && /[./:@]/.test(sel.text) ? normalizeLinkInput(sel.text) : '',
      onApply: (url, _text, r) => {
        const now = r ? selectedLinkText(view.state, r.from, r.to) : sel;
        if (r && !('error' in now) && now.text) linkRange(view, r.from, r.to, url, now.text, now.marks);
      },
      range: { from, to },
    });
    return;
  }
  showBox(view, {
    anchor: anchorAt(from, from), text: '', url: '',
    onApply: (url, text) => {
      const marks = view.state.storedMarks ?? view.state.selection.$from.marks();
      const node = schema.nodes.command.create({ cmd: 'href', params: JSON.stringify(hrefParams(url, text.trim() || url)), marks: fontAttr(marks) });
      const tr = view.state.tr.replaceSelectionWith(node, false);
      view.dispatch(tr.scrollIntoView());
    },
    range: null,
  });
}

/** Make `from`…`to` (the text `text` in the font `marks`) a hyperlink inset; the cursor goes behind it. */
function linkRange(view: EditorView, from: number, to: number, url: string, text: string, marks: readonly Mark[]): void {
  const node = schema.nodes.command.create({ cmd: 'href', params: JSON.stringify(hrefParams(url, text)), marks: fontAttr(marks) });
  const tr = view.state.tr.replaceWith(from, to, node);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize)).scrollIntoView());
}

/** A web or mail address pasted over selected text makes that text a link to it (as in Google Docs); false when that does not apply. */
export function pasteLinkOverSelection(view: EditorView, pasted: string): boolean {
  const url = pasted.trim();
  if (view.state.selection.empty || !/^(https?:\/\/|mailto:)\S+$/i.test(url) || hrefAt(view.state)) return false;
  const sel = selectedLinkText(view.state);
  if ('error' in sel || !sel.text.trim()) return false;
  linkRange(view, view.state.selection.from, view.state.selection.to, url, sel.text, sel.marks);
  return true;
}

/** Replace a hyperlink inset by its text (Remove link). */
export function unlinkText(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos);
  if (!isHref(node)) return;
  const { url, name } = hrefOf(node);
  const text = name || url;
  const tr = text ? view.state.tr.replaceWith(pos, pos + node.nodeSize, schema.text(text, fontOf(node))) : view.state.tr.delete(pos, pos + node.nodeSize);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + text.length)));
  view.focus();
}

type Range = { from: number; to: number };
function showBox(view: EditorView, o: { anchor: Anchor; text: string | null; url: string; onApply: (url: string, text: string, range: Range | null) => void; onRemove?: (range: Range | null) => void; range: Range | null }): void {
  if (o.range) view.dispatch(view.state.tr.setMeta(pendingKey, o.range));
  /** the range as it is now (the pending range is mapped through every change), and the highlight gone */
  const take = (): Range | null => {
    if (view.isDestroyed) return null;
    const r = pendingKey.getState(view.state) ?? null;
    if (r) view.dispatch(view.state.tr.setMeta(pendingKey, null));
    return r;
  };
  const clear = () => { take(); };
  openBox({
    anchor: o.anchor, text: o.text, url: o.url, editing: !!o.onRemove,
    onApply: (url, text) => { const r = take(); if (view.isDestroyed) return; o.onApply(url, text, r); view.focus(); },
    onRemove: o.onRemove ? () => { const r = take(); if (!view.isDestroyed) o.onRemove!(r); } : undefined,
    onCancel: refocus => { clear(); if (refocus) view.focus(); },
  });
}

/** The plugin behind the text's link bubble and the selection kept visible while the link box is open. */
export function linksPlugin(): Plugin {
  return new Plugin<{ from: number; to: number } | null>({
    key: pendingKey,
    state: {
      init: () => null,
      apply(tr, value: { from: number; to: number } | null) {
        const meta = tr.getMeta(pendingKey);
        if (meta !== undefined) return meta;
        return value && tr.docChanged ? { from: tr.mapping.map(value.from), to: tr.mapping.map(value.to) } : value;
      },
    },
    props: {
      decorations(state) {
        const r = pendingKey.getState(state);
        return r && r.to > r.from ? DecorationSet.create(state.doc, [Decoration.inline(r.from, r.to, { class: 'link-pending' })]) : null;
      },
    },
    view: v => new TextBubble(v),
  });
}

/** Shows the bubble while the cursor is on a hyperlink inset (and the editor has the focus). */
class TextBubble {
  private onFocus = () => this.update(this.view);
  private onBlur = () => setTimeout(() => { if (!this.view.hasFocus() && bubbleOwner === this) hideBubble(); }, 0);
  constructor(private view: EditorView) {
    view.dom.addEventListener('focus', this.onFocus);
    view.dom.addEventListener('blur', this.onBlur);
  }
  update(view: EditorView): void {
    const at = boxOpen || !view.hasFocus() ? null : hrefAt(view.state);
    if (!at) { if (bubbleOwner === this) hideBubble(); return; }
    const { url } = hrefOf(at.node);
    const pos = at.pos;
    const anchor = (): Anchor | null => {
      const dom = view.nodeDOM(pos) as HTMLElement | null;
      const r = dom?.getBoundingClientRect?.();
      return r && r.height ? { left: r.left, top: r.top, bottom: r.bottom } : null;
    };
    // the actions look the link up again: the document may have changed since the bubble appeared
    const current = () => { const h = hrefAt(view.state); return h && h.node === at.node ? h.pos : null; };
    showBubble(this, url, anchor, view.editable ? {
      edit: () => openLinkBox(view),
      remove: () => { const p = current(); if (p !== null) unlinkText(view, p); },
    } : null, url + '@' + pos);
  }
  destroy(): void {
    this.view.dom.removeEventListener('focus', this.onFocus);
    this.view.dom.removeEventListener('blur', this.onBlur);
    if (bubbleOwner === this) hideBubble();
  }
}

/* ------------------------------------------------------------------ links in formulas */

/** ⌘K in a formula: the link box for the field's selection / cursor / the link under it. */
export function openMathLinkBox(field: LyxMathField): void {
  if (field.readOnly) return;
  const c = field.cursor;
  const sel = c.selRange();
  if (sel && sel.idx1 !== sel.idx2) { editorContext.notify?.('A link can only be made within one cell', 'error'); return; }
  const on = c.selection ? null : field.linkAtCursor();
  const anchor = field.linkAnchor() ?? (() => { const r = field.dom.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom }; })();
  field.hold();
  openBox({
    anchor, text: on || c.selection ? null : '', url: on ? mathLinkUrl(on.target) : '', editing: !!on,
    onApply: (url, text) => { field.execute('link', mathLinkTarget(url), text.trim() || url); field.endHold(true); },
    onRemove: on ? () => { field.execute('unlink'); field.endHold(true); } : undefined,
    onCancel: refocus => field.endHold(refocus),
  });
}

/** The link box for whatever has the keyboard: the formula being edited, else the text (toolbar and menu entries). */
export function openLinkBoxFor(view: EditorView | null | undefined): boolean {
  const f = activeMathField();
  if (f) { openMathLinkBox(f); return true; }
  if (view) openLinkBox(view);
  return true;
}

/** the bubble while a formula's cursor is on a link */
const mathBubbleOwner = { kind: 'math' };
function updateMathBubble(field: LyxMathField | null): void {
  const l = field && field.hasFocus() && !boxOpen && !field.cursor.selection ? field.linkAtCursor() : null;
  if (!field || !l) { if (bubbleOwner === mathBubbleOwner) hideBubble(); return; }
  showBubble(mathBubbleOwner, mathLinkUrl(l.target), () => field.linkAnchor(), field.readOnly ? null : {
    edit: () => openMathLinkBox(field),
    remove: () => { field.execute('unlink'); },
  });
}

/** Wire ⌘K in formulas, the formulas' link bubble and ⌘/Ctrl+click on their links (once; editor/assembly.ts calls it). */
let installed = false;
export function installLinks(): void {
  if (installed) return;
  installed = true;
  editorContext.mathLink = openMathLinkBox;
  mathCursorListeners.add(f => updateMathBubble(f));
  mathFocusListeners.add(f => updateMathBubble(f));
  // ⌘/Ctrl+click on a link in a formula follows it (the press has put the formula's cursor into the link)
  document.addEventListener('click', ev => {
    if (!(isMac ? ev.metaKey : ev.ctrlKey) || !(ev.target as Element | null)?.closest?.('.lm-href')) return;
    const l = activeMathField()?.linkAtCursor();
    if (l) { ev.preventDefault(); openLink(mathLinkUrl(l.target)); }
  }, true);
  // a right-click menu takes the bubble's place
  document.addEventListener('contextmenu', () => hideBubble(), true);
}

/* ------------------------------------------------------------------ the box and the bubble (DOM) */

interface Anchor { left: number; top: number; bottom: number }

let boxOpen: { close: (refocus: boolean) => void } | null = null;

/** Close the link box (Escape elsewhere, the document replaced …). */
export function closeLinkBox(): void { boxOpen?.close(false); }
export function linkBoxOpen(): boolean { return !!boxOpen; }

function iconButton(icon: MenuIcon, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'link-icon-btn'; b.title = title; b.setAttribute('aria-label', title);
  b.appendChild(menuIcon(icon, 'link-svg'));
  b.addEventListener('mousedown', ev => ev.preventDefault());
  b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); onClick(); });
  return b;
}

/** below the anchor, inside the window (above it when there is no room below) */
function placeUnder(el: HTMLElement, a: Anchor): void {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const x = Math.max(8, Math.min(a.left, vw - r.width - 8));
  let y = a.bottom + 6;
  if (y + r.height > vh - 8 && a.top - r.height - 6 >= 8) y = a.top - r.height - 6;
  el.style.left = x + 'px'; el.style.top = y + 'px';
}

/**
 * The link box: a text field (`text` null: none — the selection is the text) and the address,
 * Apply; Remove when it edits a link. Enter applies, Escape and a click elsewhere cancel.
 */
function openBox(o: { anchor: Anchor; text: string | null; url: string; editing: boolean; onApply: (url: string, text: string) => void; onRemove?: () => void; onCancel: (refocus: boolean) => void }): void {
  boxOpen?.close(false);
  hideBubble();
  const box = document.createElement('div');
  box.className = 'link-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', o.editing ? 'Edit link' : 'Insert link');
  const field = (icon: MenuIcon, value: string, placeholder: string, cls: string) => {
    const row = document.createElement('label');
    row.className = 'link-row ' + cls;
    row.appendChild(menuIcon(icon, 'link-svg'));
    const input = document.createElement('input');
    input.type = 'text'; input.value = value; input.placeholder = placeholder; input.spellcheck = false;
    input.setAttribute('aria-label', placeholder);
    row.appendChild(input);
    box.appendChild(row);
    return input;
  };
  const textInput = o.text !== null ? field('text', o.text, 'Text', 'link-text') : null;
  const urlInput = field('link', o.url, 'Paste a link or type an address', 'link-url');
  const apply = document.createElement('button');
  apply.type = 'button'; apply.className = 'link-apply'; apply.textContent = 'Apply';
  urlInput.parentElement!.appendChild(apply);
  if (o.onRemove) urlInput.parentElement!.appendChild(iconButton('unlink', 'Remove link', () => { close(false, false); o.onRemove!(); }));
  const sync = () => { apply.disabled = !urlInput.value.trim(); };
  sync();
  urlInput.addEventListener('input', sync);
  let done = false;
  const close = (refocus: boolean, cancelled = true) => {
    if (done) return;
    done = true;
    box.remove();
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('resize', onResize);
    boxOpen = null;
    if (cancelled) o.onCancel(refocus);
  };
  const submit = () => {
    const url = normalizeLinkInput(urlInput.value);
    if (!url) return;
    close(false, false);
    o.onApply(url, textInput?.value ?? '');
  };
  apply.addEventListener('mousedown', ev => ev.preventDefault());
  apply.addEventListener('click', submit);
  box.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); close(true); }
  });
  const onDown = (ev: MouseEvent) => { if (!box.contains(ev.target as Node)) close(false); };
  const onResize = () => placeUnder(box, o.anchor);
  document.body.appendChild(box);
  placeUnder(box, o.anchor);
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  window.addEventListener('resize', onResize);
  boxOpen = { close };
  const first = textInput && !textInput.value ? textInput : urlInput;
  first.focus();
  first.select();
}

let bubble: HTMLElement | null = null;
let bubbleOwner: object | null = null;
let bubbleAnchor: (() => Anchor | null) | null = null;
const reposition = () => {
  if (!bubble || !bubbleAnchor) return;
  const a = bubbleAnchor();
  if (!a) { hideBubble(); return; }
  placeUnder(bubble, a);
};

function hideBubble(): void {
  bubble?.remove();
  bubble = null; bubbleOwner = null; bubbleAnchor = null;
  window.removeEventListener('scroll', reposition, true);
}

/** The bubble under a link: its address (a click opens it), Copy, and — when the document can be edited — Edit and Remove. */
let bubbleKey = '';
function showBubble(owner: object, url: string, anchor: () => Anchor | null, actions: { edit: () => void; remove: () => void } | null, key = url): void {
  if (bubble && bubbleOwner === owner && bubbleKey === key + !!actions) { bubbleAnchor = anchor; requestAnimationFrame(reposition); return; }
  hideBubble();
  bubbleKey = key + !!actions;
  const el = document.createElement('div');
  el.className = 'link-bubble';
  // the editor keeps the focus (a blur would take the bubble away before the click lands); the address still opens
  el.addEventListener('mousedown', ev => ev.preventDefault());
  el.appendChild(menuIcon('globe', 'link-svg link-globe'));
  const a = document.createElement('a');
  const openable = openableUrl(url);
  a.className = 'link-bubble-url';
  a.textContent = url.replace(/^mailto:/i, '');
  a.title = url;
  if (openable) { a.href = openable; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  el.appendChild(a);
  const sep = document.createElement('span'); sep.className = 'link-bubble-sep'; el.appendChild(sep);
  el.appendChild(iconButton('copy', 'Copy link', () => {
    void navigator.clipboard?.writeText(url).then(() => editorContext.notify?.('Link copied'), () => editorContext.notify?.('Could not copy the link', 'error'));
  }));
  if (actions) {
    el.appendChild(iconButton('edit', `Edit link (${LINK_KEY})`, () => { hideBubble(); actions.edit(); }));
    el.appendChild(iconButton('unlink', 'Remove link', () => { hideBubble(); actions.remove(); }));
  }
  bubble = el; bubbleOwner = owner; bubbleAnchor = anchor;
  document.body.appendChild(el);
  // placed once the formula / text has been laid out
  el.style.visibility = 'hidden';
  // (not while a right-click menu is open: the right-click that opened it may have selected the link)
  requestAnimationFrame(() => { if (bubble !== el) return; if (document.querySelector('.ctx-menu')) { hideBubble(); return; } reposition(); el.style.visibility = ''; });
  window.addEventListener('scroll', reposition, true);
}
