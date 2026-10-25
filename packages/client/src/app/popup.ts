/**
 * A toolbar popup fixed to the window under the button that opened it — so a toolbar that scrolls
 * sideways or clips (the Modern strip) does not cut it off — kept inside the window, and above the
 * button when there is more room there (the contextual rows docked at the bottom); beside it when the
 * toolbars are docked in a column at a side of the document.
 *
 * `position: fixed` is relative to the window only when no ancestor has a transform: Modern centres
 * the bottom rows (Draw, Math, Table, Review) with translateX(-50%), and their popups opened that far
 * off to the right and below the window. The offset is measured and taken out (`at`).
 */
export function pinUnder(el: HTMLElement, anchor: HTMLElement): void {
  const b = anchor.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  Object.assign(el.style, { position: 'fixed', left: '0px', top: '0px', right: 'auto', bottom: 'auto', marginTop: '0', maxHeight: '' });
  // where (0, 0) of the fixed popup lands: the window's corner, or a transformed ancestor's
  const o = el.getBoundingClientRect();
  const at = (x: number, y: number) => { el.style.left = `${x - o.left}px`; el.style.top = `${y - o.top}px`; };
  const { width: w, height: h } = o;
  // a toolbar docked in a column beside the document (app/tbdock.tsx): beside the button, towards the page
  // (or the deck's Draw palette standing upright at a side: deliverable/drawpalette.tsx)
  const side = anchor.closest<HTMLElement>('[data-tb-side]')?.dataset.tbSide;
  if (side === 'left' || side === 'right') {
    el.style.maxHeight = `${H - 16}px`;
    const x = side === 'left' ? Math.min(b.right + 4, W - 8 - w) : Math.max(4, b.left - 4 - w);
    at(Math.max(4, x), b.top + Math.min(h, H - 16) > H - 8 ? Math.max(8, H - 8 - Math.min(h, H - 16)) : b.top);
    return;
  }
  const x = b.left + w > W - 8 ? Math.max(4, W - 8 - w) : Math.max(4, b.left);
  const below = H - b.bottom - 8, above = b.top - 8;
  if (h > below && above > below) { at(x, Math.max(4, b.top - 2 - Math.min(h, above))); el.style.maxHeight = `${above}px`; }
  else { at(x, b.bottom + 2); if (h > below) el.style.maxHeight = `${below}px`; }
}
