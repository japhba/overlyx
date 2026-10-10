/**
 * What is wrong with a page, for agents (render_page) and the editor: text overflowing its box,
 * text running off the slide, text of two objects on top of each other, text too small to read
 * at the deliverable's size, too little contrast, pictures that did not load, formulas MathJax
 * could not read, the page's script errors. Measured in the page as rendered, in CSS px relative
 * to the slide.
 */
import { slides, slideTitle, state, srcOf, isForeign } from './env';
import { mathTypeset } from './math';

export interface PageIssue { kind: 'overflow' | 'offpage' | 'overlap' | 'small-text' | 'contrast' | 'image' | 'math'; text: string; at?: { x: number; y: number; w: number; h: number } }
export interface PageReport { index: number; title: string; issues: PageIssue[] }

export const scriptErrors: string[] = [];
addEventListener('error', e => { if (scriptErrors.length < 20) scriptErrors.push(`${e.message}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''}`); });
addEventListener('unhandledrejection', e => { if (scriptErrors.length < 20) scriptErrors.push(`unhandled promise rejection: ${String((e as PromiseRejectionEvent).reason).slice(0, 200)}`); });

function labelOf(el: Element): string {
  // (typeset math has no text of its own: the source says what it was)
  const src = el.querySelector('mjx-container') ? srcOf.get(el) : null;
  const t = ((src ?? el).textContent ?? '').replace(/\s+/g, ' ').trim();
  if (t) return `"${t.length > 48 ? t.slice(0, 45) + '…' : t}"`;
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0];
  return `<${el.localName}${cls ? '.' + cls : ''}>`;
}

const round = (n: number) => Math.round(n);

/** the rects of an element's text (each line of each text node) */
function textRects(el: Element, limit = 300): DOMRect[] {
  const out: DOMRect[] = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  for (let n = w.nextNode(); n && out.length < limit; n = w.nextNode()) {
    if (!(n.nodeValue ?? '').trim()) continue;
    const p = n.parentElement;
    if (!p || isForeign(p) || p.closest('[data-ol-runtime], .notes, script, style')) continue;
    r.selectNodeContents(n);
    for (const x of Array.from(r.getClientRects())) if (x.width > 0.5 && x.height > 0.5) out.push(x);
  }
  // typeset formulas count as text
  for (const m of Array.from(el.querySelectorAll('mjx-container'))) { const x = m.getBoundingClientRect(); if (x.width > 0.5) out.push(x); }
  return out;
}

const hit = (a: DOMRect, b: DOMRect, pad = 1) => a.left < b.right - pad && b.left < a.right - pad && a.top < b.bottom - pad && b.top < a.bottom - pad;

function parseColor(c: string): [number, number, number, number] | null {
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}
function lum([r, g, b]: number[]): number {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/**
 * The colour behind an element's text, when it is a plain colour (null: an image, a gradient, a
 * picture): whatever lies under the text's middle, in the stacking order — a shape placed behind the
 * text counts, not only the text's ancestors.
 */
function backgroundOf(el: Element): [number, number, number] | null {
  const r = el.getBoundingClientRect();
  let x = r.left + Math.min(r.width / 2, 20), y = r.top + r.height / 2;
  if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) {
    scrollBy(x < 0 || x > innerWidth ? x - innerWidth / 2 : 0, y < 0 || y > innerHeight ? y - innerHeight / 2 : 0);
    const r2 = el.getBoundingClientRect();
    x = r2.left + Math.min(r2.width / 2, 20); y = r2.top + r2.height / 2;
  }
  const stack = document.elementsFromPoint(x, y).filter(e => !isForeign(e) && !e.closest('[data-ol-runtime]'));
  // from the text down: its own element first, then what is painted under it
  const start = stack.indexOf(el);
  for (const e of stack.slice(start >= 0 ? start : 0)) {
    if (REPLACED_BG.has(e.localName)) return null;
    const c = getComputedStyle(e);
    if (c.backgroundImage && c.backgroundImage !== 'none') return null;
    const bg = parseColor(c.backgroundColor);
    if (bg && bg[3] > 0.9) return [bg[0], bg[1], bg[2]];
    if (bg && bg[3] > 0.1) return null;
  }
  return [255, 255, 255];
}
const REPLACED_BG = new Set(['img', 'svg', 'video', 'canvas', 'picture', 'iframe']);

function checkScope(scope: Element, frame: DOMRect, kind: 'deck' | 'poster' | 'page'): PageIssue[] {
  const issues: PageIssue[] = [];
  // (in the document's coordinates: the contrast check scrolls the page)
  const fx = frame.left + scrollX, fy = frame.top + scrollY;
  const rel = (r: DOMRect) => ({ x: round(r.left + scrollX - fx), y: round(r.top + scrollY - fy), w: round(r.width), h: round(r.height) });
  const all = Array.from(scope.querySelectorAll('*')).filter(e => !isForeign(e) && !e.closest('[data-ol-runtime], .notes, mjx-container, script, style, template, svg, head'));

  // text overflowing its box: a box whose content needs more room than it was given (measured by
  // letting it take its natural size for a moment — glyphs reaching past a line box are no overflow)
  const over: { e: Element; dy: number; dx: number }[] = [];
  for (const e of all) {
    const h = e as HTMLElement;
    if (!(h.clientHeight > 0) || !(e.textContent ?? '').trim()) continue;
    if (!(h.scrollHeight > h.clientHeight + 3 || h.scrollWidth > h.clientWidth + 3)) continue;
    const c = getComputedStyle(e);
    if (/(auto|scroll)/.test(c.overflowY + c.overflowX)) continue;
    const st = h.style;
    const saved = [st.getPropertyValue('height'), st.getPropertyPriority('height'), st.getPropertyValue('max-height'), st.getPropertyPriority('max-height')];
    const before = h.getBoundingClientRect().height;
    st.setProperty('height', 'auto', 'important');
    st.setProperty('max-height', 'none', 'important');
    const natural = h.getBoundingClientRect().height;
    st.setProperty('height', saved[0], saved[1]);
    st.setProperty('max-height', saved[2], saved[3]);
    if (!st.getPropertyValue('height')) st.removeProperty('height');
    if (!st.getPropertyValue('max-height')) st.removeProperty('max-height');
    const dy = Math.round(natural - before);
    // wider than its box: a word or formula that does not fit (not a glyph's overhang)
    let dx = 0;
    if (h.scrollWidth > h.clientWidth + 6) {
      const rs = textRects(e, 200);
      const box = h.getBoundingClientRect();
      for (const x of rs) dx = Math.max(dx, Math.round(x.right - box.right), Math.round(box.left - x.left));
    }
    if (dy > 4 || dx > 6) over.push({ e, dy: dy > 4 ? dy : 0, dx: dx > 6 ? dx : 0 });
  }
  for (const { e, dy, dx } of over) {
    if (over.some(o => o.e !== e && e.contains(o.e))) continue;
    issues.push({ kind: 'overflow', text: `${labelOf(e)} needs ${dy ? `${dy}px more height` : ''}${dy && dx ? ' and ' : ''}${dx ? `${dx}px more width` : ''} than its box${getComputedStyle(e).overflow === 'hidden' ? ' (cut off)' : ' (spills out)'}`, at: rel(e.getBoundingClientRect()) });
    if (issues.length > 40) break;
  }

  if (kind !== 'page') {
    // text past the slide's edges
    const tops = Array.from(scope.children).filter(c => !isForeign(c) && !c.classList.contains('notes'));
    for (const c of tops) {
      const rs = textRects(c, 400);
      if (!rs.length) continue;
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const x of rs) { l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom); }
      const out: string[] = [];
      if (l < frame.left - 2) out.push(`left by ${round(frame.left - l)}px`);
      if (t < frame.top - 2) out.push(`top by ${round(frame.top - t)}px`);
      if (r > frame.right + 2) out.push(`right by ${round(r - frame.right)}px`);
      if (b > frame.bottom + 2) out.push(`bottom by ${round(b - frame.bottom)}px`);
      if (out.length) issues.push({ kind: 'offpage', text: `text of ${labelOf(c)} runs past the slide's ${out.join(', ')}`, at: rel(new DOMRect(l, t, r - l, b - t)) });
    }
    // text of two objects on top of each other
    const texts = tops.map(c => ({ c, rs: textRects(c, 200) })).filter(x => x.rs.length);
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.c.contains(b.c) || b.c.contains(a.c)) continue;
      const clash = a.rs.find(x => b.rs.some(y => hit(x, y, 2)));
      if (clash) issues.push({ kind: 'overlap', text: `text of ${labelOf(a.c)} and ${labelOf(b.c)} overlap`, at: rel(clash) });
    }
    // a picture that overlaps text it does not belong to
    const pics = tops.filter(c => c.matches('img, svg, video, canvas, picture, figure') || (c.querySelector('img, svg:not(mjx-container svg), canvas') && !(c.textContent ?? '').trim()));
    for (const p of pics) {
      const pr = p.getBoundingClientRect();
      for (const t of texts) {
        if (t.c === p || t.c.contains(p) || p.contains(t.c)) continue;
        const clash = t.rs.find(x => hit(x, pr, 2));
        if (clash) { issues.push({ kind: 'overlap', text: `${labelOf(p)} covers part of the text of ${labelOf(t.c)}`, at: rel(clash) }); break; }
      }
    }
  }

  // text too small for the deliverable, and too little contrast
  const minPx = kind === 'deck' ? Math.max(14, frame.height * 0.022) : kind === 'poster' ? Math.max(20, frame.height * 0.0055) : 12;
  const seenSmall = new Set<Element>(), seenContrast = new Set<Element>();
  const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!(n.nodeValue ?? '').trim()) continue;
    const p = n.parentElement;
    if (!p || p.closest('[data-ol-runtime], .notes, mjx-container, script, style, template, head') || isForeign(p)) continue;
    const c = getComputedStyle(p);
    if (c.visibility === 'hidden' || c.display === 'none' || !(p as HTMLElement).offsetParent && c.position !== 'fixed') continue;
    const fs = parseFloat(c.fontSize);
    if (fs < minPx - 0.5 && !seenSmall.has(p) && seenSmall.size < 12) {
      seenSmall.add(p);
      issues.push({ kind: 'small-text', text: `${labelOf(p)} is ${round(fs)}px — below ~${round(minPx)}px, hard to read ${kind === 'deck' ? 'on a projected slide' : kind === 'poster' ? 'on a printed poster' : 'on screen'}`, at: rel(p.getBoundingClientRect()) });
    }
    const fg = parseColor(c.color);
    const bg = backgroundOf(p);
    if (fg && bg && fg[3] > 0.5 && !seenContrast.has(p) && seenContrast.size < 12) {
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const need = kind === 'page' && fs < 24 ? 4.5 : 3;
      if (ratio < need) { seenContrast.add(p); issues.push({ kind: 'contrast', text: `${labelOf(p)}: contrast ${ratio.toFixed(1)}:1 against its background (want ${need}:1)`, at: rel(p.getBoundingClientRect()) }); }
    }
  }

  for (const img of Array.from(scope.querySelectorAll('img')) as HTMLImageElement[]) {
    if (img.complete && img.naturalWidth === 0) issues.push({ kind: 'image', text: `the picture ${img.getAttribute('src') ?? ''} did not load`, at: rel(img.getBoundingClientRect()) });
  }
  for (const m of Array.from(scope.querySelectorAll('mjx-merror, [data-mjx-error], [data-mml-node="merror"]'))) {
    if (m.parentElement?.closest('[data-mjx-error], [data-mml-node="merror"]')) continue;
    issues.push({ kind: 'math', text: `a formula did not typeset: ${(m.getAttribute('data-mjx-error') ?? m.getAttribute('title') ?? m.textContent ?? '').slice(0, 120)}`, at: rel(m.getBoundingClientRect()) });
  }
  // TeX left as it was written: MathJax found no formula there (unbalanced braces, a missing delimiter)
  if (mathTypeset()) {
    const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let n2 = 0;
    for (let n = tw.nextNode(); n && n2 < 6; n = tw.nextNode()) {
      const v = n.nodeValue ?? '';
      const p = n.parentElement;
      if (!p || p.closest('script, style, code, pre, textarea, [data-ol-runtime], .ol-notex, .notes')) continue;
      const m = /\\\(|\\\[|\$\$/.exec(v);
      if (!m) continue;
      n2++;
      issues.push({ kind: 'math', text: `TeX shown as written, not typeset: "${v.slice(m.index, m.index + 60).trim()}" — check its braces and delimiters`, at: rel(p.getBoundingClientRect()) });
    }
  }
  return issues;
}

export function report(): { kind: 'deck' | 'poster' | 'page'; width: number; height: number; pages: PageReport[]; errors: string[] } {
  const sx = scrollX, sy = scrollY;
  try { return reportAll(); } finally { scrollTo(sx, sy); }
}

function reportAll(): { kind: 'deck' | 'poster' | 'page'; width: number; height: number; pages: PageReport[]; errors: string[] } {
  const kind = state.kind;
  const ss = slides();
  if (kind === 'page' || !ss.length) {
    const frame = new DOMRect(0, -scrollY, document.documentElement.clientWidth, document.documentElement.scrollHeight);
    return { kind: 'page', width: document.documentElement.clientWidth, height: document.documentElement.scrollHeight, pages: [{ index: 0, title: document.title, issues: checkScope(document.body, frame, 'page') }], errors: scriptErrors.slice() };
  }
  const pages = ss.map((s, i) => ({ index: i, title: slideTitle(s), issues: checkScope(s, s.getBoundingClientRect(), kind) }));
  const first = ss[0];
  void srcOf;
  return { kind, width: first.offsetWidth, height: first.offsetHeight, pages, errors: scriptErrors.slice() };
}
