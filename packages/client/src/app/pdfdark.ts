/**
 * Dark PDF pages (like PDF Expert's night mode, or macOS Preview under Smart Invert): in the dark
 * theme the pages of a PDF are shown light on dark — white paper becomes the editor's dark page
 * (--page-bg), black ink its text tone (--editor-fg: white, sepia or grey), and colours keep their
 * hue (the inversion is combined with a 180° hue rotation). The PDF's photographs keep their real
 * colours: pdf.js reports where each raster image was drawn (`recordImages`), each is classified
 * like the editor's figures (editor/figureinvert.ts: line art on a light ground is inverted, a photo
 * is not) and a photo is copied back from the unfiltered rendering. With the `invertFigures`
 * preference off every image keeps its colours.
 *
 * The colours are baked into the page's canvas when it is drawn (PdfViewer renders off-screen and
 * copies): through the SVG filter below with the canvas's own `filter` where the browser has it,
 * pixel by pixel otherwise (Safari). A CSS filter on the canvases would cost nothing to switch but
 * is applied again on every frame — it halved the frame rate while scrolling. Pref `darkPdf` (the ◐
 * button in the PDF toolbar, shown in the dark theme). The web client and the VS Code PDF panel
 * share this through PdfViewer.
 */
import { useEffect, useState } from 'preact/hooks';
import { classifyPixels } from '../editor/figureinvert';
import { getPrefs, subscribePrefs } from '../prefs';

export const DARK_FILTER_ID = 'ol-pdf-dark';
export type RGB = [number, number, number];
/** the page colour and the ink colour of the dark pages */
export interface DarkColours { bg: RGB; fg: RGB }

/** '#121216', '#fff', 'rgb(18, 18, 22)' → [0..1]³; null when unreadable */
export function parseColor(css: string): RGB | null {
  const s = css.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map(c => parseInt(c + c, 16) / 255) as RGB;
  m = /^#([0-9a-f]{6})/i.exec(s);
  if (m) return [0, 2, 4].map(i => parseInt(m![1].slice(i, i + 2), 16) / 255) as RGB;
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [m[1], m[2], m[3]].map(v => Math.min(255, Number(v)) / 255) as RGB;
  return null;
}

/**
 * The per-channel map after the hue rotation: paper (1) → `bg`, ink (0) → `fg`, linear in between
 * (feFuncR/G/B type="linear": out = slope·in + intercept).
 */
export function toneMap(bg: RGB, fg: RGB): { slope: number; intercept: number }[] {
  return [0, 1, 2].map(i => ({ slope: bg[i] - fg[i], intercept: fg[i] }));
}

/** SVG's feColorMatrix type="hueRotate" values="180" (in sRGB): every row sums to 1, so greys stay grey */
const HUE180 = [-0.574, 1.43, 0.144, 0.426, 0.43, 0.144, 0.426, 1.43, -0.856];

/** The dark map applied to RGBA pixels in place — what the SVG filter does, for a canvas without `filter`. */
export function darkenPixels(data: Uint8ClampedArray | number[], { bg, fg }: DarkColours): void {
  const t = toneMap(bg, fg);
  // the tone map per channel as a table: 0..255 after the hue rotation → 0..255
  const lut = t.map(({ slope, intercept }) => Uint8ClampedArray.from({ length: 256 }, (_, v) => Math.round(255 * (slope * (v / 255) + intercept))));
  const [a, b, c, d, e, f, g, h, k] = HUE180;
  const [lr, lg, lb] = lut;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i], gr = data[i + 1], bl = data[i + 2];
    // clamped between the two steps, as between two filter primitives
    data[i] = lr[Math.max(0, Math.min(255, Math.round(a * r + b * gr + c * bl)))];
    data[i + 1] = lg[Math.max(0, Math.min(255, Math.round(d * r + e * gr + f * bl)))];
    data[i + 2] = lb[Math.max(0, Math.min(255, Math.round(g * r + h * gr + k * bl)))];
  }
}

/** The SVG filter for a canvas's `filter`: created once in the document, its colours updated with the theme's. */
export function ensureDarkFilter(bg: RGB, fg: RGB): void {
  if (typeof document === 'undefined') return;
  const NS = 'http://www.w3.org/2000/svg';
  let filter: Element | null = document.getElementById(DARK_FILTER_ID);
  if (!filter) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    const f = document.createElementNS(NS, 'filter');
    f.id = DARK_FILTER_ID;
    f.setAttribute('color-interpolation-filters', 'sRGB');
    const hue = document.createElementNS(NS, 'feColorMatrix');
    hue.setAttribute('type', 'hueRotate');
    hue.setAttribute('values', '180');
    const transfer = document.createElementNS(NS, 'feComponentTransfer');
    for (const c of ['R', 'G', 'B']) { const fn = document.createElementNS(NS, 'feFunc' + c); fn.setAttribute('type', 'linear'); transfer.appendChild(fn); }
    f.append(hue, transfer);
    svg.appendChild(f);
    document.body.appendChild(svg);
    filter = f;
  }
  const funcs = filter.querySelectorAll('feComponentTransfer > *');
  toneMap(bg, fg).forEach((t, i) => { funcs[i]?.setAttribute('slope', t.slope.toFixed(4)); funcs[i]?.setAttribute('intercept', t.intercept.toFixed(4)); });
}

let filterSupport: boolean | null = null;
/** Does a canvas take a `filter` (Chrome, Firefox; not Safari)? */
function canvasFilter(): boolean {
  if (filterSupport === null) {
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      filterSupport = !!ctx && 'filter' in ctx && ((ctx.filter = 'invert(1)'), ctx.filter === 'invert(1)');
    } catch { filterSupport = false; }
  }
  return filterSupport;
}

const isDarkTheme = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
function themeColours(): DarkColours {
  const cs = getComputedStyle(document.documentElement);
  return { bg: parseColor(cs.getPropertyValue('--page-bg')) ?? [0.07, 0.07, 0.086], fg: parseColor(cs.getPropertyValue('--editor-fg')) ?? [1, 1, 1] };
}

/**
 * The dark pages' colours (null: the PDF's own), whether the theme is dark at all (the toolbar
 * shows its switch only then), and whether figures are inverted smartly. Follows `data-theme` /
 * `data-tone` on <html> — the web client's theme.ts and the VS Code webviews both set them.
 */
export function useDarkPages(): { colours: DarkColours | null; themeDark: boolean; invertFigures: boolean } {
  const read = () => {
    const p = getPrefs();
    const themeDark = isDarkTheme();
    return { themeDark, colours: themeDark && p.darkPdf !== false ? themeColours() : null, invertFigures: p.invertFigures };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(s => {
      const n = read();
      return n.themeDark === s.themeDark && n.invertFigures === s.invertFigures && JSON.stringify(n.colours) === JSON.stringify(s.colours) ? s : n;
    });
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-tone'] });
    const unsub = subscribePrefs(update);
    update();
    return () => { mo.disconnect(); unsub(); };
  }, []);
  return state;
}

/** A raster image's place on the page, in canvas pixels (axis-aligned around a rotated one). */
export interface PhotoRect { x: number; y: number; w: number; h: number }

/**
 * pdf.js's image coordinates (six numbers per image: three corners, as fractions of the canvas) →
 * rectangles in pixels of a `width`×`height` canvas, clipped to it; images smaller than `min` px
 * either way (bullets, icons) are left out.
 */
export function imageRects(coords: ArrayLike<number> | null | undefined, width: number, height: number, min = 24): PhotoRect[] {
  const out: PhotoRect[] = [];
  if (!coords) return out;
  for (let i = 0; i + 5 < coords.length; i += 6) {
    const [x0, y0, x1, y1, x2, y2] = [coords[i], coords[i + 1], coords[i + 2], coords[i + 3], coords[i + 4], coords[i + 5]];
    const x3 = x1 + x2 - x0, y3 = y1 + y2 - y0;
    const xs = [x0, x1, x2, x3].map(v => v * width), ys = [y0, y1, y2, y3].map(v => v * height);
    // rounded inwards and a pixel in: the edge pixels are blended with the paper (and pdf.js keeps the corners in half floats), and a white rim would show on the dark page
    const left = Math.max(0, Math.ceil(Math.min(...xs)) + 1), right = Math.min(width, Math.floor(Math.max(...xs)) - 1);
    const top = Math.max(0, Math.ceil(Math.min(...ys)) + 1), bottom = Math.min(height, Math.floor(Math.max(...ys)) - 1);
    if (right - left >= min && bottom - top >= min) out.push({ x: left, y: top, w: right - left, h: bottom - top });
  }
  return out;
}

/** Is this region of the rendered page a photograph (rather than line art on a light ground)? */
function isPhoto(src: HTMLCanvasElement, r: PhotoRect): boolean {
  const c = document.createElement('canvas');
  const cw = Math.min(64, r.w), ch = Math.max(1, Math.min(64, Math.round((cw * r.h) / r.w)));
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, cw, ch);
  return classifyPixels(ctx.getImageData(0, 0, cw, ch).data) === 'photo';
}

/**
 * Draw a rendered page (`src`, the PDF's own colours) onto `ctx` as a dark page: everything
 * through the dark map, then the photographs (or, `allImages`, every raster image) copied back
 * unchanged. `coords`: pdf.js's image coordinates of the page.
 */
export function paintDark(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, colours: DarkColours, coords: ArrayLike<number> | null | undefined, allImages: boolean): void {
  const photos = imageRects(coords, src.width, src.height).filter(r => allImages || isPhoto(src, r));
  if (canvasFilter()) {
    ensureDarkFilter(colours.bg, colours.fg);
    ctx.filter = `url(#${DARK_FILTER_ID})`;
    ctx.drawImage(src, 0, 0);
    ctx.filter = 'none';
  } else {
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, src.width, src.height);
    darkenPixels(img.data, colours);
    ctx.putImageData(img, 0, 0);
  }
  for (const r of photos) ctx.drawImage(src, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
}
