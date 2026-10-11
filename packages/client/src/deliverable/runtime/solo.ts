/**
 * One slide at a time on the canvas (decks and posters in the editor, as in PowerPoint's and Google
 * Slides' editing view): the other slides are hidden — the rail, a frame of its own, shows them all
 * and is the way between them —, the page laid out simply around the slide shown (as for printing,
 * index.ts printCss), with room around it for the selection's frame, handles and label. The editor
 * sizes the frame to that and pans and zooms the frame itself (DeliverableEditor, viewport.ts): the
 * page never scrolls.
 */
import type { Solo } from '../protocol';
import { MODE, state, slides, docRect, layoutHooks, post, slideOf } from './env';

/** room around the slide shown (CSS px of the page): the selection's handles and label fit in it */
export const SOLO_PAD = 48;
const CUR = 'data-ol-current';
let index = 0;
let css: HTMLStyleElement | null = null;

export function isSolo(): boolean { return MODE === 'edit' && state.kind !== 'page' && slides().length > 0; }

function install(on: boolean): void {
  document.documentElement.classList.toggle('ol-solo', on);
  if (!on || css) return;
  css = document.createElement('style');
  css.setAttribute('data-ol-runtime', '');
  css.textContent = `html.ol-solo { padding: ${SOLO_PAD}px !important; margin: 0 !important; overflow: hidden !important; height: auto !important; min-height: 0 !important; box-sizing: content-box !important; scroll-snap-type: none !important; }
    html.ol-solo :is(body, :has(> .slide)) { display: block !important; gap: 0 !important; padding: 0 !important; margin: 0 !important; transform: none !important; zoom: 1 !important;
      height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; scroll-snap-type: none !important; }
    html.ol-solo .slide:not([${CUR}]) { display: none !important; }
    html.ol-solo .slide[${CUR}] { margin: 0 !important; transform: none !important; }`;
  document.head.appendChild(css);
}

/** the slide shown (its index) */
export function soloIndex(): number { return index; }

/** show slide `i` (clamped); true when another slide is shown now */
export function showSlide(i: number): boolean {
  const ss = slides();
  if (!ss.length) return false;
  const k = Math.max(0, Math.min(ss.length - 1, i));
  let changed = k !== index;
  index = k;
  ss.forEach((s, j) => {
    const on = j === k;
    if (on === s.hasAttribute(CUR)) return;
    changed = true;
    if (on) s.setAttribute(CUR, ''); else s.removeAttribute(CUR);
  });
  return changed;
}

/**
 * After a new version of the page (or at the start): still exactly one slide shown — the same one
 * when it is still there (moved in the rail: its new place is reported), else the one now at its place.
 */
export function ensureSolo(): void {
  const on = isSolo();
  install(on);
  if (!on) return;
  const ss = slides();
  const shown = ss.filter(s => s.hasAttribute(CUR));
  if (shown.length === 1) {
    const k = ss.indexOf(shown[0]);
    if (k !== index) { index = k; post({ ol: 'visible', slide: k }); }
    return;
  }
  const before = index;
  showSlide(index);
  if (index !== before) post({ ol: 'visible', slide: index });
}

/** an element of another slide is selected or retyped (an undo, the code view, a search): its slide is shown */
export function revealSlideOf(el: Element | null): boolean {
  if (!el || !isSolo()) return false;
  const s = slideOf(el);
  const k = s ? slides().indexOf(s) : -1;
  if (k < 0 || k === index) return false;
  showSlide(k);
  post({ ol: 'visible', slide: k });
  return true;
}

function soloInfo(): Solo | undefined {
  if (!isSolo()) return undefined;
  const s = slides()[index];
  if (!s) return undefined;
  const r = docRect(s);
  return { slide: index, rect: r, height: Math.ceil(r.y + r.h + SOLO_PAD) };
}

layoutHooks.solo = soloInfo;
