/** The list item at a caret, bounded by the text box being edited. */
export function textListItem(root: HTMLElement, anchor: Node | null | undefined): HTMLLIElement | null {
  if (!root.isConnected || !anchor || !root.contains(anchor)) return null;
  const element = anchor.nodeType === 1 ? anchor as Element : anchor.parentElement;
  const item = element?.closest('li');
  return item && root.contains(item) ? item : null;
}

/** A list at the textbox edge retains an editable item boundary for Tab. */
function listBoundary(root: HTMLElement, end: boolean): HTMLLIElement | null {
  const edge = (parent: Element): Node | null => {
    let node = end ? parent.lastChild : parent.firstChild;
    while (node?.nodeType === 3 && !node.textContent?.trim()) node = end ? node.previousSibling : node.nextSibling;
    return node;
  };
  let node: Node | null = ['ul', 'ol'].includes(root.localName) ? root : edge(root);
  while (node?.nodeType === 1 && ['ul', 'ol'].includes((node as Element).localName)) {
    const list = node as Element;
    const item = end ? list.lastElementChild : list.firstElementChild;
    if (!item || item.localName !== 'li') return null;
    node = edge(item);
    if (!(node?.nodeType === 1 && ['ul', 'ol'].includes((node as Element).localName))) return item as HTMLLIElement;
  }
  return null;
}

/** Explicit text-box boundaries: do not depend on a browser's document-level Ctrl+End. */
export function textBoundary(root: HTMLElement, end: boolean, extend: boolean): boolean {
  const selection = root.ownerDocument.getSelection();
  if (!root.isConnected || !selection) return false;
  const offset = end ? root.childNodes.length : 0;
  if (extend && selection.anchorNode && root.contains(selection.anchorNode)) {
    selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, root, offset);
  } else {
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(!extend ? listBoundary(root, end) ?? root : root);
    range.collapse(!end);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}
