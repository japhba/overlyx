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

/** the markup of an object drawn with a tool, at `rect` (slide px; a click without dragging gives it a default size) */
export function objectHtml(tool: Tool, rect: Rect, kind: DeliverableKind, scaleHint = 1): string {
  const flow = kind === 'page';
  const minW = (tool === 'text' || tool === 'formula') ? 520 * scaleHint : 240 * scaleHint;
  const w = rect.w > 8 ? rect.w : minW;
  const h = rect.h > 8 ? rect.h : (tool === 'line' || tool === 'arrow' ? 0 : tool === 'text' || tool === 'formula' ? 0 : 160 * scaleHint);
  const pos = (withH: boolean) => flow ? '' : `position: absolute; left: ${r(rect.x)}px; top: ${r(rect.y)}px; width: ${r(w)}px${withH && h ? `; height: ${r(h)}px` : ''}; `;
  switch (tool) {
    case 'text': return flow ? '<p>Text</p>' : `<p style="${pos(false)}margin: 0">Text</p>`;
    case 'formula': return flow ? '<p>\\[ e^{i\\pi} + 1 = 0 \\]</p>' : `<div style="${pos(false)}">\\[ e^{i\\pi} + 1 = 0 \\]</div>`;
    case 'rect': return `<div style="${pos(true)}${flow ? `width: ${r(w)}px; height: ${r(h || 160)}px; ` : ''}background: #2f6fde; border-radius: 8px"></div>`;
    case 'ellipse': return `<div style="${pos(true)}${flow ? `width: ${r(w)}px; height: ${r(h || 160)}px; ` : ''}background: #e8a33d; border-radius: 50%"></div>`;
    case 'line': case 'arrow': {
      // from where the drag started to where it ended: the box's corners (a click: a horizontal one)
      const W = Math.max(1, r(w)), H = Math.max(1, r(rect.h > 8 ? rect.h : 0));
      const head = tool === 'arrow' ? `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>` : '';
      return `<svg style="${flow ? '' : `position: absolute; left: ${r(rect.x)}px; top: ${r(rect.y)}px; `}width: ${W}px; height: ${Math.max(H, 1)}px; overflow: visible; color: #1d2433" viewBox="0 0 ${W} ${Math.max(H, 1)}">${head}<line x1="0" y1="${H > 1 ? 0 : 0}" x2="${W}" y2="${H > 1 ? H : 0}" stroke="currentColor" stroke-width="4"${tool === 'arrow' ? ' marker-end="url(#ah)"' : ''}/></svg>`;
    }
    default: return '';
  }
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
