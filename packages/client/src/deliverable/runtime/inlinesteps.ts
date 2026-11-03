/** Apply an appearance step to selected words without replacing their text or formatting. */
const BLOCKS = 'p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,section,article,header,footer,dl,dt,dd,table,thead,tbody,tr,td,th,figure,figcaption';

export function setInlineStep(editingRoot: HTMLElement, selection: Selection | null, step: number): boolean {
  if (!Number.isSafeInteger(step) || step < 1 || !selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (range.collapsed || !editingRoot.contains(range.commonAncestorContainer)) return false;
  // An inline reveal belongs to a single paragraph; never split paragraphs or lists
  // to wrap a selection that crosses their boundaries.
  if (range.cloneContents().querySelector(BLOCKS)) return false;
  let root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer as HTMLElement : range.commonAncestorContainer.parentElement!;
  while (root !== editingRoot && !root.matches(BLOCKS)) root = root.parentElement!;
  const doc = root.ownerDocument;
  // Split at both selection boundaries, keeping the surrounding markup on each side.
  // This also splits an existing animated span, so changing a few words' step does
  // not leave them governed by the old enclosing span or change their neighbours.
  const beforeRange = doc.createRange();
  beforeRange.selectNodeContents(root);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const before = beforeRange.extractContents();
  const afterRange = doc.createRange();
  afterRange.selectNodeContents(root);
  afterRange.setStart(range.endContainer, range.endOffset);
  const after = afterRange.extractContents();
  for (const el of Array.from(root.querySelectorAll('[data-step]'))) el.removeAttribute('data-step');
  // Step 1 removes the selection's inline overlays; later steps wrap the run.
  if (step > 1) {
    const span = doc.createElement('span');
    span.setAttribute('data-step', String(step));
    span.append(...Array.from(root.childNodes));
    root.append(span);
  }
  const picked = Array.from(root.childNodes);
  root.prepend(before);
  root.append(after);
  const next = doc.createRange();
  if (picked.length) { next.setStartBefore(picked[0]); next.setEndAfter(picked[picked.length - 1]); }
  else next.selectNodeContents(root);
  selection.removeAllRanges();
  selection.addRange(next);
  return true;
}
