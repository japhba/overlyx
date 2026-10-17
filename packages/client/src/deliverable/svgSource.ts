import { inlineSvgHtml, SVG_FILE_LIMIT } from './sourceops';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';
/** marks the SVG file's own drawing on the canvas page; anything else there was added on top of it */
export const SVG_FILE_ROOT = 'data-ol-svgfile';
/** what the canvas puts in the root's style to place it on the page */
const CANVAS_STYLE = ['position', 'left', 'top', 'width', 'height', 'max-width', 'overflow'];

/** The SVG file as a one-page canvas (sourceops inlineSvgHtml `asFile`), sized as the file is. */
export function svgCanvasSource(source: string): string {
  if (source.length > SVG_FILE_LIMIT) throw new Error(`This SVG is over ${SVG_FILE_LIMIT / 1e6} MB, too big to edit here.`);
  const svg = inlineSvgHtml(source, null, 'drawing', true);
  if (!svg) throw new Error('This file could not be opened as an SVG drawing.');
  // as the canvas will read it: HTML (Inkscape's prefixed names are not declared any more)
  const root = new DOMParser().parseFromString(`<!doctype html><body>${svg}`, 'text/html').body.firstElementChild as SVGSVGElement | null;
  if (!root || root.localName !== 'svg') throw new Error('This file could not be opened as an SVG drawing.');
  const width = Math.max(8, Number.parseFloat(root.style.width) || 300);
  const height = Math.max(8, Number.parseFloat(root.style.height) || 150);
  const css = root.style;
  for (const [key, value] of Object.entries({ position: 'absolute', left: '0', top: '0', width: width + 'px', height: height + 'px', overflow: 'visible' })) css.setProperty(key, value);
  css.removeProperty('max-width');
  root.setAttribute(SVG_FILE_ROOT, '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="overlyx" content="poster"><style>html,body{margin:0}.slide{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:transparent}*{box-sizing:border-box}</style></head><body><section class="slide" style="position:relative;width:${width}px;height:${height}px">${root.outerHTML}</section></body></html>`;
}

/** what precedes the root element: the XML declaration, comments, a doctype */
function prologOf(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return /^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>)*/i.exec(text)?.[0] ?? '';
}

/**
 * The SVG file again, from the edited canvas page (`html`, svgCanvasSource's markup as edited): the
 * drawing's markup made XML again with the spelling and namespaces of the file's names (the HTML
 * parser lowercases `rdf:RDF` and knows no `inkscape:` prefix), the root's own size, style,
 * declarations and prolog, and objects added on the page on top of it (`added`: those objects
 * exported as SVG in page pixels) as one more group in the drawing's user units. Object names and
 * locks are written as Inkscape's labels and locks. Null when the drawing is no longer on the page.
 */
export function svgFileFromCanvas(original: string, html: string, added?: string | null): string | null {
  const page = new DOMParser().parseFromString(html, 'text/html');
  const slide = page.querySelector<HTMLElement>('section.slide');
  const drawing = slide && Array.from(slide.children).find(el => el.localName === 'svg' && el.hasAttribute(SVG_FILE_ROOT)) as SVGSVGElement | undefined;
  if (!slide || !drawing) return null;
  const file = new DOMParser().parseFromString(original, 'image/svg+xml');
  const root = file.documentElement;
  if (!root || root.localName !== 'svg' || file.getElementsByTagName('parsererror').length) return null;
  const spelling = new Map<string, string>();
  const spaces = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace'], ['xlink', 'http://www.w3.org/1999/xlink'], ['inkscape', INKSCAPE_NS], ['sodipodi', 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd']]);
  for (const el of [root, ...Array.from(root.getElementsByTagName('*'))]) {
    if (!spelling.has(el.nodeName.toLowerCase())) spelling.set(el.nodeName.toLowerCase(), el.nodeName);
    if (el.prefix && el.namespaceURI) spaces.set(el.prefix, el.namespaceURI);
    for (const a of Array.from(el.attributes)) {
      if (!spelling.has(a.name.toLowerCase())) spelling.set(a.name.toLowerCase(), a.name);
      if (a.prefix === 'xmlns') spaces.set(a.localName, a.value);
      else if (a.prefix && a.namespaceURI) spaces.set(a.prefix, a.namespaceURI);
    }
  }
  const doc = document.implementation.createDocument(SVG_NS, null, null);
  const named = (name: string, own: string | null): [string | null, string] => {
    name = spelling.get(name.toLowerCase()) ?? name;
    const colon = name.indexOf(':');
    return colon > 0 ? [spaces.get(name.slice(0, colon)) ?? null, name] : [own, name];
  };
  const element = (el: Element): Element | null => {
    const [ns, name] = named(el.localName, el.namespaceURI);
    if (!ns) return null; // a prefix the file never declared
    const made = doc.createElementNS(ns, name);
    for (const a of Array.from(el.attributes)) {
      if (a.namespaceURI === XMLNS_NS || a.name.startsWith('data-ol-')) continue;
      if (a.namespaceURI) { made.setAttributeNS(a.namespaceURI, a.name, a.value); continue; }
      const [ans, an] = named(a.name, null);
      if (an.includes(':') && !ans) continue;
      made.setAttributeNS(ans, an, a.value);
    }
    const label = el.getAttribute('data-ol-name');
    if (label) made.setAttributeNS(INKSCAPE_NS, 'inkscape:label', label);
    if (el.hasAttribute('data-ol-locked') && el !== drawing) made.setAttributeNS(spaces.get('sodipodi')!, 'sodipodi:insensitive', 'true');
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) made.appendChild(doc.createTextNode(child.nodeValue ?? ''));
      else if (child.nodeType === 8) made.appendChild(doc.createComment(child.nodeValue ?? ''));
      else if (child.nodeType === 1) { const kid = element(child as Element); if (kid) made.appendChild(kid); }
    }
    return made;
  };
  const out = element(drawing)!;
  doc.appendChild(out);
  // the root as the file has it: the canvas only placed it on the page
  const W = Number.parseFloat(slide.style.width) || 0, H = Number.parseFloat(slide.style.height) || 0;
  const css = drawing.style;
  const left = Number.parseFloat(css.left) || 0, top = Number.parseFloat(css.top) || 0;
  const w = Number.parseFloat(css.width) || W, h = Number.parseFloat(css.height) || H;
  for (const key of CANVAS_STYLE) css.removeProperty(key);
  const before = page.createElement('div');
  before.setAttribute('style', root.getAttribute('style') ?? '');
  for (const key of CANVAS_STYLE) before.style.removeProperty(key);
  if (before.style.cssText === css.cssText) {
    if (root.hasAttribute('style')) out.setAttribute('style', root.getAttribute('style')!);
    else out.removeAttribute('style');
  } else out.setAttribute('style', css.cssText);
  if (!root.hasAttribute('viewBox')) out.removeAttribute('viewBox');
  for (const a of Array.from(root.attributes)) if (!out.hasAttributeNS(a.namespaceURI, a.localName)) out.setAttributeNS(a.namespaceURI, a.name, a.value);
  // resized on the canvas: the same units, scaled
  if (W && H && (Math.abs(w - W) > 0.5 || Math.abs(h - H) > 0.5)) {
    for (const [key, k] of [['width', w / W], ['height', h / H]] as const) {
      const m = /^\s*([\d.]+)\s*([a-z%]*)\s*$/i.exec(root.getAttribute(key) ?? '');
      out.setAttribute(key, m ? `${+(Number(m[1]) * k).toFixed(4)}${m[2]}` : `${+(key === 'width' ? w : h).toFixed(2)}`);
    }
  }
  if (added) {
    const extra = new DOMParser().parseFromString(added, 'image/svg+xml').documentElement;
    if (extra?.localName === 'svg' && extra.children.length) {
      // page px → the drawing's user units (its viewBox fitted into its box as preserveAspectRatio says)
      const vb = (out.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
      const [vx, vy, vw, vh] = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0 ? vb : [0, 0, w, h];
      const par = (out.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet').trim();
      let sx = w / vw, sy = h / vh, tx = 0, ty = 0;
      if (!par.startsWith('none')) {
        sx = sy = par.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy);
        const fx = /xMid/.test(par) ? 0.5 : /xMax/.test(par) ? 1 : 0, fy = /YMid/.test(par) ? 0.5 : /YMax/.test(par) ? 1 : 0;
        tx = (w - vw * sx) * fx; ty = (h - vh * sy) * fy;
      }
      const g = doc.createElementNS(SVG_NS, 'g');
      const n = (v: number) => +v.toFixed(6);
      g.setAttribute('transform', `matrix(${n(1 / sx)} 0 0 ${n(1 / sy)} ${n(vx - (left + tx) / sx)} ${n(vy - (top + ty) / sy)})`);
      if (Array.from(root.attributes).some(a => a.value === INKSCAPE_NS)) {
        g.setAttributeNS(INKSCAPE_NS, 'inkscape:groupmode', 'layer');
        g.setAttributeNS(INKSCAPE_NS, 'inkscape:label', 'Drawn in OverLyX');
      }
      for (const kid of Array.from(extra.children)) g.appendChild(doc.importNode(kid, true));
      out.appendChild(g);
    }
  }
  return prologOf(original) + new XMLSerializer().serializeToString(out) + (/\n\s*$/.test(original) ? '\n' : '');
}
