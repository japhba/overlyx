/** Native CSS sizing and anchors, also usable in exported standalone HTML. */
export type TextAnchor = 'left' | 'center' | 'right';
export const TEXT_ANCHOR = 'data-ol-text-anchor';
export const WRAP_LINES = 'data-ol-wrap-lines';

export function anchorFraction(el: Element): number {
  const anchor = el.getAttribute(TEXT_ANCHOR);
  return anchor === 'center' ? 0.5 : anchor === 'right' ? 1 : 0;
}

/** Keep the chosen point of the current box still as its width becomes intrinsic. */
export function textBoxStyle(el: HTMLElement, anchor: TextAnchor | 'fixed'): Record<string, string> {
  const c = getComputedStyle(el);
  const width = el.offsetWidth || parseFloat(c.width) || 0;
  const fraction = anchor === 'center' ? 0.5 : anchor === 'right' ? 1 : 0;
  const oldLeft = c.position === 'static' ? 0 : parseFloat(c.left);
  const left = (Number.isFinite(oldLeft) ? oldLeft : el.offsetLeft) + (fraction - anchorFraction(el)) * width;
  return {
    left: `${left}px`, right: 'auto',
    ...(c.position === 'static' ? { position: 'relative' } : {}),
    width: anchor === 'fixed' ? Number.isFinite(parseFloat(c.width)) ? c.width : `${width}px` : 'max-content',
    'max-width': 'none',
    translate: fraction ? `${-100 * fraction}% 0` : 'none',
    ...(anchor === 'fixed' ? {} : { 'text-align': anchor }),
  };
}
