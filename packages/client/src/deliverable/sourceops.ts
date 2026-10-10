/**
 * The deliverable editor's changes of the text: the runtime's operations (made on the version it
 * showed) rebased onto the text as it is now and turned into splices of the Y.Text; new objects
 * drawn on the canvas; slides added, duplicated, removed; speaker notes. Pure string work (core
 * html/source.ts), so it is tested without a browser.
 */
import { parseSource, opSplices, mapOffset, elementAt, elementChildren, outerRange, attr, hasClass, type HtmlOp, type Path, type Splice, type HElement } from '@overlyx/core/html/source.ts';
import { slideElements } from '@overlyx/core/html/deliverable.ts';
import type { Rect, Tool, DeliverableKind } from './protocol';

/**
 * Splices of `cur` that make the operations — made on `base` — or null when one of them touched
 * text that changed since (somebody else edited that object meanwhile).
 */
export function rebasedSplices(base: string, cur: string, ops: HtmlOp[]): Splice[] | null {
  const src = parseSource(base);
  let splices: Splice[];
  try { splices = ops.flatMap(op => opSplices(src, op)); } catch { return null; }
  // overlapping splices (two operations on one element): the first wins
  splices.sort((a, b) => a.from - b.from || a.to - b.to);
  const clean: Splice[] = [];
  for (const s of splices) {
    const prev = clean[clean.length - 1];
    if (prev && s.from < prev.to) continue;
    clean.push(s);
  }
  if (base === cur) return clean;
  const out: Splice[] = [];
  for (const s of clean) {
    const from = mapOffset(base, cur, s.from), to = mapOffset(base, cur, s.to);
    if (from === null || to === null || to < from) return null;
    out.push({ from, to, insert: s.insert });
  }
  return out;
}

/** splices applied to a text (descending, so earlier offsets stay right) */
export function applyTo(text: string, splices: Splice[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.from - a.from || b.to - a.to)) out = out.slice(0, s.from) + s.insert + out.slice(s.to);
  return out;
}

/* ------------------------------------------------------------------ new objects */

const r = (n: number) => Math.round(n);

/** a star's points in a 100×100 box */
const STAR = Array.from({ length: 10 }, (_, i) => {
  const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? 19.5 : 48;
  return `${Math.round((50 + rr * Math.cos(a)) * 10) / 10},${Math.round((52 + rr * Math.sin(a)) * 10) / 10}`;
}).join(' ');
const POLYGONS: Partial<Record<Tool, string>> = {
  triangle: '50,2 98,98 2,98',
  diamond: '50,2 98,50 50,98 2,50',
  star: STAR,
  hexagon: '25,3 75,3 98,50 75,97 25,97 2,50',
};
const SHAPE_FILL = '#2f6fde';

/** a smooth path through hand-drawn points (quadratic curves through the midpoints) */
export function penPathD(pts: [number, number][]): string {
  const q = (n: number) => Math.round(n * 10) / 10;
  if (!pts.length) return '';
  let d = `M${q(pts[0][0])} ${q(pts[0][1])}`;
  if (pts.length === 1) return d + `L${q(pts[0][0] + 0.1)} ${q(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) d += `Q${q(pts[i][0])} ${q(pts[i][1])} ${q((pts[i][0] + pts[i + 1][0]) / 2)} ${q((pts[i][1] + pts[i + 1][1]) / 2)}`;
  const last = pts[pts.length - 1];
  return d + `L${q(last[0])} ${q(last[1])}`;
}

/**
 * The markup of an object drawn with a tool, at `rect` (slide px; a click without dragging gives it
 * a default size). Boxes (rectangles, ellipses) are divs that centre text typed into them, like
 * Google Slides' shapes; other shapes are SVG polygons stretched to their box with an outline that
 * keeps its width; lines go from the drag's start to its end (`pts`), the pen's stroke through `pts`.
 */
export function objectHtml(tool: Tool, rect: Rect, kind: DeliverableKind, scaleHint = 1, pts?: [number, number][], path?: { d: string; closed: boolean }): string {
  const flow = kind === 'page';
  const minW = (tool === 'text' || tool === 'formula') ? 520 * scaleHint : 240 * scaleHint;
  const w = rect.w > 8 ? rect.w : minW;
  const h = rect.h > 8 ? rect.h : (tool === 'line' || tool === 'arrow' ? 0 : tool === 'text' || tool === 'formula' ? 0 : 160 * scaleHint);
  const pos = (withH: boolean) => flow ? '' : `position: absolute; left: ${r(rect.x)}px; top: ${r(rect.y)}px; width: ${r(w)}px${withH && h ? `; height: ${r(h)}px` : ''}; `;
  const flowSize = flow ? `width: ${r(w)}px; height: ${r(h || 160)}px; ` : '';
  const centred = 'display: flex; align-items: center; justify-content: center; text-align: center; color: #fff; ';
  switch (tool) {
    case 'text': return flow ? '<p>Text</p>' : `<p style="${pos(false)}margin: 0">Text</p>`;
    // empty: LyX's formula editor opens on it at once (left empty, the box goes again); a click
    // centres it on the point, in a size for a slide
    case 'formula': {
      if (flow) return '<p>\\[ \\]</p>';
      const fw = rect.w > 8 ? rect.w : 480 * scaleHint;
      const x = rect.w > 8 ? rect.x : Math.max(0, Math.min(1280 * scaleHint - fw, rect.x - fw / 2));
      const y = rect.h > 8 ? rect.y : Math.max(0, rect.y - 32 * scaleHint);
      return `<div style="position: absolute; left: ${r(x)}px; top: ${r(y)}px; width: ${r(fw)}px; font-size: ${r(40 * scaleHint)}px; text-align: center">\\[ \\]</div>`;
    }
    case 'rect': return `<div style="${pos(true)}${flowSize}${centred}background: ${SHAPE_FILL}; border-radius: 8px"></div>`;
    case 'roundrect': return `<div style="${pos(true)}${flowSize}${centred}background: ${SHAPE_FILL}; border-radius: 28px"></div>`;
    case 'ellipse': return `<div style="${pos(true)}${flowSize}${centred}background: #e8a33d; border-radius: 50%"></div>`;
    case 'triangle': case 'diamond': case 'star': case 'hexagon': {
      const W = r(w), H = r(h || 160 * scaleHint);
      return `<svg style="${flow ? '' : `position: absolute; left: ${r(rect.x)}px; top: ${r(rect.y)}px; `}width: ${W}px; height: ${H}px; overflow: visible" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="${POLYGONS[tool]}" fill="${SHAPE_FILL}" stroke="none" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
    }
    case 'pen': {
      if (!pts || pts.length < 2) return '';
      const x0 = rect.x, y0 = rect.y, W = Math.max(1, r(rect.w)), H = Math.max(1, r(rect.h));
      const d = penPathD(pts.map(([x, y]) => [x - x0, y - y0]));
      return `<svg style="${flow ? '' : `position: absolute; left: ${r(x0)}px; top: ${r(y0)}px; `}width: ${W}px; height: ${H}px; overflow: visible" viewBox="0 0 ${W} ${H}"><path d="${d}" fill="none" stroke="#1d2433" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    case 'bezier': {
      // the Bézier pen's path (in its box's px): an open one is a stroke, a closed one a filled shape
      if (!path?.d) return '';
      const W = Math.max(1, Math.ceil(rect.w)), H = Math.max(1, Math.ceil(rect.h));
      const paint = path.closed ? `fill="${SHAPE_FILL}"` : 'fill="none" stroke="#1d2433" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"';
      return `<svg style="${flow ? '' : `position: absolute; left: ${r(rect.x)}px; top: ${r(rect.y)}px; `}width: ${W}px; height: ${H}px; overflow: visible" viewBox="0 0 ${W} ${H}"><path d="${path.d.replace(/"/g, '')}" ${paint}/></svg>`;
    }
    case 'line': case 'arrow': {
      // from where the drag started to where it ended (a click: a horizontal one)
      const [[ax, ay], [bx, by]] = pts && pts.length === 2 ? pts : [[rect.x, rect.y], [rect.x + w, rect.y]];
      const x0 = Math.min(ax, bx), y0 = Math.min(ay, by);
      const W = Math.max(1, r(Math.abs(bx - ax))), H = Math.max(1, r(Math.abs(by - ay)));
      const q = (n: number) => Math.round(n * 10) / 10;
      const head = tool === 'arrow' ? `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>` : '';
      return `<svg style="${flow ? '' : `position: absolute; left: ${r(x0)}px; top: ${r(y0)}px; `}width: ${W}px; height: ${H}px; overflow: visible; color: #1d2433" viewBox="0 0 ${W} ${H}">${head}<line x1="${q(ax - x0)}" y1="${q(ay - y0)}" x2="${q(bx - x0)}" y2="${q(by - y0)}" stroke="currentColor" stroke-width="4"${tool === 'arrow' ? ' marker-end="url(#ah)"' : ''}/></svg>`;
    }
    default: return '';
  }
}

/* ------------------------------------------------------------------ SVG files as drawings */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const SAFE_DATA = /^data:image\/(png|jpe?g|gif|webp|avif);/i;

/**
 * An SVG file made a drawing on the page (inline, so its shapes can be selected, moved and painted
 * one by one): scripts, event handlers, foreign content, links out of the file and editor-private
 * markup (Inkscape's, Sodipodi's) removed; its ids prefixed so two drawings never share one; sized
 * from its viewBox. Null when it is not an SVG, or too big to be worth inlining (then it goes in as
 * a picture).
 */
export function inlineSvgHtml(svgText: string, at: { x: number; y: number; maxW: number } | null, prefix: string): string | null {
  if (svgText.length > 400_000) return null;
  let doc: Document;
  try { doc = new DOMParser().parseFromString(svgText, 'image/svg+xml'); } catch { return null; }
  const svg = doc.documentElement;
  if (!svg || svg.localName !== 'svg' || svg.namespaceURI !== SVG_NS || doc.getElementsByTagName('parsererror').length) return null;
  // what must not be in a page
  for (const el of Array.from(svg.querySelectorAll('*'))) {
    const ln = el.localName.toLowerCase();
    if (el.namespaceURI !== SVG_NS || ['script', 'foreignobject', 'iframe', 'object', 'embed', 'metadata', 'title', 'desc'].includes(ln)) { el.remove(); continue; }
    if ((ln === 'set' || ln === 'animate') && /^(xlink:)?href$|^on/i.test(el.getAttribute('attributeName') ?? '')) { el.remove(); continue; }
  }
  const idMap = new Map<string, string>();
  for (const el of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      const pre = a.prefix ?? (n.includes(':') ? n.split(':')[0] : null);
      if (n.startsWith('on') || (pre && !['xlink', 'xml', 'xmlns'].includes(pre)) || n.startsWith('xmlns:') && !['xmlns:xlink'].includes(n)) { el.removeAttributeNode(a); continue; }
      if (n === 'href' || n === 'xlink:href') {
        const v = a.value.trim();
        if (!(v.startsWith('#') || SAFE_DATA.test(v))) el.removeAttributeNode(a);
        continue;
      }
      if (/url\(\s*['"]?\s*(?!#)/i.test(a.value) && n !== 'id') el.setAttribute(a.name, a.value.replace(/url\(\s*['"]?\s*(?!#)[^)]*\)/gi, 'none'));
    }
    const id = el.getAttribute('id');
    if (id) { const nid = `${prefix}-${id}`; idMap.set(id, nid); el.setAttribute('id', nid); }
  }
  // references to the renamed ids
  const swap = (v: string) => v.replace(/url\(\s*(['"]?)#([^)'"]+)\1\s*\)/g, (m, q, id) => (idMap.has(id) ? `url(#${idMap.get(id)})` : m));
  for (const el of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) {
      if ((a.name === 'href' || a.name === 'xlink:href') && a.value.startsWith('#')) { const id = a.value.slice(1); if (idMap.has(id)) el.setAttributeNS(a.namespaceURI, a.name, '#' + idMap.get(id)); }
      else if (a.value.includes('url(')) el.setAttribute(a.name, swap(a.value));
    }
  }
  for (const st of Array.from(svg.querySelectorAll('style'))) {
    let css = (st.textContent ?? '').replace(/@import[^;]*;?/gi, '');
    css = swap(css).replace(/#([A-Za-z_][\w-]*)/g, (m, id) => (idMap.has(id) ? '#' + idMap.get(id) : m));
    st.textContent = css;
  }
  // its size: width / height, else the viewBox
  const num = (v: string | null) => { const m = v ? /^\s*([\d.]+)\s*(px|pt|mm|cm|in)?\s*$/.exec(v) : null; if (!m) return NaN; const k = { pt: 4 / 3, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 } as Record<string, number>; return Number(m[1]) * (m[2] ? k[m[2]] ?? 1 : 1); };
  const vb = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  let w = num(svg.getAttribute('width')), h = num(svg.getAttribute('height'));
  if (vb.length === 4 && vb.every(Number.isFinite)) {
    if (!Number.isFinite(w) && !Number.isFinite(h)) { w = vb[2]; h = vb[3]; }
    else if (!Number.isFinite(w)) w = h * vb[2] / vb[3];
    else if (!Number.isFinite(h)) h = w * vb[3] / vb[2];
  } else {
    if (!Number.isFinite(w)) w = 300;
    if (!Number.isFinite(h)) h = 150;
    svg.setAttribute('viewBox', `0 0 ${Math.round(w * 100) / 100} ${Math.round(h * 100) / 100}`);
  }
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.removeAttribute('style');
  svg.removeAttribute('class');
  if (at) {
    const k = w > at.maxW ? at.maxW / w : 1;
    const W = Math.max(8, w * k), H = Math.max(8, h * k);
    svg.setAttribute('style', `position: absolute; left: ${r(at.x - W / 2)}px; top: ${r(at.y - H / 2)}px; width: ${r(W)}px; height: ${r(H)}px; overflow: visible`);
  } else svg.setAttribute('style', `width: ${r(Math.min(w, 960))}px; max-width: 100%; height: auto`);
  let out = new XMLSerializer().serializeToString(svg);
  // what the HTML parser does not need
  out = out.replace(/\sxmlns(:\w+)?="[^"]*"/g, (m, p1) => (p1 === ':xlink' ? m : '')).replace(/<!--[\s\S]*?-->/g, '');
  return out.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
}

export function imageHtml(src: string, rect: Rect | null, kind: DeliverableKind, natural?: { w: number; h: number }): string {
  const esc = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  if (kind === 'page' || !rect) return `<img src="${esc}" alt="" style="max-width: 100%">`;
  const w = rect.w > 8 ? rect.w : Math.min(natural?.w ?? 480, 640);
  return `<img src="${esc}" alt="" style="position: absolute; left: ${r(rect.x)}px; top: ${r(rect.y)}px; width: ${r(w)}px">`;
}

/** where a new object goes and what its path will be: the end of the slide (or after `after` on a web page) */
export function insertPlace(text: string, slide: Path | null, after: Path | null, kind: DeliverableKind): { parent: Path; index: number; path: Path } | null {
  const { doc } = parseSource(text);
  if (kind !== 'page' && slide) {
    const s = elementAt(doc, slide);
    if (!s) return null;
    // before the speaker notes, which stay last
    const kids = elementChildren(s);
    const notes = kids.findIndex(k => k.tagName === 'aside' && hasClass(k, 'notes'));
    const index = notes >= 0 ? notes : kids.length;
    return { parent: slide, index, path: [...slide, index] };
  }
  if (after && after.length > 1) {
    const parent = after.slice(0, -1);
    const index = after[after.length - 1] + 1;
    return { parent, index, path: [...parent, index] };
  }
  // the end of <main>, else of <body>
  const body = elementAt(doc, [1]);
  if (!body) return null;
  const kids = elementChildren(body);
  const main = kids.findIndex(k => k.tagName === 'main');
  if (main >= 0) { const n = elementChildren(kids[main]).length; return { parent: [1, main], index: n, path: [1, main, n] }; }
  const n = kids.filter(k => k.tagName !== 'script').length;
  return { parent: [1], index: n, path: [1, n] };
}

/* ------------------------------------------------------------------ slides */

export function slidePaths(text: string): Path[] {
  const { doc } = parseSource(text);
  return slideElements(doc).map(pathOfEl);
}

function pathOfEl(el: HElement): Path {
  const out: number[] = [];
  let cur: HElement = el;
  while (cur.parentNode && 'tagName' in cur.parentNode) {
    const p = cur.parentNode as HElement;
    out.unshift(elementChildren(p).indexOf(cur));
    cur = p;
  }
  return out;
}

/**
 * A new slide after slide `i`: the slide's own element with its objects emptied of text — the same
 * design, nothing to delete — or, from `blank`, the slide element alone.
 */
export function newSlideHtml(text: string, i: number, blank = false): string | null {
  const { doc, text: t } = parseSource(text);
  const ss = slideElements(doc);
  const s = ss[i] ?? ss[ss.length - 1];
  if (!s?.sourceCodeLocation?.startTag) return null;
  const open = t.slice(s.sourceCodeLocation.startTag.startOffset, s.sourceCodeLocation.startTag.endOffset);
  const close = `</${s.tagName}>`;
  if (blank) return `${open}\n</${s.tagName}>`;
  // keep the headings (retitled) and the shapes; drop text boxes' text but the first heading's
  const kids = elementChildren(s);
  const parts: string[] = [];
  let titled = false;
  for (const k of kids) {
    if (k.tagName === 'aside' && hasClass(k, 'notes')) continue;
    if (!k.sourceCodeLocation) continue;
    const { from, to } = outerRange(k);
    const src = t.slice(from, to);
    const textual = /^(h[1-6]|p|ul|ol|div|blockquote)$/.test(k.tagName) && /\S/.test(textOf(k));
    if (!textual) { parts.push(src); continue; }
    if (/^h[1-6]$/.test(k.tagName) && !titled) {
      titled = true;
      const st = k.sourceCodeLocation.startTag!;
      parts.push(t.slice(st.startOffset, st.endOffset) + 'Title' + `</${k.tagName}>`);
    }
  }
  if (!titled) parts.unshift('<h2>Title</h2>');
  return `${open}\n  ${parts.join('\n  ')}\n${close}`;
}

function textOf(el: HElement): string {
  let s = '';
  for (const n of el.childNodes) s += 'value' in n ? (n as { value: string }).value : 'tagName' in n ? textOf(n as HElement) : '';
  return s;
}

/** the speaker notes of a slide (text), and the operation that sets them */
export function slideNotes(text: string, slide: Path): { text: string; path: Path | null } {
  const { doc } = parseSource(text);
  const s = elementAt(doc, slide);
  if (!s) return { text: '', path: null };
  const kids = elementChildren(s);
  const i = kids.findIndex(k => k.tagName === 'aside' && hasClass(k, 'notes'));
  if (i < 0) return { text: '', path: null };
  return { text: textOf(kids[i]).trim(), path: [...slide, i] };
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function notesOp(text: string, slide: Path, notes: string): HtmlOp | null {
  const cur = slideNotes(text, slide);
  if (cur.text === notes.trim()) return null;
  if (cur.path) return notes.trim() ? { t: 'inner', path: cur.path, html: escText(notes.trim()) } : { t: 'remove', paths: [cur.path] };
  if (!notes.trim()) return null;
  const { doc } = parseSource(text);
  const s = elementAt(doc, slide);
  if (!s) return null;
  return { t: 'insert', parent: slide, index: elementChildren(s).length, html: `<aside class="notes">${escText(notes.trim())}</aside>` };
}

/** the source text of the element at `path` (for "Edit code") */
export function sourceRange(text: string, path: Path): { from: number; to: number } | null {
  const el = elementAt(parseSource(text).doc, path);
  if (!el?.sourceCodeLocation) return null;
  return outerRange(el);
}

export { attr };
