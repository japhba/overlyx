/** Replace a phrasing-only editable host before a native block/list command. */
const TEXT_STYLE = ['font-family', 'font-size', 'font-weight', 'color', 'line-height'] as const;

/** Snapshot values, not a live CSSStyleDeclaration that changes when the tag does. */
export function editingTextStyle(el: HTMLElement): Record<string, string> {
  const css = el.ownerDocument.defaultView?.getComputedStyle(el);
  return css ? Object.fromEntries(TEXT_STYLE.map(key => [key, css.getPropertyValue(key)])) : {};
}

/** Carry only typography lost by a tag conversion; unchanged inheritance stays inherited. */
export function carryEditingTextStyle(el: HTMLElement, before: Record<string, string>): Record<string, string> {
  const current = editingTextStyle(el), changed: Record<string, string> = {};
  for (const key of TEXT_STYLE) if (before[key] && before[key] !== current[key]) {
    changed[key] = before[key];
    el.style.setProperty(key, before[key]);
  }
  return changed;
}

export function replaceEditingHost(el: HTMLElement, tag: string): HTMLElement {
  const selection = el.ownerDocument.getSelection();
  const anchor = selection?.anchorNode, anchorOffset = selection?.anchorOffset ?? 0;
  const focus = selection?.focusNode, focusOffset = selection?.focusOffset ?? 0;
  const ownedSelection = !!anchor && !!focus && el.contains(anchor) && el.contains(focus);
  const hadFocus = el.ownerDocument.activeElement === el;
  const next = el.ownerDocument.createElement(tag);
  for (const attr of Array.from(el.attributes)) next.setAttribute(attr.name, attr.value);
  // Move, do not clone: chips, source-linked descendants and range endpoints keep identity.
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
  if (hadFocus) next.focus({ preventScroll: true });
  if (ownedSelection) selection!.setBaseAndExtent(anchor === el ? next : anchor!, anchorOffset,
    focus === el ? next : focus!, focusOffset);
  return next;
}
