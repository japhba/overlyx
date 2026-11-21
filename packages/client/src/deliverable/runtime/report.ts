/**
 * What is wrong with a page, for agents (render_page) and the editor: text overflowing its box,
 * text running off the slide, text of two objects on top of each other, text too small to read
 * at the deliverable's size, too little contrast, pictures that did not load, formulas MathJax
 * could not read, the page's script errors. Measured in the page as rendered, in CSS px relative
 * to the slide.
 */
import { slides, slideTitle, state, srcOf, isForeign, pageHtml, pathOf, sourced, wordsOf } from './env';
import { mathTypeset } from './math';
import { noOverlap, visibleInk, glyphInk, formulaInk, pictureInk, aboveText } from './overlap';
import { wrapWarning } from './layout';
import { WRAP_LINES } from '../textboxes';
import type { PageIssue, PageReport } from '../protocol';

export type { PageIssue, PageReport };

export const scriptErrors: string[] = [];
addEventListener('error', e => { if (scriptErrors.length < 20) scriptErrors.push(`${e.message}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''}`); });
addEventListener('unhandledrejection', e => { if (scriptErrors.length < 20) scriptErrors.push(`unhandled promise rejection: ${String((e as PromiseRejectionEvent).reason).slice(0, 200)}`); });

function labelOf(el: Element): string {
  // (typeset math has no text of its own: the source says what it was)
  const src = el.querySelector('mjx-container') ? srcOf.get(el) : null;
  const t = wordsOf(src ?? el);
  if (t) return `"${t.length > 48 ? t.slice(0, 45) + '…' : t}"`;
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0];
  return `<${el.localName}${cls ? '.' + cls : ''}>`;
}

const round = (n: number) => Math.round(n);

const PICTURE = 'img, picture, video, canvas, figure, .ol-crop';
/** for the Check pane: the object of the slide an issue is in, its words, what it is, the measurements */
function about(el: Element, scope: Element, n?: PageIssue['n']): Pick<PageIssue, 'path' | 'name' | 'what' | 'n'> {
  let obj: Element = el;
  if (scope !== document.body) for (let e: Element | null = el; e && e !== scope; e = e.parentElement) obj = e;
  const live = sourced(obj);
  const path = live ? pathOf(live) : null;
  const l = labelOf(el);
  return { ...(path ? { path } : {}), ...(l.startsWith('"') ? { name: l.slice(1, -1) } : {}), what: l.startsWith('"') ? 'text' : el.matches(PICTURE) || el.querySelector('img') ? 'picture' : 'object', ...(n ? { n } : {}) };
}

/**
 * How big a poster is in print: the millimetres of one of its px. A poster laid out at its printed
 * size (CSS mm or in: a long side of half a metre or more at 96 px an inch) prints as it is; a
 * smaller one is taken to be printed as an A0 (`assumed`).
 */
export function posterPrint(w: number, h: number): { mm: number; assumed: boolean } {
  const long = Math.max(w, h, 1), asLaid = 25.4 / 96;
  return long * asLaid >= 500 ? { mm: asLaid, assumed: false } : { mm: 1189 / long, assumed: true };
}
/** the smallest type that reads on a printed poster from a metre or two away (pt), the fewest pixels an inch a picture needs there */
export const POSTER_MIN_PT = 18, POSTER_MIN_DPI = 100;

/** math another tool typeset (KaTeX, MathJax's own, MathML): a formula, measured as one — not its parts as text */
const OTHER_MATH = '.katex, .MathJax, .MathJax_Display, .MathJax_Preview, mjx-assistive-mml, math';
/** text that shows nothing (zero-width spaces, joiners: the struts of typeset math) */
const INVISIBLE = /^[\s\u200b-\u200d\u2060\ufeff]*$/;
const forScreenReaders = new Map<Element, boolean>();
/**
 * In a box of a pixel or less that hides what overflows it (or clips it): there for screen readers
 * only — KaTeX's copy of a formula as MathML, `.sr-only` / `.visually-hidden` text.
 */
function screenReaderOnly(el: Element | null): boolean {
  if (!el || el === document.body || el === document.documentElement) return false;
  let v = forScreenReaders.get(el);
  if (v === undefined) {
    const r = el.getBoundingClientRect();
    let hidden = false;
    if (r.width <= 1 || r.height <= 1) {
      const c = getComputedStyle(el);
      hidden = c.overflow !== 'visible' || c.clip !== 'auto' || c.clipPath !== 'none';
    }
    v = hidden || screenReaderOnly(el.parentElement);
    forScreenReaders.set(el, v);
  }
  return v;
}
/** text to check: shown, and the page's own (not a formula's inside) */
const skipText = (p: Element) => screenReaderOnly(p) || !!p.closest(OTHER_MATH);

/** the rects of an element's text (each line of each text node) */
function textRects(el: Element, limit = 300, ink = false): DOMRect[] {
  const out: DOMRect[] = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  for (let n = w.nextNode(); n && out.length < limit; n = w.nextNode()) {
    if (INVISIBLE.test(n.nodeValue ?? '')) continue;
    const p = n.parentElement;
    if (!p || isForeign(p) || p.closest('[data-ol-runtime], .notes, script, style') || skipText(p)) continue;
    if (ink && (noOverlap(p) || !visibleInk(p))) continue;
    if (ink) {
      // Each glyph separately: whitespace between words and hidden inline spans paint no ink.
      const glyph = glyphInk(p);
      let i = 0;
      for (const ch of n.nodeValue ?? '') {
        const start = i; i += ch.length;
        if (INVISIBLE.test(ch)) continue;
        r.setStart(n, start); r.setEnd(n, i);
        for (const x of Array.from(r.getClientRects())) if (x.width > 0.5 && x.height > 0.5) out.push(glyph(ch, x));
        if (out.length >= limit) break;
      }
    } else {
      r.selectNodeContents(n);
      for (const x of Array.from(r.getClientRects())) if (x.width > 0.5 && x.height > 0.5) out.push(x);
    }
  }
  // typeset formulas count as text
  for (const m of Array.from(el.querySelectorAll(`mjx-container, ${OTHER_MATH}`))) {
    if (m.parentElement?.closest(`mjx-container, ${OTHER_MATH}`) || screenReaderOnly(m)) continue;
    if (ink) {
      if (noOverlap(m) || !visibleInk(m)) continue;
      const glyphs = formulaInk(m);
      if (m.querySelector('svg')) { out.push(...glyphs); continue; }
    }
    const x = m.getBoundingClientRect();
    if (x.width > 0.5) out.push(x);
  }
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
const PAGE_SKIP = new Set(['script', 'style', 'link', 'meta', 'template', 'noscript']);

function checkScope(scope: Element, frame: DOMRect, kind: 'deck' | 'poster' | 'page'): PageIssue[] {
  const issues: PageIssue[] = [];
  // (in the document's coordinates: the contrast check scrolls the page)
  const fx = frame.left + scrollX, fy = frame.top + scrollY;
  const rel = (r: DOMRect) => ({ x: round(r.left + scrollX - fx), y: round(r.top + scrollY - fy), w: round(r.width), h: round(r.height) });
  const all = Array.from(scope.querySelectorAll('*')).filter(e => !isForeign(e) && !e.closest('[data-ol-runtime], .notes, mjx-container, script, style, template, svg, head') && !skipText(e));

  if (kind !== 'page') for (const e of all) {
    if (!e.hasAttribute(WRAP_LINES)) continue;
    const lines = wrapWarning(e);
    if (lines) issues.push({ kind: 'wrap', text: `${labelOf(e)} wraps to ${lines} lines (was ${e.getAttribute(WRAP_LINES)} when resized)`, at: rel(e.getBoundingClientRect()), ...about(e, scope, { lines, was: Number(e.getAttribute(WRAP_LINES)) || 0 }) });
  }

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
    issues.push({ kind: 'overflow', text: `${labelOf(e)} needs ${dy ? `${dy}px more height` : ''}${dy && dx ? ' and ' : ''}${dx ? `${dx}px more width` : ''} than its box${getComputedStyle(e).overflow === 'hidden' ? ' (cut off)' : ' (spills out)'}`, at: rel(e.getBoundingClientRect()), ...about(e, scope, { dy, dx, cut: getComputedStyle(e).overflow === 'hidden' }) });
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
      if (out.length) issues.push({ kind: 'offpage', text: `text of ${labelOf(c)} runs past the slide's ${out.join(', ')}`, at: rel(new DOMRect(l, t, r - l, b - t)), ...about(c, scope, { sides: out.map(o => o.split(' ')[0]).join(' ') }) });
    }
    // text of two objects on top of each other
    const texts = tops.filter(c => !noOverlap(c)).map(c => ({ c, rs: textRects(c, 4000, true) })).filter(x => x.rs.length);
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.c.contains(b.c) || b.c.contains(a.c)) continue;
      const clash = a.rs.find(x => b.rs.some(y => hit(x, y, 2)));
      if (clash) issues.push({ kind: 'overlap', text: `text of ${labelOf(a.c)} and ${labelOf(b.c)} overlap`, at: rel(clash), ...about(a.c, scope, { other: labelOf(b.c) }) });
    }
    // a picture that overlaps text it does not belong to
    const pics = tops.filter(c => c.matches('img, svg, video, canvas, picture, figure') || (c.querySelector('img, svg:not(mjx-container svg), canvas') && !(c.textContent ?? '').trim()));
    for (const p of pics) {
      if (noOverlap(p)) continue;
      const paints = pictureInk(p);
      for (const t of texts) {
        if (t.c === p || t.c.contains(p) || p.contains(t.c) || !aboveText(p, t.c)) continue;
        const clash = t.rs.find(paints);
        if (clash) { issues.push({ kind: 'overlap', text: `${labelOf(p)} covers part of the text of ${labelOf(t.c)}`, at: rel(clash), ...about(p, scope, { other: labelOf(t.c), covers: true }) }); break; }
      }
    }
    // an object that lies outside the slide (it does not show), a picture the slide's edge cuts a good part off
    const what = kind === 'poster' ? 'poster' : 'slide';
    for (const c of tops) {
      if (PAGE_SKIP.has(c.localName) || c.closest('[data-ol-lint~="no-edge"]')) continue;
      const r = c.getBoundingClientRect();
      if (!(r.width > 1 && r.height > 1)) continue;
      const iw = Math.min(r.right, frame.right) - Math.max(r.left, frame.left), ih = Math.min(r.bottom, frame.bottom) - Math.max(r.top, frame.top);
      if (iw <= 1 || ih <= 1) { issues.push({ kind: 'off-slide', text: `${labelOf(c)} lies outside the ${what}: it does not show`, at: rel(r), ...about(c, scope, { all: true }) }); continue; }
      if (!c.matches(PICTURE) && !(c.querySelector('img, video, canvas') && !(c.textContent ?? '').trim())) continue;
      const cut = 1 - (iw * ih) / (r.width * r.height);
      if (cut < 0.05) continue;
      const sides = [r.left < frame.left - 2 ? 'left' : '', r.top < frame.top - 2 ? 'top' : '', r.right > frame.right + 2 ? 'right' : '', r.bottom > frame.bottom + 2 ? 'bottom' : ''].filter(Boolean);
      issues.push({ kind: 'off-slide', text: `${labelOf(c)}: the ${what}'s ${sides.join(' and ')} edge cuts ${round(cut * 100)}% of the picture off`, at: rel(r), ...about(c, scope, { sides: sides.join(' '), cut: round(cut * 100) }) });
    }
  }

  // text too small for the deliverable, and too little contrast
  // (a poster: by its printed size — POSTER_MIN_PT on the board, whatever px it is laid out in)
  const print = posterPrint(frame.width, frame.height), ptOf = (px: number) => px * print.mm * 72 / 25.4;
  const minPx = kind === 'deck' ? Math.max(14, frame.height * 0.022) : kind === 'poster' ? POSTER_MIN_PT / ptOf(1) : 12;
  const seenSmall = new Set<Element>(), seenContrast = new Set<Element>();
  const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (INVISIBLE.test(n.nodeValue ?? '')) continue;
    const p = n.parentElement;
    if (!p || p.closest('[data-ol-runtime], .notes, mjx-container, script, style, template, head') || isForeign(p) || skipText(p)) continue;
    const c = getComputedStyle(p);
    if (c.visibility === 'hidden' || c.display === 'none' || !(p as HTMLElement).offsetParent && c.position !== 'fixed') continue;
    const fs = parseFloat(c.fontSize);
    if (fs < minPx - 0.5 && !seenSmall.has(p) && seenSmall.size < 12) {
      seenSmall.add(p);
      issues.push({ kind: 'small-text', text: kind === 'poster'
        ? `${labelOf(p)} is ${round(fs)}px: ${round(ptOf(fs))} pt in print${print.assumed ? ' (as an A0)' : ''} — below ${POSTER_MIN_PT} pt (~${round(minPx)}px), hard to read on a printed poster from a metre away`
        : `${labelOf(p)} is ${round(fs)}px — below ~${round(minPx)}px, hard to read ${kind === 'deck' ? 'on a projected slide' : 'on screen'}`,
        at: rel(p.getBoundingClientRect()), ...about(p, scope, { px: round(fs), min: Math.ceil(minPx), ...(kind === 'poster' ? { pt: round(ptOf(fs)), minPt: POSTER_MIN_PT, assumed: print.assumed } : {}) }) });
    }
    const fg = parseColor(c.color);
    const bg = backgroundOf(p);
    if (fg && bg && fg[3] > 0.5 && !seenContrast.has(p) && seenContrast.size < 12) {
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const need = kind === 'page' && fs < 24 ? 4.5 : 3;
      if (ratio < need) { seenContrast.add(p); issues.push({ kind: 'contrast', text: `${labelOf(p)}: contrast ${ratio.toFixed(1)}:1 against its background (want ${need}:1)`, at: rel(p.getBoundingClientRect()), ...about(p, scope, { ratio: Math.round(ratio * 10) / 10, need }) }); }
    }
  }

  for (const img of Array.from(scope.querySelectorAll('img')) as HTMLImageElement[]) {
    const file = (srcOf.get(img) ?? img).getAttribute('src') ?? '';
    if (img.complete && img.naturalWidth === 0) issues.push({ kind: 'image', text: `the picture ${img.getAttribute('src') ?? ''} did not load`, at: rel(img.getBoundingClientRect()), ...about(img, scope, { src: /^data:/i.test(file) ? '' : file.split('/').pop() ?? '' }) });
    // a poster's picture with too few pixels for the size it is printed at (drawings — SVG — have none to run out of)
    if (kind !== 'poster' || !img.naturalWidth || /\.svg([?#]|$)|^data:image\/svg/i.test(file)) continue;
    const box = img.getBoundingClientRect(), inches = box.width * print.mm / 25.4;
    if (inches < 1.2) continue;
    const dpi = img.naturalWidth / inches;
    if (dpi >= POSTER_MIN_DPI) continue;
    const need = Math.ceil(inches * 150 / 100) * 100;
    issues.push({ kind: 'low-res', text: `the picture ${/^data:/i.test(file) ? '' : file + ' '}has ${img.naturalWidth}×${img.naturalHeight} px for ${round(inches * 2.54)} cm in print${print.assumed ? ' (as an A0)' : ''}: ${round(dpi)} px an inch, it will look blurred — use one at least ${need} px wide, or show it smaller`,
      at: rel(box), ...about(img, scope, { w: img.naturalWidth, h: img.naturalHeight, cm: round(inches * 2.54), dpi: round(dpi), need, assumed: print.assumed }) });
  }
  for (const m of Array.from(scope.querySelectorAll('mjx-merror, [data-mjx-error], [data-mml-node="merror"]'))) {
    if (m.parentElement?.closest('[data-mjx-error], [data-mml-node="merror"]')) continue;
    issues.push({ kind: 'math', text: `a formula did not typeset: ${(m.getAttribute('data-mjx-error') ?? m.getAttribute('title') ?? m.textContent ?? '').slice(0, 120)}`, at: rel(m.getBoundingClientRect()), ...about(m, scope, { why: (m.getAttribute('data-mjx-error') ?? m.getAttribute('title') ?? '').slice(0, 120) }) });
  }
  // citations of keys no .bib file of the project has (shown as ?, as LaTeX does: cite.ts)
  for (const c of Array.from(scope.querySelectorAll('ol-cite[data-ol-missing]'))) {
    issues.push({ kind: 'citation', text: `${c.getAttribute('data-ol-cite')} cites ${c.getAttribute('data-ol-missing')}, which no .bib file of the project has — add the entry (or fix the key)`, at: rel(c.getBoundingClientRect()), ...about(c, scope, { key: c.getAttribute('data-ol-missing') ?? '' }) });
  }
  // references to labels no equation has (MathJax shows ???)
  {
    // (the slide's text as written: its references are typeset away on the page)
    const own = srcOf.get(scope)?.outerHTML ?? (scope === document.body ? raw.html : raw.slides.get(scope) ?? '');
    const labels = new Set([...(pageHtml() || raw.html).matchAll(/\\label\{([^}]+)\}/g)].map(m => m[1].trim()));
    for (const m of own.matchAll(/\\(?:eq)?ref\{([^}]+)\}/g)) {
      if (labels.has(m[1].trim())) continue;
      issues.push({ kind: 'reference', text: `${m[0]} refers to no equation: no \\label{${m[1].trim()}} on the page`, n: { ref: m[1].trim() } });
    }
  }
  // TeX left as it was written: MathJax found no formula there (unbalanced braces, a missing delimiter)
  if (mathTypeset()) {
    const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let n2 = 0;
    for (let n = tw.nextNode(); n && n2 < 6; n = tw.nextNode()) {
      const v = n.nodeValue ?? '';
      const p = n.parentElement;
      if (!p || p.closest('script, style, code, pre, textarea, [data-ol-runtime], .ol-notex, .notes') || skipText(p)) continue;
      const m = /\\\(|\\\[|\$\$/.exec(v);
      if (!m) continue;
      n2++;
      issues.push({ kind: 'math', text: `TeX shown as written, not typeset: "${v.slice(m.index, m.index + 60).trim()}" — check its braces and delimiters`, at: rel(p.getBoundingClientRect()), ...about(p, scope, { raw: v.slice(m.index, m.index + 60).trim() }) });
    }
  }
  return issues;
}

/** the page as served, before its TeX was typeset (references are checked against it where no source came: render_page) */
const raw = { html: '', slides: new WeakMap<Element, string>() };
export function rememberPage(): void {
  raw.html = document.documentElement.outerHTML;
  for (const s of slides()) raw.slides.set(s, s.outerHTML);
}

export function report(): { kind: 'deck' | 'poster' | 'page'; width: number; height: number; pages: PageReport[]; errors: string[] } {
  const sx = scrollX, sy = scrollY;
  try { return reportAll(); } finally { scrollTo(sx, sy); }
}

function reportAll(): { kind: 'deck' | 'poster' | 'page'; width: number; height: number; pages: PageReport[]; errors: string[] } {
  forScreenReaders.clear();
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
