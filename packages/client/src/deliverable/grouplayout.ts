import type { GroupLayout } from './protocol';
import { TEXT_ANCHOR } from './textboxes';

export const DEFAULT_GROUP_LAYOUT: GroupLayout = { direction: 'free', gap: 24, align: 'center', equal: false };

/** Only explicit canvas groups opt into layout ownership of their children's positions. */
export function groupLayoutOf(el: Element, css: CSSStyleDeclaration): GroupLayout | undefined {
  if (!el.classList.contains('ol-group')) return undefined;
  if (css.display !== 'flex' || !['row', 'column'].includes(css.flexDirection)) return { ...DEFAULT_GROUP_LAYOUT };
  return {
    direction: css.flexDirection as 'row' | 'column',
    gap: parseFloat(css.gap) || 0,
    align: ['flex-start', 'center', 'flex-end', 'stretch'].includes(css.alignItems) ? css.alignItems as GroupLayout['align'] : 'center',
    equal: Array.from(el.children).some(k => Number(getComputedStyle(k).flexGrow) > 0),
  };
}

export interface GroupMemberBox {
  src: Element;
  x: number; y: number;
  width: string; height: string;
  autoHeight?: boolean;
}

/** Ordinary inline CSS keeps the layout working in presentations, PDFs and standalone HTML. */
export function laidOutGroup(src: Element, members: GroupMemberBox[], size: { width: string; height: string }, layout: GroupLayout): Element {
  const copy = src.cloneNode(true) as HTMLElement;
  const st = copy.style;
  const wasFlow = st.display === 'flex';
  copy.classList.add('ol-group');
  st.width = size.width;
  st.height = layout.direction === 'free' || layout.direction === 'column' && layout.equal || layout.direction === 'row' && layout.align === 'stretch'
    ? size.height : wasFlow ? st.height || 'auto' : 'auto';
  st.display = layout.direction === 'free' ? 'block' : 'flex';
  st.flexDirection = layout.direction === 'free' ? '' : layout.direction;
  st.flexWrap = layout.direction === 'free' ? '' : 'nowrap';
  st.gap = layout.direction === 'free' ? '' : `${layout.gap}px`;
  st.alignItems = layout.direction === 'free' ? '' : layout.align;
  st.justifyContent = layout.direction === 'free' ? '' : 'flex-start';
  for (const m of members) {
    const index = Array.from(src.children).indexOf(m.src);
    const child = copy.children[index] as HTMLElement;
    if (!child) continue;
    const s = child.style;
    // Layout takes over positioning; the measured x already includes the label's translation.
    if (child.hasAttribute(TEXT_ANCHOR)) { child.removeAttribute(TEXT_ANCHOR); s.translate = 'none'; }
    s.position = layout.direction === 'free' ? 'absolute' : 'relative';
    s.left = layout.direction === 'free' ? `${m.x}px` : '0px';
    s.top = layout.direction === 'free' ? `${m.y}px` : '0px';
    s.right = s.bottom = 'auto';
    s.margin = '0';
    s.width = layout.equal && layout.direction === 'row' ? '0px' : layout.align === 'stretch' && layout.direction === 'column' ? 'auto' : m.width;
    s.height = layout.equal && layout.direction === 'column' ? '0px'
      : m.autoHeight || layout.align === 'stretch' && layout.direction === 'row' ? 'auto' : m.height;
    s.flex = layout.direction === 'free' ? '' : layout.equal ? '1 1 0px' : '0 0 auto';
    // Items can be smaller than their text's intrinsic size when sharing the available space.
    if (layout.equal) { s.minWidth = '0'; s.minHeight = '0'; }
  }
  return copy;
}
