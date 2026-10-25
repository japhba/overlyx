/**
 * The deliverable editor's changes of the text: the runtime's operations (made on the version it
 * showed) rebased onto the text as it is now and turned into splices of the Y.Text; new objects
 * drawn on the canvas; slides added, duplicated, removed; speaker notes. Pure string work (core
 * html/source.ts), so it is tested without a browser.
 */
import { GUIDES_ATTR } from './guides';
import { PH_ATTR, isRole } from './decklayouts';
import { MASTER_ATTR, numberObjects } from './deckmaster';
import { parseSource, opSplices, mapOffset, elementAt, elementStartingAt, elementChildren, walk, outerRange, attr, hasClass, pathOf, type HtmlOp, type Path, type Splice, type HElement } from '@overlyx/core/html/source.ts';
import { textChanges, mapTextOffset } from '@overlyx/core/html/textedit.ts';
import { slideElements } from '@overlyx/core/html/deliverable.ts';
import type { Rect, Tool, DeliverableKind, InkStyle, InkRunD } from './protocol';

/** Follow an object from the canvas's source into the current source, preserving identity. */
function mappedObjectPath(base: string, cur: string, src: ReturnType<typeof parseSource>, current: ReturnType<typeof parseSource>, changes: Splice[], path: Path): Path | null {
  const old = elementAt(src.doc, path), start = old?.sourceCodeLocation?.startTag;
  if (!old || !start) return null;
  const end = old.sourceCodeLocation?.endTag;
  if (end && changes.some(s => Math.max(s.from, end.startOffset) < Math.min(s.to, end.endOffset))) return null;
  // A changed opening tag can survive; a replaced whole object cannot become its neighbour.
  const replacement = changes.find(s => s.from <= start.startOffset && start.startOffset < s.to);
  const openingLost = replacement && (replacement.from !== start.startOffset || replacement.to > start.endOffset)
    || changes.some(s => s.from < start.endOffset && s.to > start.endOffset);
  if (openingLost) {
    // Deleting a preceding sibling and restyling this tag can be one diff. A surviving
    // closing tag and unique unchanged contents still identify the selected object.
    if (!end) return null;
    const inner = base.slice(start.endOffset, end.startOffset);
    if (!inner.trim() || changes.some(s => Math.max(s.from, start.endOffset) < Math.min(s.to, end.startOffset)
      || s.from === s.to && start.endOffset <= s.from && s.from <= end.startOffset)) return null;
    const matches = (doc: ReturnType<typeof parseSource>['doc'], text: string) => [...walk(doc)].filter(el => {
      const loc = el.sourceCodeLocation;
      return el.tagName === old.tagName && loc?.startTag && loc.endTag
        && text.slice(loc.startTag.endOffset, loc.endTag.startOffset) === inner;
    });
    const oldMatches = matches(src.doc, base), currentMatches = matches(current.doc, cur);
    const target = currentMatches[0];
    if (oldMatches.length !== 1 || currentMatches.length !== 1
      || target.sourceCodeLocation?.endTag?.startOffset !== mapTextOffset(changes, end.startOffset)) return null;
    return pathOf(target);
  }
  const mapped = mapTextOffset(changes, start.startOffset);
  if (mapped === null) return null;
  const target = elementStartingAt(current.doc, mapped);
  if (!target || target.tagName !== old.tagName) return null;
  const targetTag = target.sourceCodeLocation?.startTag;
  // Void elements lack a closing tag that would distinguish repeated siblings.
  if (!end && targetTag && old.parentNode && target.parentNode
    && 'tagName' in old.parentNode && 'tagName' in target.parentNode
    && elementChildren(old.parentNode).length !== elementChildren(target.parentNode).length
    && base.slice(start.startOffset, start.endOffset) !== cur.slice(targetTag.startOffset, targetTag.endOffset)) return null;
  return pathOf(target);
}

/** Source-side toolbar actions follow selected objects, not their old sibling indices. */
export function rebaseObjectPaths(base: string, cur: string, paths: readonly Path[]): Path[] | null {
  if (base === cur) return paths.map(path => [...path]);
  const src = parseSource(base), current = parseSource(cur), changes = textChanges(base, cur);
  const out: Path[] = [];
  for (const path of paths) {
    const mapped = mappedObjectPath(base, cur, src, current, changes, path);
    if (!mapped) return null;
    out.push(mapped);
  }
  return out;
}

/**
 * Splices of `cur` that make the operations — made on `base` — or null when one of them touched
 * text that changed since (somebody else edited that object meanwhile).
 */
export function rebasedSplices(base: string, cur: string, ops: HtmlOp[]): Splice[] | null {
  const src = parseSource(base);
  // Text carries its local baseline; styles name just the properties being changed.
  // Apply both against the same surviving object in the current source. Offset-only
  // rebasing drops rapid nudges after their own first style edit changes the tag.
  const semantic = ops.filter((op): op is Extract<HtmlOp, { t: 'inner' | 'style' }> => op.t === 'style' || op.t === 'inner' && op.before !== undefined);
  if (base !== cur && semantic.length) {
    const current = parseSource(cur), changes = textChanges(base, cur);
    const other = ops.filter(op => !semantic.includes(op as Extract<HtmlOp, { t: 'inner' | 'style' }>));
    const splices = rebasedSplices(base, cur, other);
    if (!splices) return null;
    try {
      for (const op of semantic) {
        const path = mappedObjectPath(base, cur, src, current, changes, op.path);
        if (!path) return null;
        splices.push(...opSplices(current, { ...op, path }));
      }
    } catch { return null; }
    return splices.sort((a, b) => a.from - b.from || a.to - b.to);
  }
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
 * keeps its width; lines go from the drag's start to its end (`pts`); Draw's stroke is its outline
 * (`path`: runtime/freehand.ts, in its box's px) filled with its `ink` — the highlighter's translucent,
 * multiplied over what is under it so text stays dark (an older pen's stroke: a line through `pts`).
 */
export function objectHtml(tool: Tool, rect: Rect, kind: DeliverableKind, scaleHint = 1, pts?: [number, number][], path?: { d: string; closed: boolean; runs?: InkRunD[] }, ink?: InkStyle): string {
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
    // the works cited, listed by the runtime (cite.ts) as LaTeX's \bibliography: here only its box
    case 'references': {
      if (flow) return '<div class="ol-bibliography"></div>';
      const bw = rect.w > 8 ? rect.w : 900 * scaleHint;
      const x = rect.w > 8 ? rect.x : Math.max(0, Math.min(1280 * scaleHint - bw, rect.x - bw / 2));
      return `<div class="ol-bibliography" style="position: absolute; left: ${r(x)}px; top: ${r(rect.y)}px; width: ${r(bw)}px; font-size: ${r(22 * scaleHint)}px; line-height: 1.35"></div>`;
    }
    case 'rect': return `<div style="${pos(true)}${flowSize}${centred}background: ${SHAPE_FILL}; border-radius: 8px"></div>`;
    case 'roundrect': return `<div style="${pos(true)}${flowSize}${centred}background: ${SHAPE_FILL}; border-radius: 28px"></div>`;
    case 'ellipse': return `<div style="${pos(true)}${flowSize}${centred}background: #e8a33d; border-radius: 50%"></div>`;
    case 'triangle': case 'diamond': case 'star': case 'hexagon': {
      const W = r(w), H = r(h || 160 * scaleHint);
      return `<svg style="${flow ? '' : `position: absolute; left: ${r(rect.x)}px; top: ${r(rect.y)}px; `}width: ${W}px; height: ${H}px; overflow: visible" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="${POLYGONS[tool]}" fill="${SHAPE_FILL}" stroke="none" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
    }
    case 'pen': {
      // Draw's stroke (runtime/freehand.ts): runs of the line at one width each, stroked with round caps and joins (no fill, each: a Fill for the selection leaves them be)
      const runs = (path?.runs ?? []).filter(u => u.w > 0 && u.w <= 400 && typeof u.d === 'string').map(u => ({ w: Math.round(u.w * 100) / 100, d: u.d.replace(/[^ML0-9 .-]/g, '') })).filter(u => /^M/.test(u.d));
      if (runs.length) {
        const W = Math.max(1, Math.ceil(rect.w)), H = Math.max(1, Math.ceil(rect.h));
        const color = ink && /^(#[0-9a-fA-F]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\))$/.test(ink.color) ? ink.color : '#1d2433';
        const hl = !!ink && ink.opacity < 1;
        return `<svg class="ol-ink" style="${flow ? '' : `position: absolute; left: ${r(rect.x)}px; top: ${r(rect.y)}px; `}width: ${W}px; height: ${H}px; overflow: visible${hl ? '; mix-blend-mode: multiply' : ''}" viewBox="0 0 ${W} ${H}"><g fill="none" stroke="${color}"${hl ? ` stroke-opacity="${Math.round(ink!.opacity * 100) / 100}"` : ''} stroke-linecap="round" stroke-linejoin="round">${runs.map(u => `<path fill="none" stroke-width="${u.w}" d="${u.d}"/>`).join('')}</g></svg>`;
      }
      if (path?.d) {
        const W = Math.max(1, Math.ceil(rect.w)), H = Math.max(1, Math.ceil(rect.h));
        const color = ink && /^(#[0-9a-fA-F]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\))$/.test(ink.color) ? ink.color : '#1d2433';
        const hl = !!ink && ink.opacity < 1;
        return `<svg class="ol-ink" style="${flow ? '' : `position: absolute; left: ${r(rect.x)}px; top: ${r(rect.y)}px; `}width: ${W}px; height: ${H}px; overflow: visible${hl ? '; mix-blend-mode: multiply' : ''}" viewBox="0 0 ${W} ${H}"><path d="${path.d.replace(/[^MLQCZz0-9 .,-]/g, '')}" fill="${color}"${hl ? ` fill-opacity="${Math.round(ink!.opacity * 100) / 100}"` : ''}/></svg>`;
      }
      if (!pts || pts.length < 2) return '';
      const x0 = rect.x, y0 = rect.y, W = Math.max(1, r(rect.w)), H = Math.max(1, r(rect.h));
      const d = penPathD(pts.map(([x, y]) => [x - x0, y - y0]));
      const color = ink && /^(#[0-9a-fA-F]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\))$/.test(ink.color) ? ink.color : '#1d2433';
      const width = ink && ink.width > 0 ? Math.round(ink.width * 10) / 10 : 4;
      const hl = !!ink && ink.opacity < 1;
      return `<svg style="${flow ? '' : `position: absolute; left: ${r(x0)}px; top: ${r(y0)}px; `}width: ${W}px; height: ${H}px; overflow: visible${hl ? '; mix-blend-mode: multiply' : ''}" viewBox="0 0 ${W} ${H}"><path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"${hl ? ` stroke-opacity="${Math.round(ink!.opacity * 100) / 100}"` : ''} stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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

/** Neutralize event names before browser parsing, retaining XML syntax and values for validation. */
function inertSvgSource(text: string): { text: string; prefix: string } | null {
  const occupied = new Set<number>();
  const edits: { from: number; to: number; name: string }[] = [];
  const space = (c: string | undefined) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f';
  const after = (at: number, delimiter: string) => {
    const end = text.indexOf(delimiter, at);
    return end < 0 ? text.length : end + delimiter.length;
  };
  let position = 0;
  while (position < text.length) {
    const start = text.indexOf('<', position);
    if (start < 0) break;
    if (text.startsWith('<!--', start)) { position = after(start + 4, '-->'); continue; }
    if (text.startsWith('<![CDATA[', start)) { position = after(start + 9, ']]>'); continue; }
    if (text.startsWith('<?', start)) { position = after(start + 2, '?>'); continue; }
    if (text.startsWith('<!', start)) {
      // Ordinary external SVG doctypes are inert. An internal subset could
      // expand handlers into markup not present as literal source tags.
      let quote = '', end = start + 2;
      for (; end < text.length; end++) {
        const c = text[end];
        if (quote) { if (c === quote) quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '[' || text.startsWith('<!ENTITY', start)) return null;
        else if (c === '>') { end++; break; }
      }
      position = end;
      continue;
    }
    // Find the complete raw tag, including '>' inside quoted values. XML does
    // not have HTML's raw-text elements: nested style/textarea tags count too.
    let quote = '', end = start + 1;
    for (; end < text.length; end++) {
      const c = text[end];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') { end++; break; }
    }
    position = end;
    if (text[start + 1] === '/') continue;
    let i = start + 1;
    while (i < end && !space(text[i]) && text[i] !== '/' && text[i] !== '>') i++;
    const names = new Set<string>();
    while (i < end) {
      while (space(text[i])) i++;
      if (i >= end || text[i] === '/' || text[i] === '>') break;
      const from = i;
      while (i < end && !space(text[i]) && !['=', '/', '>'].includes(text[i])) i++;
      if (i === from) break; // malformed syntax remains for the native XML parser
      const name = text.slice(from, i);
      if (names.has(name)) return null;
      names.add(name);
      const reserved = /^data-ol-svg-inert-(\d+)-/i.exec(name);
      if (reserved) occupied.add(Number(reserved[1]));
      if (!name.includes(':') && name.toLowerCase().startsWith('on')) edits.push({ from, to: i, name });
      while (space(text[i])) i++;
      if (text[i] !== '=') continue;
      i++;
      while (space(text[i])) i++;
      const delimiter = text[i];
      if (delimiter === '"' || delimiter === "'") {
        i++;
        while (i < end && text[i] !== delimiter) i++;
        if (text[i] === delimiter) i++;
      } else {
        while (i < end && !space(text[i]) && text[i] !== '/' && text[i] !== '>') i++;
      }
    }
  }
  let index = 0;
  while (occupied.has(index)) index++;
  const prefix = `data-ol-svg-inert-${index}-`;
  // Preserve all original syntax/values for native XML validation. Build once
  // so many small handler attributes cannot cause quadratic string copying.
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(text.slice(cursor, edit.from), prefix, edit.name);
    cursor = edit.to;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(''), prefix };
}

/**
 * An SVG file made a drawing on the page (inline, so its shapes can be selected, moved and painted
 * one by one): scripts, event handlers, foreign content, links out of the file and editor-private
 * markup (Inkscape's, Sodipodi's) removed; its ids prefixed so two drawings never share one; sized
 * from its viewBox. Null when it is not an SVG, or too big to be worth inlining (then it goes in as
 * a picture).
 *
 * `asFile`: the drawing is the SVG file being edited (svgSource.ts), saved back from this markup, so
 * everything another editor put there stays: Inkscape's layers and labels, Sodipodi's and TextExt's
 * attributes, metadata, titles, comments, foreign content, the ids as they are, the root's class and
 * style. Only what could run (scripts, frames, handlers) and links out of the file still go.
 */
export const SVG_FILE_LIMIT = 20_000_000;
export function inlineSvgHtml(svgText: string, at: { x: number; y: number; maxW: number } | null, prefix: string, asFile = false): string | null {
  if (svgText.length > (asFile ? SVG_FILE_LIMIT : 400_000)) return null;
  const inert = inertSvgSource(svgText);
  if (!inert) return null;
  let doc: Document;
  try { doc = new DOMParser().parseFromString(inert.text, 'image/svg+xml'); } catch { return null; }
  let svg: Element = doc.documentElement;
  if (!svg || svg.localName !== 'svg' || svg.namespaceURI !== SVG_NS || doc.getElementsByTagName('parsererror').length) return null;
  // what must not be in a page
  for (const el of Array.from(svg.querySelectorAll('*'))) {
    const ln = el.localName.toLowerCase();
    if (asFile ? ['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'link', 'meta', 'base'].includes(ln) : el.namespaceURI !== SVG_NS || ['script', 'foreignobject', 'iframe', 'object', 'embed', 'metadata', 'title', 'desc'].includes(ln)) { el.remove(); continue; }
    if ((ln === 'set' || ln === 'animate') && /^(xlink:)?href$|^on/i.test(el.getAttribute('attributeName') ?? '')) { el.remove(); continue; }
  }
  const idMap = new Map<string, string>();
  for (const el of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      const pre = a.prefix ?? (n.includes(':') ? n.split(':')[0] : null);
      if (n.startsWith(inert.prefix) || n.startsWith('on') || !asFile && ((pre && !['xlink', 'xml', 'xmlns'].includes(pre)) || n.startsWith('xmlns:') && !['xmlns:xlink'].includes(n))) { el.removeAttributeNode(a); continue; }
      if (n === 'href' || n === 'xlink:href' || asFile && (n === 'src' || n === 'action' || n === 'formaction')) {
        const v = a.value.trim();
        const relativeImage = asFile && el.localName === 'image' && !/^[a-z][\w+.-]*:|^\/\//i.test(v) && !v.includes('\\');
        if (!(v.startsWith('#') || SAFE_DATA.test(v) || relativeImage || asFile && /^data:image\/svg\+xml[;,]/i.test(v) && el.localName === 'image')) el.removeAttributeNode(a);
        continue;
      }
      if (/url\(\s*['"]?\s*(?!#)/i.test(a.value) && n !== 'id') el.setAttribute(a.name, a.value.replace(/url\(\s*['"]?\s*(?!#)[^)]*\)/gi, 'none'));
    }
    const id = el.getAttribute('id');
    if (id && !asFile) { const nid = `${prefix}-${id}`; idMap.set(id, nid); el.setAttribute('id', nid); }
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
  const rootStyle = asFile ? svg.getAttribute('style') ?? '' : '';
  svg.removeAttribute('style');
  if (!asFile) svg.removeAttribute('class');
  if (at) {
    const k = w > at.maxW ? at.maxW / w : 1;
    const W = Math.max(8, w * k), H = Math.max(8, h * k);
    svg.setAttribute('style', `${rootStyle ? rootStyle + ';' : ''}position: absolute; left: ${r(at.x - W / 2)}px; top: ${r(at.y - H / 2)}px; width: ${r(W)}px; height: ${r(H)}px; overflow: visible`);
  } else svg.setAttribute('style', `${rootStyle ? rootStyle + ';' : ''}width: ${r(asFile ? w : Math.min(w, 960))}px; max-width: 100%; height: ${asFile ? r(h) + 'px' : 'auto'}`);
  // Inline HTML needs unprefixed SVG element names. Keep each sanitized
  // attribute's own namespace (notably xlink/xml), geometry and children.
  for (const el of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    if (el.namespaceURI !== SVG_NS || !el.prefix) continue;
    const plain = doc.createElementNS(SVG_NS, el.localName);
    for (const attribute of Array.from(el.attributes)) plain.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    while (el.firstChild) plain.appendChild(el.firstChild);
    el.replaceWith(plain);
    if (el === svg) svg = plain;
  }
  let out = new XMLSerializer().serializeToString(svg);
  // what the HTML parser does not need
  out = out.replace(/\sxmlns(:[\w.-]+)?="[^"]*"/g, (m, p1) => (p1 === ':xlink' ? m : ''));
  if (!asFile) out = out.replace(/<!--[\s\S]*?-->/g, '');
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

/** the guides written in the deck (guides.ts): <body>'s path and its `data-ol-guides` (the master's; null: none written), and each slide's own */
export function guidesIn(text: string): { body: Path | null; master: string | null; slides: { path: Path; own: string | null }[] } {
  const { doc } = parseSource(text);
  const html = elementChildren(doc).find(e => e.tagName === 'html');
  const body = html ? elementChildren(html).find(e => e.tagName === 'body') : undefined;
  return {
    body: body ? pathOfEl(body) : null,
    master: body ? attr(body, GUIDES_ATTR) : null,
    slides: slideElements(doc).map(el => ({ path: pathOfEl(el), own: attr(el, GUIDES_ATTR) })),
  };
}

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
 * design, nothing to delete: its title an empty placeholder ("Click to add title", decklayouts.ts),
 * its placeholders empty — or, from `blank`, the slide element alone.
 */
export function newSlideHtml(text: string, i: number, blank = false): string | null {
  const { doc, text: t } = parseSource(text);
  const ss = slideElements(doc);
  return slideDesign(t, ss, ss[i] ?? ss[ss.length - 1], blank, numberObjects(text));
}

/**
 * The slide a swipe on past slide `i` (the last) adds: its design, as newSlideHtml's — but a slide
 * with no title (a page written on by hand) gets none either, as GoodNotes adds a page of the same paper.
 */
export function nextPageHtml(text: string, i: number): string | null {
  const { doc, text: t } = parseSource(text);
  const ss = slideElements(doc);
  const s = ss[i] ?? ss[ss.length - 1];
  const titled = !!s && elementChildren(s).some(k => /^h[1-6]$/.test(k.tagName) || attr(k, PH_ATTR) === 'title');
  return slideDesign(t, ss, s, false, numberObjects(text), titled);
}

/**
 * The slides whose designs (newSlideHtml's) differ, words aside — `first` first: the layouts a new
 * slide can take, as Keynote's are the theme's (an HTML deck has no masters: its slides are its layouts).
 */
export function slideDesigns(text: string, first = 0): number[] {
  const { doc, text: t } = parseSource(text);
  const ss = slideElements(doc);
  const numbers = numberObjects(text);
  const seen = new Set<string>(), out: number[] = [];
  for (const i of [first, ...ss.keys()]) {
    const html = ss[i] ? slideDesign(t, ss, ss[i], false, numbers) : null;
    // (a page number, a date in the footer: the same design on every slide)
    const key = html?.replace(/>[^<]*</g, '><');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

function slideDesign(t: string, ss: HElement[], s: HElement | undefined, blank: boolean, numbers: Set<HElement>, title = true): string | null {
  if (!s?.sourceCodeLocation?.startTag) return null;
  const open = t.slice(s.sourceCodeLocation.startTag.startOffset, s.sourceCodeLocation.startTag.endOffset);
  const close = `</${s.tagName}>`;
  if (blank) return `${open}\n</${s.tagName}>`;
  // the slide's design, not its content: the first heading (retitled) and what recurs on another
  // slide (a logo, a bar, a page number) — not this slide's own pictures, shapes and drawings
  const kids = elementChildren(s);
  const elsewhere = new Set<string>();
  for (const o of ss) {
    if (o === s) continue;
    for (const k of elementChildren(o)) if (k.sourceCodeLocation) { const r = outerRange(k); elsewhere.add(t.slice(r.from, r.to).trim()); }
  }
  const parts: string[] = [];
  let titled = false;
  for (const k of kids) {
    if (k.tagName === 'aside' && hasClass(k, 'notes')) continue;
    if (!k.sourceCodeLocation) continue;
    const { from, to } = outerRange(k);
    const src = t.slice(from, to);
    const st = k.sourceCodeLocation.startTag!;
    const open = t.slice(st.startOffset, st.endOffset).replace(/\s(data-ol-(?:comments|ins|del|chg|was))=("[^"]*"|'[^']*')/g, '');
    // what is on every slide (the master's), the slide number: the new slide's too (deckmaster.ts renumbers it)
    if (attr(k, MASTER_ATTR) !== null || numbers.has(k)) { parts.push(src); continue; }
    const role = attr(k, PH_ATTR);
    // a placeholder: the same, empty (a title: the title's)
    if (isRole(role)) { if (role === 'title') titled = true; parts.push(`${open}</${k.tagName}>`); continue; }
    const textual = /^(h[1-6]|p|ul|ol|div|blockquote)$/.test(k.tagName) && /\S/.test(textOf(k));
    // (or marked as decoration by whoever designed the deck)
    const decor = attr(k, 'aria-hidden') === 'true' || attr(k, 'data-ol-master') !== null || /(^|\s)(decor\w*|bg|background|accent|ornament|logo|footer|bar|band|stripe|rule)(\s|$)/i.test(attr(k, 'class') ?? '');
    if (!textual) { if (elsewhere.has(src.trim()) || decor) parts.push(src); continue; }
    if (/^h[1-6]$/.test(k.tagName) && !titled) {
      titled = true;
      parts.push(`${open.replace(/^<(\w+)/, `<$1 ${PH_ATTR}="title"`)}</${k.tagName}>`);
    }
  }
  if (!titled && title) parts.unshift(`<h2 ${PH_ATTR}="title" style="position: absolute; left: 7.5%; top: 8%; width: 85%"></h2>`);
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
