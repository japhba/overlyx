/**
 * A toolbar popup fixed to the window under the button that opened it — so a toolbar that scrolls
 * sideways or clips (the Modern strip) does not cut it off — kept inside the window, and above the
 * button when there is more room there (the contextual rows docked at the bottom).
 */
export function pinUnder(el: HTMLElement, anchor: HTMLElement): void {
  const b = anchor.getBoundingClientRect();
  Object.assign(el.style, { position: 'fixed', left: `${b.left}px`, top: `${b.bottom + 2}px`, right: 'auto', bottom: 'auto', marginTop: '0', maxHeight: '' });
  const r = el.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(4, window.innerWidth - 8 - r.width)}px`;
  const below = window.innerHeight - b.bottom - 8, above = b.top - 8;
  if (r.height > below && above > below) { el.style.top = `${Math.max(4, b.top - 2 - Math.min(r.height, above))}px`; el.style.maxHeight = `${above}px`; }
  else if (r.height > below) el.style.maxHeight = `${below}px`;
}
