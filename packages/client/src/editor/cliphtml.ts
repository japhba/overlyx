/**
 * The HTML on the clipboard (copy, cut, a dragged selection) is the schema's DOM, except that a
 * paragraph holding a block is written as `<div class="lyx-par">`. A block inside a paragraph is
 * a comment's, a note's or a footnote's paragraphs, or a table and its cells. An HTML parser closes
 * an open `<p>` at the next block tag (`<p>`, `<div>`, `<table>` …), so on paste such an inset's
 * paragraphs fell out of it: a section copied with a comment thread or a note box came back as loose
 * paragraphs next to an empty note. The schema reads `div.lyx-par` back as a paragraph.
 */
import { DOMSerializer, type Fragment } from 'prosemirror-model';
import { schema } from '@overlyx/core';

const BLOCK = 'p, div, table, ul, ol, dl, blockquote, pre, h1, h2, h3, h4, h5, h6, hr, section, aside, figure';

/** Turn every `<p>` that contains a block into a `<div>` with the same attributes and children. */
export function blockSafeParagraphs(root: ParentNode): void {
  for (const p of Array.from(root.querySelectorAll('p'))) {
    if (!p.querySelector(BLOCK)) continue;
    const div = p.ownerDocument.createElement('div');
    for (const a of Array.from(p.attributes)) div.setAttribute(a.name, a.value);
    while (p.firstChild) div.appendChild(p.firstChild);
    p.replaceWith(div);
  }
}

class ClipboardSerializer extends DOMSerializer {
  serializeFragment(fragment: Fragment, options: { document?: Document } = {}, target?: HTMLElement | DocumentFragment): HTMLElement | DocumentFragment {
    const dom = super.serializeFragment(fragment, options, target);
    blockSafeParagraphs(dom);
    return dom;
  }
}

let serializer: ClipboardSerializer | null = null;
/** the editors' `clipboardSerializer` (editor/assembly.ts) */
export function clipboardSerializer(): DOMSerializer {
  if (!serializer) { const base = DOMSerializer.fromSchema(schema); serializer = new ClipboardSerializer(base.nodes, base.marks); }
  return serializer;
}

const CODE_TAGS = new Set(['HTML', 'HEAD', 'BODY', 'META', 'STYLE', 'DIV', 'SPAN', 'BR', 'PRE', 'CODE']);
/**
 * HTML that is only highlighted source code: what VS Code (and other code editors, a web page's
 * code block) put on the clipboard beside the text — lines as `<div>`s of coloured `<span>`s under
 * `white-space: pre`, or a `<pre>`. LaTeX or markdown copied from there is pasted as its text would
 * be (parsed into structure), not as the colours of its highlighting. Never ProseMirror's own HTML.
 */
export function isCodeHtml(html: string): boolean {
  if (!html || html.includes('data-pm-slice')) return false;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let pre = false;
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (!CODE_TAGS.has(el.tagName)) return false;
    if (el.tagName === 'PRE' || el.tagName === 'CODE' || /white-space:\s*pre\b/i.test(el.getAttribute('style') ?? '')) pre = true;
  }
  return pre;
}
