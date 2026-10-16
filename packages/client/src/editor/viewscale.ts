/** Visual magnification of the document viewport, separate from its text's font size. */
export function documentViewScale(el: Element): number {
  const sc = el.closest<HTMLElement>('.editor-scroll[data-viewport-zoom]');
  return Number(sc?.dataset.viewportZoom) || 1;
}
