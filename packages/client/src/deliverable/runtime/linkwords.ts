/**
 * Link (Ctrl+K) in a text being retyped. The browser's createLink leaves formulas — uneditable chips —
 * out of the link or splits it around them, and inside a link it makes another one at the caret.
 * Here: with the caret or the selection inside a link, the link gets the new address and keeps its
 * words and formulas; selected words within one paragraph are wrapped in one <a>, formulas and all;
 * anything else (a selection across paragraphs) is left to the browser.
 */

const BLOCK = 'p, div, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre, figcaption';

const elementOf = (n: Node): Element | null => (n.nodeType === Node.ELEMENT_NODE ? n as Element : n.parentElement);

/** the link the node is in, inside `editing` */
function linkAround(n: Node, editing: HTMLElement): HTMLAnchorElement | null {
  const a = elementOf(n)?.closest('a');
  return a && editing.contains(a) ? a as HTMLAnchorElement : null;
}

/** true when done here; false: the browser's createLink should do it */
export function linkSelection(editing: HTMLElement, url: string): boolean {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return false;
  const r = sel.getRangeAt(0);
  if (!editing.contains(r.commonAncestorContainer)) return false;
  const a0 = linkAround(r.startContainer, editing), a1 = linkAround(r.endContainer, editing);
  if (a0 && a0 === a1) { a0.setAttribute('href', url); return true; }
  if (r.collapsed) {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    r.insertNode(a);
    r.setStartAfter(a); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    return true;
  }
  // within one paragraph (or the text box itself when it holds no paragraphs)
  const blockOf = (n: Node) => { const b = elementOf(n)?.closest(BLOCK); return b && editing.contains(b) && b !== editing ? b : editing; };
  if (blockOf(r.startContainer) !== blockOf(r.endContainer) || r.cloneContents().querySelector(BLOCK)) return false;
  const frag = r.extractContents();
  // a link inside the selection gives way to the new one (its words stay)
  for (const inner of Array.from(frag.querySelectorAll('a'))) inner.replaceWith(...Array.from(inner.childNodes));
  const a = document.createElement('a');
  a.href = url;
  a.append(frag);
  r.insertNode(a);
  // (an empty text node left beside it would be a place for the caret outside the words)
  const range = document.createRange();
  range.selectNodeContents(a);
  sel.removeAllRanges(); sel.addRange(range);
  return true;
}
