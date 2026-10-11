/**
 * The slides shown light on dark while they are edited — smart invert, the editor's dark theme
 * (app/darkpages.ts, `{ol:'dark'}`): each slide inverted with a 180° hue rotation, so colours keep
 * their hue, and what is a picture inverted back to its own colours: videos, canvases, embedded
 * frames, backgrounds with a picture, SVG images — and the <img> pictures that are photographs.
 * With `figures` (prefs.invertFigures) an <img> is judged by its pixels as the editor's figures are
 * (editor/figureinvert.ts): a plot or diagram on a white or transparent ground is line art and stays
 * inverted with the slide (`data-ol-lineart`, the runtime's own attribute — never written to the
 * text); without it every picture keeps its colours. Only the slides: the runtime's frames and
 * handles and the canvas around them stay as they are. A web page (no slides) is inverted as a whole
 * — its root, so that its background goes too and fixed elements stay where they are — with the
 * runtime's overlay (frames, handles) inverted back.
 *
 * The frame is an opaque origin, so the shown <img> cannot be read back; its address is loaded once
 * more with CORS (the deliverable's files and the runtime's are served with
 * Access-Control-Allow-Origin: *). A picture that cannot be read keeps its colours.
 */
import { classifyImage, type FigureKind } from '../../editor/figureinvert';
import { state } from './env';

const F = 'invert(1) hue-rotate(180deg)';
const LINEART = 'data-ol-lineart';

let css: HTMLStyleElement | null = null;
let inverted = false;
let judging = false;
/** per picture address: what it is (null: unreadable), judged once per frame */
const kinds = new Map<string, Promise<FigureKind | null>>();

function judge(url: string): Promise<FigureKind | null> {
  let k = kinds.get(url);
  if (!k) {
    k = new Promise(resolve => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(classifyImage(im));
      im.onerror = () => resolve(null);
      im.src = url;
    });
    kinds.set(url, k);
  }
  return k;
}

const addressOf = (img: HTMLImageElement): string => img.currentSrc || img.src;

function mark(img: HTMLImageElement): void {
  const url = addressOf(img);
  if (!url || !img.closest(scope())) return;
  void judge(url).then(k => { if (addressOf(img) === url) img.toggleAttribute(LINEART, k === 'lineart'); });
}

/** the pictures that are inverted with their page: a slide's, or every one of a web page */
const scope = () => (state.kind === 'page' ? 'body' : '.slide');

function scan(): void {
  for (const img of Array.from(document.querySelectorAll<HTMLImageElement>(`${scope()} img`))) mark(img);
}

/** a picture loaded (a new one, or a new address): judged while figures are inverted */
function onLoad(e: Event): void {
  if (judging && e.target instanceof HTMLImageElement) mark(e.target);
}

export function setDarkSlides(on: boolean, figures: boolean): void {
  if (on && !css) {
    css = document.createElement('style');
    css.setAttribute('data-ol-runtime', '');
    const pictures = ':is(img, video, canvas, iframe, object, embed, image, [style*="background-image"], [style*="url("])';
    css.textContent = `html.ol-invert:not(.ol-invert-page) .slide { filter: ${F}; }
      html.ol-invert:not(.ol-invert-page) .slide ${pictures} { filter: ${F}; }
      html.ol-invert.ol-invert-figures:not(.ol-invert-page) .slide img[${LINEART}] { filter: none; }
      html.ol-invert.ol-invert-page { filter: ${F}; }
      :where(html.ol-invert.ol-invert-page) { background-color: #fff; }
      html.ol-invert.ol-invert-page > ol-overlay[data-ol-runtime] { filter: ${F} !important; }
      html.ol-invert.ol-invert-page body ${pictures} { filter: ${F}; }
      html.ol-invert.ol-invert-figures.ol-invert-page body img[${LINEART}] { filter: none; }`;
    document.head.appendChild(css);
    document.addEventListener('load', onLoad, true);
  }
  const root = document.documentElement;
  inverted = on;
  root.classList.toggle('ol-invert', on);
  root.classList.toggle('ol-invert-page', on && state.kind === 'page');
  root.classList.toggle('ol-invert-figures', on && figures);
  const was = judging;
  judging = on && figures;
  if (judging && !was) scan();
}

/** after the page's text changed: its kind may have (slides added to a page), the pictures that came with it are judged (their load events do that too) */
export function darkSlidesChanged(): void {
  document.documentElement.classList.toggle('ol-invert-page', inverted && state.kind === 'page');
  if (judging) scan();
}
