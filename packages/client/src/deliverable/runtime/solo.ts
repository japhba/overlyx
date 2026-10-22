/**
 * One slide at a time on the canvas (decks and posters in the editor, as in PowerPoint's and Google
 * Slides' editing view): the other slides are hidden — the rail, a frame of its own, shows them all
 * and is the way between them —, the page laid out simply around the slide shown (as for printing,
 * index.ts printCss), with room around it for the selection's frame, handles and label. The editor
 * sizes the frame to that and pans and zooms the frame itself (DeliverableEditor, viewport.ts): the
 * page never scrolls.
 */
import type { Rect, Solo } from '../protocol';
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
    html.ol-solo .slide[${CUR}] { margin: 0 !important; transform: none !important;
      box-shadow: 0 0 0 calc(1px * var(--ol-px, 1)) rgba(0, 0, 0, 0.16), 0 calc(2px * var(--ol-px, 1)) calc(12px * var(--ol-px, 1)) rgba(0, 0, 0, 0.24) !important; }
    :where(html.ol-solo:not(.ol-page-checker) .slide) { ${PAGE_BG} }`;
  document.head.appendChild(css);
}

/** no colour */
const clear = (c: string) => !c || c === 'transparent' || /^rgba\(.*,\s*0(\.0+)?\)$/.test(c);

/**
 * Round the slide on the canvas and in the rail the editor's own colour is painted (view.ts, railDesk):
 * the slide's edge is where the page ends (not 48 px further out, nor nowhere when the page and the
 * slide are both white). A slide without a background of its own showed the page's, as it does when
 * presented: it gets that, not the editor's colour (`PAGE_BG`: the least of rules — any of the page's
 * own on its slides comes first).
 */
export const PAGE_BG = 'background-color: var(--ol-page-bg, #fff); background-image: var(--ol-page-img, none);';

/** what the page paints round its slides (read with the editor's colour off for a moment: `ol-bg-read`), for PAGE_BG */
export function notePageBackground(): void {
  const root = document.documentElement;
  root.classList.add('ol-bg-read');
  const page = [document.body, root].map(el => getComputedStyle(el)).find(cs => cs.backgroundImage !== 'none' || !clear(cs.backgroundColor));
  const color = page?.backgroundColor ?? '', img = page?.backgroundImage ?? 'none';
  root.classList.remove('ol-bg-read');
  root.style.setProperty('--ol-page-bg', !clear(color) ? color : img !== 'none' ? 'transparent' : '#fff');
  root.style.setProperty('--ol-page-img', img);
}

/** the slide's edge in screen px, whatever the zoom (`scale`: screen px per px of the page) — zoomed far out (a poster), thinner: it stays inside the room round the slide */
export function soloScale(scale: number): void {
  document.documentElement.style.setProperty('--ol-px', String(Math.round(Math.min(3.5, 1 / (scale > 0 ? scale : 1)) * 1000) / 1000));
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
  notePageBackground();
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

/** elements drawn whole: their box is what they show */
const WHOLE = /^(img|svg|canvas|video|iframe|object|embed|picture|math|mjx-container|input|textarea|select|button|hr)$/;

/** a background, a border or a shadow shows: the box is drawn */
function painted(cs: CSSStyleDeclaration): boolean {
  if (cs.backgroundImage !== 'none' || cs.boxShadow !== 'none') return true;
  const bg = cs.backgroundColor;
  if (bg && bg !== 'transparent' && !/^rgba\(.*,\s*0(\.0+)?\)$/.test(bg)) return true;
  return (['Top', 'Right', 'Bottom', 'Left'] as const).some(k => parseFloat(cs.getPropertyValue(`border-${k.toLowerCase()}-width`)) > 0 && !/^(none|hidden)$/.test(cs.getPropertyValue(`border-${k.toLowerCase()}-style`)));
}

/**
 * Where what is on slide `s` is (page CSS px): its words, pictures and drawings, and boxes drawn with
 * a fill, a border or a shadow — not a box as big as the slide (its background, a frame round it) —,
 * clipped to the slide. Null: nothing on it.
 */
export function contentRect(s: Element): Rect | null {
  const sr = s.getBoundingClientRect();
  if (sr.width < 1 || sr.height < 1) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  const add = (x: DOMRect) => {
    const x0 = Math.max(sr.left, x.left), y0 = Math.max(sr.top, x.top), x1 = Math.min(sr.right, x.right), y1 = Math.min(sr.bottom, x.bottom);
    // (a rule: a line one way, nothing the other)
    if (x1 < x0 || y1 < y0 || x1 - x0 + (y1 - y0) < 1) return;
    l = Math.min(l, x0); t = Math.min(t, y0); r = Math.max(r, x1); b = Math.max(b, y1);
  };
  const range = document.createRange();
  const visit = (el: Element) => {
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (!n.textContent?.trim()) continue;
        range.selectNodeContents(n);
        for (const x of Array.from(range.getClientRects())) add(x);
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const e = n as Element;
      if (e.hasAttribute('data-ol-runtime')) continue;
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const box = e.getBoundingClientRect();
      if (WHOLE.test(e.localName)) { add(box); continue; }
      if (box.width * box.height < 0.9 * sr.width * sr.height && painted(cs)) add(box);
      visit(e);
    }
  };
  visit(s);
  if (r < l || b < t) return null;
  return { x: l + scrollX, y: t + scrollY, w: r - l, h: b - t };
}

function soloInfo(): Solo | undefined {
  if (!isSolo()) return undefined;
  const s = slides()[index];
  if (!s) return undefined;
  const r = docRect(s);
  const content = contentRect(s) ?? undefined;
  return { slide: index, rect: r, height: Math.ceil(r.y + r.h + SOLO_PAD), ...(content ? { content } : {}) };
}

layoutHooks.solo = soloInfo;
