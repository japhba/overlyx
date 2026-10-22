/**
 * Placeholders on the canvas (decklayouts.ts): an empty object with data-ol-ph says what goes in it —
 * "Click to add title" in the title's own type, "Tap …" on a touch screen —, in a dashed outline, as
 * Google Slides' do. Only here, while editing: presented, printed, in the rail and exported it is an
 * empty element and nothing shows. A click (a tap) on an empty one puts the caret in it (edit.ts); a
 * picture's asks the editor for a picture.
 */
import type { TextLook } from '../protocol';

export const PH = 'data-ol-ph';
const MEDIA = 'img, svg, video, canvas, iframe, object, embed, picture, math, mjx-container, .ol-mathchip';

/** the role of a placeholder (null: no placeholder) */
export function phRole(el: Element | null | undefined): string | null {
  return el?.getAttribute?.(PH) ?? null;
}

/** a placeholder with nothing in it yet: no words, no picture or formula */
export function isEmptyPh(el: Element | null | undefined): boolean {
  if (!el || !el.hasAttribute(PH)) return false;
  return !(el.textContent ?? '').trim() && !el.querySelector(MEDIA);
}

/** a picture placeholder: no text is typed into it */
export const isPicturePh = (el: Element | null | undefined): boolean => phRole(el) === 'picture' && el?.localName !== 'img';

const PICTURE_ICON = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="#80868b" stroke-width="2.4" stroke-linejoin="round"><rect x="5" y="9" width="38" height="30" rx="3"/><circle cx="17" cy="19" r="3.5"/><path d="M8 36l11-11 7 7 6-5 9 9"/></svg>')}")`;

/** the prompts, the outline: the editing canvas's only (`ol-edit`), never in the page */
export const PH_CSS = `
  html.ol-edit [${PH}]:not([data-ol-editing]):empty { outline: calc(1.5px * var(--ol-px, 1)) dashed color-mix(in srgb, currentColor 42%, transparent); outline-offset: calc(2px * var(--ol-px, 1)); }
  html.ol-edit [${PH}]:not([data-ol-editing]):empty::before { content: 'Click to add text'; display: block; opacity: 0.5; pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  html.ol-edit :is(ul, ol)[${PH}]:not([data-ol-editing]):empty::before { display: list-item; }
  html.ol-edit [${PH}="title"]:not([data-ol-editing]):empty::before { content: 'Click to add title'; }
  html.ol-edit [${PH}="subtitle"]:not([data-ol-editing]):empty::before { content: 'Click to add subtitle'; }
  html.ol-edit [${PH}="picture"]:not([data-ol-editing]):empty { background: color-mix(in srgb, currentColor 5%, transparent) ${PICTURE_ICON} center calc(50% - 18px) / 56px no-repeat; }
  html.ol-edit [${PH}="picture"]:not([data-ol-editing]):empty::before { content: 'Click to add a picture'; position: absolute; left: 0; right: 0; top: calc(50% + 20px); text-align: center; font: 600 20px/1.3 system-ui, sans-serif; color: #80868b; opacity: 1; }
  @media (pointer: coarse) {
    html.ol-edit [${PH}]:not([data-ol-editing]):empty::before { content: 'Tap to add text'; }
    html.ol-edit [${PH}="title"]:not([data-ol-editing]):empty::before { content: 'Tap to add title'; }
    html.ol-edit [${PH}="subtitle"]:not([data-ol-editing]):empty::before { content: 'Tap to add subtitle'; }
    html.ol-edit [${PH}="picture"]:not([data-ol-editing]):empty::before { content: 'Tap to add a picture'; }
  }`;

/** an empty list placeholder about to be typed into: a first item to type in (typed words went into the list itself) */
export function primeList(el: HTMLElement): HTMLLIElement | null {
  if ((el.localName !== 'ul' && el.localName !== 'ol') || !isEmptyPh(el) || el.querySelector('li')) return null;
  el.innerHTML = '<li><br></li>';
  return el.querySelector('li');
}

/** how the deck's text looks at these elements (the editor makes a new slide's placeholders look so) */
export function looksOf(els: (Element | null)[]): (TextLook | null)[] {
  return els.map(el => {
    if (!el) return null;
    // (a list's words are its items')
    const t = el.localName === 'ul' || el.localName === 'ol' ? el.querySelector('li') ?? el : el;
    const c = getComputedStyle(t);
    return { fontSize: c.fontSize, lineHeight: c.lineHeight, fontFamily: c.fontFamily, fontWeight: c.fontWeight, color: c.color };
  });
}
