/**
 * QR codes on slides, posters and pages (Insert ▸ QR code): a link, or any text, as a vector code —
 * an inline SVG, sharp at any size (a poster at A0). In the source:
 *
 *   <svg data-ol-qr="https://example.org" role="img" aria-label="QR code: https://example.org"
 *        style="position: absolute; left: …; top: …; width: …; height: …; background: #ffffff"
 *        viewBox="0 0 33 33" shape-rendering="crispEdges"><path fill="#000000" d="M4 4h7v1h-7z…"/></svg>
 *
 * `data-ol-qr` is the text the code holds (what "Edit QR code…" shows and regenerates from); the path
 * is its dark modules, four light modules of quiet zone inside the viewBox, on the SVG's own light
 * background. The page shows it without OverLyX: nothing is generated when it is presented or
 * exported. Fill recolours the dark modules (qrWarning says when a phone may no longer read them).
 * The encoder is core's qr.ts.
 */
import { qrMatrix, qrPath, qrFits } from '@overlyx/core/qr.ts';
import { attr, elementAt, elementChildren, inlineStyle, parseSource, type HElement } from '@overlyx/core/html/source.ts';
import type { HtmlOp, Path } from './protocol';
import { uiPrompt } from '../app/Dialogs';

export const QR_ATTR = 'data-ol-qr';
const QUIET = 4;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const label = (text: string) => `QR code: ${text.length > 120 ? text.slice(0, 117) + '…' : text}`;

/** the code's markup; `place`: its style declarations for where it is (a square), '' in a page's flow. Null: no code holds the text. */
export function qrHtml(text: string, place: string, fill = '#000000'): string | null {
  const m = qrMatrix(text);
  if (!m) return null;
  const n = m.length + 2 * QUIET;
  const where = place.trim().replace(/;?\s*$/, '; ').replace(/^; $/, '');
  return `<svg ${QR_ATTR}="${esc(text)}" role="img" aria-label="${esc(label(text))}" style="${where}background: #ffffff" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path fill="${fill}" d="${qrPath(m, QUIET)}"/></svg>`;
}

const codeAt = (source: string, path: Path): HElement | null => {
  const el = elementAt(parseSource(source).doc, path);
  return el && el.tagName === 'svg' && attr(el, QR_ATTR) !== null ? el : null;
};

/** the text of the QR code at `path` (null: not one) */
export function qrTextAt(source: string, path: Path): string | null {
  const el = codeAt(source, path);
  return el ? attr(el, QR_ATTR) : null;
}

/** another text for the code at `path`: its attributes and its modules alone change — where it is, its colour, name, comments stay */
export function qrEditOps(source: string, path: Path, text: string): HtmlOp[] | null {
  const el = codeAt(source, path), m = qrMatrix(text);
  if (!el || !m) return null;
  const n = m.length + 2 * QUIET;
  const kids = elementChildren(el), k = kids.findIndex(c => c.tagName === 'path');
  const ops: HtmlOp[] = [
    { t: 'attr', path, name: QR_ATTR, value: text },
    { t: 'attr', path, name: 'viewBox', value: `0 0 ${n} ${n}` },
    ...(attr(el, 'aria-label') !== null ? [{ t: 'attr' as const, path, name: 'aria-label', value: label(text) }] : []),
  ];
  if (k >= 0) ops.push({ t: 'attr', path: [...path, k], name: 'd', value: qrPath(m, QUIET) });
  else ops.push({ t: 'inner', path, html: `<path fill="#000000" d="${qrPath(m, QUIET)}"/>` });
  return ops;
}

const PLACE = ['position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'rotate', 'z-index'];

/**
 * A design's "QR code" placeholder (the poster designs': a dashed outline with the words "QR code" or
 * "QR" over it, two objects): given either of the two, the outline's place as style declarations and
 * what the code replaces. Null: `path` is no such placeholder.
 */
export function qrPlaceholderAt(source: string, path: Path): { place: string; replace: Path; remove: Path[] } | null {
  const { doc } = parseSource(source);
  const el = elementAt(doc, path), parent = path.length > 1 ? elementAt(doc, path.slice(0, -1)) : null;
  if (!el || !parent) return null;
  const words = (e: HElement): string => e.childNodes.map(c => ('value' in c ? (c as { value: string }).value : 'tagName' in c ? words(c as HElement) : '')).join('');
  const isLabel = (e: HElement) => e.tagName !== 'svg' && /^\s*QR(\s+code)?\s*$/i.test(words(e));
  const isOutline = (e: HElement) => /dashed/.test(attr(e, 'style') ?? '') && !words(e).trim();
  const sibs = elementChildren(parent), i = path[path.length - 1];
  const same = (a: HElement, b: HElement) => { const x = inlineStyle(a), y = inlineStyle(b); return !!x.get('left') && x.get('left') === y.get('left') && x.get('width') === y.get('width'); };
  const sibPath = (e: HElement) => [...path.slice(0, -1), sibs.indexOf(e)];
  const placeOf = (e: HElement) => { const s = inlineStyle(e); return PLACE.filter(p => s.has(p)).map(p => `${p}: ${s.get(p)}`).join('; '); };
  if (isLabel(el)) {
    // (the outline is written right before its words)
    const outline = [sibs[i - 1], ...sibs].find(s => s && s !== el && isOutline(s) && same(s, el));
    if (outline) return { place: placeOf(outline), replace: sibPath(outline), remove: [path] };
    // a box that says "QR code" itself
    const s = inlineStyle(el);
    return s.get('position') === 'absolute' && s.has('height') ? { place: placeOf(el), replace: path, remove: [] } : null;
  }
  if (isOutline(el)) {
    const lab = [sibs[i + 1], ...sibs].find(s => s && s !== el && isLabel(s) && same(s, el));
    return lab ? { place: placeOf(el), replace: path, remove: [sibPath(lab)] } : null;
  }
  return null;
}

/* ---- can a phone still read it? */

function rgb(color: string): [number, number, number, number] | null {
  const c = color.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(c);
  if (m) {
    const h = m[1].length <= 4 ? m[1].replace(/./g, x => x + x) : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(c);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]];
  return c === 'black' ? [0, 0, 0, 1] : c === 'white' ? [255, 255, 255, 1] : null;
}
const luminance = ([r, g, b]: number[]) => {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

/**
 * What to tell someone who recolours a code: scanners want dark modules on a light ground with a
 * clear difference between the two (a contrast of 4 : 1 is a safe floor; many phones fail on light-
 * on-dark codes). Null: it scans. `ground`: the code's own background, white when it has none.
 */
export function qrWarning(fill: string | null, ground: string | null): string | null {
  if (fill === null) return 'Without a fill the QR code cannot be scanned.';
  const f = rgb(fill), g0 = ground ? rgb(ground) : null;
  if (!f) return null;
  const g = g0 && g0[3] > 0.5 ? g0 : [255, 255, 255, 1];
  const lf = luminance(f), lg = luminance(g);
  if (f[3] < 0.6) return 'This colour is too faint for a QR code — phones may not scan it.';
  if (lf > lg) return 'A QR code needs dark squares on a light ground — many phones cannot scan a light code.';
  const ratio = (lg + 0.05) / (lf + 0.05);
  return ratio < 4 ? 'This colour is too pale for a QR code — phones may not scan it. Choose a darker one.' : null;
}

/** the small dialog: the link or text of a code (`now`: the code's present one). Null: cancelled. */
export function askQr(now?: string): Promise<string | null> {
  return uiPrompt(now === undefined ? 'QR code' : 'Edit QR code', 'The link people open when they scan the code — or any text.', now ?? 'https://', {
    placeholder: 'https://', okLabel: now === undefined ? 'Insert' : 'Update',
    validate: v => !v.trim() || v.trim() === 'https://' ? 'Type a link or a text.' : !qrFits(v.trim()) ? 'That is too long for a QR code. Use a shorter link.' : null,
  }).then(v => (v === null ? null : v.trim() || null));
}
