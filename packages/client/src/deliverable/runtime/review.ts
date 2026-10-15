/**
 * Review on the canvas (core html/review.ts keeps it in the page's text): suggestions drawn in their
 * author's colour — words typed underlined, deleted struck through, objects added, deleted (faded)
 * or changed framed, the selected changed object's original shown faintly where it was —, comment
 * pins on what was commented on, and the words of a thread highlighted. While suggesting, a deletion
 * in the text being retyped strikes the words through at once and what is typed is underlined (the
 * editor turns the result into the marks when it is committed, so this is only how it looks meanwhile).
 *
 * In every other mode (presenting, the PDF, agents' renders, a page opened by a link) the page shows
 * with the suggestions accepted: what was deleted is hidden, what was added plain.
 */
import type { FromRuntime, Path, ReviewView } from '../protocol';
import { MODE, post, pathOf, slides, slideOf, docRect } from './env';
import { parseThreads, parseWas, parseStamp, stampOf, reviewHue, COMMENTS, INS, DEL, CHG, WAS, BY } from '@overlyx/core/html/review.ts';

let view: ReviewView = { ins: true, del: true, suggesting: false, me: '', focus: null };
let authorCss: HTMLStyleElement | null = null;
const authorsStyled = new Set<string>();

const color = (name: string, l = 42) => `hsl(${reviewHue(name)} 68% ${l}%)`;
const cssStr = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';

/** the review's styles, in every mode */
export function installReviewCss(): void {
  const s = document.createElement('style');
  s.setAttribute('data-ol-runtime', '');
  s.textContent = MODE === 'edit'
    ? `ins[${BY}] { text-decoration: underline calc(0.06em + 1px) var(--ol-who, #1a7f37) !important; text-underline-offset: .12em; color: var(--ol-who, #1a7f37) !important; background: none; }
      del[${BY}] { text-decoration: line-through calc(0.05em + 1px) var(--ol-who, #c4312a) !important; color: var(--ol-who, #c4312a) !important; opacity: .85; }
      html.ol-edit [${DEL}] { opacity: .38 !important; }
      html.ol-rev-noins [${INS}], html.ol-rev-noins ins[${BY}] { display: none !important; }
      html.ol-rev-nodel [${DEL}], html.ol-rev-nodel del[${BY}] { display: none !important; }
      ::highlight(ol-quote) { background-color: rgba(255, 196, 0, .45); }`
    // (the rail shows the slides as they are, deleted ones faded; elsewhere the page as it reads with the suggestions accepted)
    : MODE === 'thumb'
      ? `del[${BY}], [${DEL}]:not(.slide) { display: none !important; } ins[${BY}] { text-decoration: none !important; } .slide[${DEL}] { opacity: .4 !important; }`
      : `del[${BY}], [${DEL}] { display: none !important; } ins[${BY}] { text-decoration: none !important; }`;
  (document.head ?? document.documentElement).appendChild(s);
  if (MODE === 'edit') styleAuthors();
}

/** each author's marks in their colour (attribute selectors on the stamps' names) */
export function styleAuthors(): void {
  if (MODE !== 'edit') return;
  const names = new Set<string>();
  for (const el of Array.from(document.querySelectorAll(`[${BY}]`))) { const s = parseStamp(el.getAttribute(BY)); if (s) names.add(s.by); }
  let added = false;
  for (const n of names) if (!authorsStyled.has(n)) { authorsStyled.add(n); added = true; }
  if (!added) return;
  if (!authorCss) {
    authorCss = document.createElement('style');
    authorCss.setAttribute('data-ol-runtime', '');
    document.head.appendChild(authorCss);
  }
  authorCss.textContent = [...authorsStyled].map(n => `[${BY}^=${cssStr(n + '|')}] { --ol-who: ${color(n)}; }`).join('\n');
}

export function setReview(v: ReviewView): void {
  view = v;
  const h = document.documentElement.classList;
  h.toggle('ol-rev-noins', !v.ins);
  h.toggle('ol-rev-nodel', !v.del);
  highlightQuote();
}

export function reviewView(): ReviewView { return view; }

/* ------------------------------------------------------------------ the quote of the thread looked at */

function highlightQuote(): void {
  const hl = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const HL = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!hl || !HL) return;
  hl.delete('ol-quote');
  const f = view.focus;
  if (!f?.quote) return;
  const el = liveAtPath(f.path);
  if (!el) return;
  const r = findText(el, f.quote);
  if (r) hl.set('ol-quote', new HL(r));
}

let liveAtPath: (p: Path) => Element | null = () => null;
export function setLiveAt(f: (p: Path) => Element | null): void { liveAtPath = f; }

/** the first place `quote` is in the element's text (white space loosely), as a range */
function findText(root: Element, quote: string): Range | null {
  const q = quote.replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const nodes: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n as Text);
  let flat = '';
  const map: [Text, number][] = [];
  for (const t of nodes) for (let i = 0; i < t.data.length; i++) {
    const c = /\s/.test(t.data[i]) ? ' ' : t.data[i];
    if (c === ' ' && flat.endsWith(' ')) continue;
    flat += c; map.push([t, i]);
  }
  const at = flat.indexOf(q);
  if (at < 0) return null;
  const r = document.createRange();
  const [sn, so] = map[at], [en, eo] = map[at + q.length - 1];
  r.setStart(sn, so);
  r.setEnd(en, eo + 1);
  return r;
}

/* ------------------------------------------------------------------ the overlay: marks and pins */

export const REVIEW_OVERLAY_CSS = `.rv { position: absolute; box-sizing: border-box; pointer-events: none; border: calc(2px * var(--s)) solid var(--c); border-radius: calc(3px * var(--s)); transform-origin: 50% 50%; }
    .rv.chg { border-style: dashed; }
    .rv.txt { border-style: dotted; border-width: calc(1.5px * var(--s)); opacity: .8; }
    .rv.del { border-color: #d2453c; background: repeating-linear-gradient(135deg, rgba(210,69,60,.14) 0 calc(5px * var(--s)), transparent 0 calc(11px * var(--s))); }
    .rv-tag { position: absolute; transform: translateY(calc(4px * var(--s))); color: #fff; background: var(--c); padding: calc(1px * var(--s)) calc(6px * var(--s)); border-radius: calc(3px * var(--s)); white-space: nowrap; pointer-events: none; font: 600 calc(10.5px * var(--s)) / 1.35 system-ui, -apple-system, sans-serif; }
    .rv-tag.del { background: #d2453c; }
    .pin { position: absolute; transform: translate(calc(8px * var(--s)), -80%); display: flex; align-items: center; gap: calc(2px * var(--s)); min-width: calc(22px * var(--s)); height: calc(22px * var(--s)); padding: 0 calc(5px * var(--s)); box-sizing: border-box;
      background: #f6b400; color: #3a2a00; border-radius: calc(11px * var(--s)) calc(11px * var(--s)) calc(11px * var(--s)) calc(3px * var(--s)); box-shadow: 0 calc(1px * var(--s)) calc(3px * var(--s)) rgba(0,0,0,.3), 0 0 0 calc(1.5px * var(--s)) #fff;
      font: 700 calc(11px * var(--s)) / 1 system-ui, -apple-system, sans-serif; pointer-events: auto; cursor: pointer; touch-action: none; }
    .pin.inside { transform: translate(-100%, 0); }
    .pin svg { width: calc(12px * var(--s)); height: calc(12px * var(--s)); }
    .pin.focus { background: #2f6fde; color: #fff; }
    .rv-ghost-tag { position: absolute; transform: translateY(-100%); color: #5f6673; font: 600 calc(10px * var(--s)) system-ui, sans-serif; pointer-events: none; white-space: nowrap; }`;

const BUBBLE = '<svg viewBox="0 0 16 16"><path d="M2 2.5h12v8.5H6.5L2 14z" fill="currentColor"/></svg>';
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** the elements a pin stands for (index = data-pin) */
let pinEls: Element[] = [];

interface Corners { x0: number; y0: number; x1: number; y1: number }
type BoxFn = (el: Element) => { cx: number; cy: number; w: number; h: number; a: number };

const MARK_SEL = `[${INS}], [${DEL}], [${CHG}]`;

/**
 * The review's part of the canvas overlay: frames around the objects suggestions changed (on the
 * slide shown; on a web page all), with who did what on the hovered or selected one, and comment pins.
 */
export function reviewOverlay(scope: Element | null, box: BoxFn, active: Element[]): { under: string; pins: string } {
  if (MODE !== 'edit') return { under: '', pins: '' };
  const root = scope ?? document.body;
  if (!root) return { under: '', pins: '' };
  const parts: string[] = [];
  const pins: string[] = [];
  const frame = (el: Element, cls: string, c: string) => {
    const b = box(el);
    if (!b.w && !b.h) return null;
    parts.push(`<div class="rv ${cls}" style="--c:${c};left:${b.cx - b.w / 2}px;top:${b.cy - b.h / 2}px;width:${b.w}px;height:${b.h}px;${b.a ? `transform:rotate(${b.a}deg);` : ''}"></div>`);
    return { x0: b.cx - b.w / 2, y0: b.cy - b.h / 2, x1: b.cx + b.w / 2, y1: b.cy + b.h / 2 } as Corners;
  };
  const marked = new Set<Element>();
  const els = [root, ...Array.from(root.querySelectorAll(MARK_SEL))].filter(e => e.matches?.(MARK_SEL));
  for (const el of els) {
    if (el.closest('[data-ol-runtime]')) continue;
    const ins = el.getAttribute(INS), del = el.getAttribute(DEL), chg = el.getAttribute(CHG);
    const st = parseStamp(del ?? ins ?? chg);
    if (!st) continue;
    // a slide: framed inside its edge
    const cls = del !== null ? 'del' : ins !== null ? 'ins' : 'chg';
    const c = color(st.by);
    const corners = frame(el, cls, c);
    marked.add(el);
    if (!corners) continue;
    if (active.includes(el) || hovered === el) {
      const what = del !== null ? 'Deleted' : ins !== null ? 'Added' : 'Changed';
      parts.push(`<div class="rv-tag ${cls}" style="--c:${c};left:${corners.x0}px;top:${corners.y1}px">${what} by ${esc(st.by)}${st.at ? ` · ${esc(st.at.slice(5))}` : ''}</div>`);
    }
  }
  // objects whose words were changed: a dotted frame
  const objs = new Set<Element>();
  for (const t of Array.from(root.querySelectorAll(`ins[${BY}], del[${BY}]`))) {
    const o = objectOf(t);
    if (o && !marked.has(o) && !objs.has(o)) {
      objs.add(o);
      const st = parseStamp(t.getAttribute(BY));
      const corners = frame(o, 'txt', color(st?.by ?? ''));
      if (corners && (active.includes(o) || hovered === o) && st) parts.push(`<div class="rv-tag" style="--c:${color(st.by)};left:${corners.x0}px;top:${corners.y1}px">Text changed by ${esc(st.by)}</div>`);
    }
  }
  // comment pins (open threads)
  pinEls = [];
  const commented = [root, ...Array.from(root.querySelectorAll(`[${COMMENTS}]`))].filter(e => e.hasAttribute?.(COMMENTS) && !e.closest('[data-ol-runtime]'));
  for (const el of commented) {
    const open = parseThreads(el.getAttribute(COMMENTS)).filter(t => !t.done).length;
    if (!open) continue;
    const r = docRect(el);
    if (!r.w && !r.h) continue;
    // beside the top right corner (clear of the selection's handles); a slide's inside its own
    const isSlide = el.classList.contains('slide');
    const x = isSlide ? r.x + r.w - 40 : r.x + r.w, y = isSlide ? r.y + 34 : r.y;
    const focus = view.focus && samePath(pathOf(el), view.focus.path) ? ' focus' : '';
    pins.push(`<div class="pin${focus}${isSlide ? ' inside' : ''}" data-pin="${pinEls.length}" title="${open} comment${open > 1 ? 's' : ''} — click to read" style="left:${x}px;top:${y}px">${BUBBLE}${open > 1 ? open : ''}</div>`);
    pinEls.push(el);
  }
  return { under: parts.join(''), pins: pins.join('') };
}

let hovered: Element | null = null;
export function setReviewHover(el: Element | null): void { hovered = el; }

const samePath = (a: Path | null, b: Path | null) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** the object a mark inside it belongs to: the child of its slide, on a web page the nearest block */
function objectOf(el: Element): Element | null {
  for (let e: Element | null = el; e; e = e.parentElement) {
    if (e.parentElement?.classList.contains('slide')) return e;
  }
  return el.closest('p, h1, h2, h3, h4, h5, h6, ul, ol, div, section, figure, blockquote, table');
}

/** the pins drawn: a press on one opens its thread (and selects what it is on) */
export function bindPins(layer: HTMLElement, select: (el: Element) => void): void {
  for (const p of Array.from(layer.querySelectorAll<HTMLElement>('.pin'))) {
    p.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      const el = pinEls[Number(p.dataset.pin)];
      if (!el) return;
      if (!el.classList.contains('slide')) select(el);
      const s = slideOf(el);
      post({ ol: 'comment', path: pathOf(el), open: true, slide: s ? slides().indexOf(s) : -1 });
    }, true);
  }
}

/* ------------------------------------------------------------------ the original of a changed object */

let ghost: Element | null = null;

/** the object as it was before the suggestion changed it, faintly where it was (only one selected changed object) */
export function showGhost(el: Element | null): void {
  ghost?.remove();
  ghost = null;
  if (MODE !== 'edit' || !el || !el.isConnected || el.getAttribute(CHG) === null || !view.del) return;
  const was = parseWas(el.getAttribute(WAS));
  const keys = Object.keys(was).filter(k => k !== '@i');
  if (!keys.length) return;
  let g: Element | null;
  if (typeof was['@outer'] === 'string') {
    // (a part of a drawing parses as SVG inside an <svg>)
    const part = el instanceof SVGElement && el.localName !== 'svg';
    const t = document.createElement('template');
    t.innerHTML = part ? `<svg xmlns="http://www.w3.org/2000/svg">${was['@outer']}</svg>` : was['@outer'];
    g = part ? t.content.firstElementChild?.firstElementChild ?? null : t.content.firstElementChild;
    if (g) g = document.importNode(g, true);
  } else {
    g = el.cloneNode(true) as Element;
    for (const [k, v] of Object.entries(was)) {
      if (k.startsWith('@')) continue;
      try { if (v === null) g.removeAttribute(k); else g.setAttribute(k, String(v)); } catch { /* a name the DOM refuses */ }
    }
  }
  if (!g) return;
  for (const x of [g, ...Array.from(g.querySelectorAll('[id]'))]) x.removeAttribute('id');
  for (const a of [INS, DEL, CHG, WAS, COMMENTS, 'data-ol-current']) g.removeAttribute(a);
  g.setAttribute('data-ol-runtime', 'ghost');
  g.setAttribute('aria-hidden', 'true');
  const st = (g as HTMLElement | SVGElement).style;
  if (st) {
    st.setProperty('pointer-events', 'none', 'important');
    st.setProperty('opacity', '.3', 'important');
    st.setProperty('outline', '1.5px dashed #5f6673', 'important');
    st.setProperty('outline-offset', '1px', 'important');
  }
  el.after(g);
  // (an object in the page's flow would push what follows: no ghost for it)
  const svgPart = g instanceof SVGElement && g.localName !== 'svg';
  if (!svgPart && !/^(absolute|fixed)$/.test(getComputedStyle(g).position)) { g.remove(); return; }
  ghost = g;
}

/* ------------------------------------------------------------------ retyping while suggesting */

/** the deletions in a text being retyped cannot take the caret (typing would go into them) */
export function lockDeletions(el: HTMLElement): void {
  for (const d of Array.from(el.querySelectorAll(`del[${BY}], [${DEL}]`))) d.setAttribute('contenteditable', 'false');
}

/** the words being typed are someone's suggestion when Suggesting is on (and the text is not itself one) */
function tracking(el: HTMLElement): boolean {
  return view.suggesting && !!view.me && !el.closest(`[${INS}]`);
}

/**
 * A deletion or an insertion in the text being retyped, while suggesting: words deleted are struck
 * through (kept), words someone suggested adding go, what is typed goes into an <ins> of one's own.
 * True when it was done here (the browser's own edit prevented).
 */
export function trackInput(e: InputEvent, el: HTMLElement): boolean {
  if (!tracking(el)) return false;
  const t = e.inputType;
  const st = stampOf(view.me);
  const isDelete = t.startsWith('delete');
  const isInsert = t === 'insertText' || t === 'insertReplacementText';
  if (!isDelete && !isInsert) return false;
  const sel = getSelection();
  let range: Range | null = null;
  const tr = e.getTargetRanges?.() ?? [];
  if (tr.length) { range = document.createRange(); range.setStart(tr[0].startContainer, tr[0].startOffset); range.setEnd(tr[0].endContainer, tr[0].endOffset); }
  else if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) range = sel.getRangeAt(0).cloneRange();
  if (isDelete && (!range || range.collapsed)) return false;
  if (range && !el.contains(range.commonAncestorContainer)) return false;
  e.preventDefault();
  let caret: { node: Node; offset: number } | null = null;
  if (range && !range.collapsed) {
    const backward = /Backward/.test(t);
    caret = strike(range, el, st, backward);
  }
  if (isInsert) {
    const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
    if (text) {
      const at = caret ?? (sel && sel.rangeCount ? { node: sel.getRangeAt(0).startContainer, offset: sel.getRangeAt(0).startOffset } : null);
      if (at) caret = typeAt(at, text, el, st);
    }
  }
  if (caret && sel) { const r = document.createRange(); r.setStart(caret.node, caret.offset); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
  return true;
}

/** the text of a range struck through (what was typed as a suggestion goes): where the caret goes after */
function strike(range: Range, root: HTMLElement, st: string, backward: boolean): { node: Node; offset: number } {
  const texts: Text[] = [];
  const w = document.createTreeWalker(range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentNode! : range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (range.intersectsNode(n) && root.contains(n)) texts.push(n as Text);
  let first: Node | null = null, last: Node | null = null;
  for (const t of texts) {
    if (t.parentElement?.closest(`del[${BY}]`)) { first ??= t.parentElement.closest(`del[${BY}]`); last = t.parentElement.closest(`del[${BY}]`); continue; }
    const s = t === range.startContainer ? range.startOffset : 0;
    const e = t === range.endContainer ? range.endOffset : t.data.length;
    if (e <= s) continue;
    let seg = t;
    if (s > 0) seg = seg.splitText(s);
    if (e - s < seg.data.length) seg.splitText(e - s);
    const ins = seg.parentElement?.closest(`ins[${BY}]`);
    if (ins && root.contains(ins)) {
      // suggested words deleted: gone
      const parent = seg.parentNode!;
      const ref = seg.nextSibling;
      seg.remove();
      const mark = document.createTextNode('');
      parent.insertBefore(mark, ref);
      first ??= mark; last = mark;
      if (!ins.textContent) { const m2 = document.createTextNode(''); ins.replaceWith(m2); if (first === mark) first = m2; last = m2; }
      continue;
    }
    // next to a deletion of one's own: into it
    const prev = seg.previousSibling, next = seg.nextSibling;
    const own = (n: Node | null) => n instanceof Element && n.localName === 'del' && parseStamp(n.getAttribute(BY))?.by === view.me ? n : null;
    const into = backward ? own(next) ?? own(prev) : own(prev) ?? own(next);
    if (into) {
      if (into === next) into.insertBefore(seg, into.firstChild); else into.appendChild(seg);
      into.setAttribute(BY, st);
      first ??= into; last = into;
      continue;
    }
    const d = document.createElement('del');
    d.setAttribute(BY, st);
    d.setAttribute('contenteditable', 'false');
    seg.replaceWith(d);
    d.appendChild(seg);
    first ??= d; last = d;
  }
  // a formula chip or a picture wholly in the range: struck as a whole
  for (const x of Array.from(root.querySelectorAll('.ol-mathchip, img'))) {
    if (!range.intersectsNode(x) || x.closest(`del[${BY}]`)) continue;
    const r = document.createRange(); r.selectNode(x);
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0 || range.compareBoundaryPoints(Range.END_TO_END, r) < 0) continue;
    const d = document.createElement('del');
    d.setAttribute(BY, st);
    d.setAttribute('contenteditable', 'false');
    x.replaceWith(d);
    d.appendChild(x);
    first ??= d; last = d;
  }
  const at = backward ? first : last;
  if (!at) return { node: range.startContainer, offset: range.startOffset };
  if (at.nodeType === Node.TEXT_NODE) return { node: at, offset: 0 };
  // beside the deletion: before it going back, after it going on
  const parent = at.parentNode!;
  const idx = Array.prototype.indexOf.call(parent.childNodes, at);
  return { node: parent, offset: backward ? idx : idx + 1 };
}

/** text typed at a point: into an <ins> of one's own there, or a new one */
function typeAt(at: { node: Node; offset: number }, text: string, root: HTMLElement, st: string): { node: Node; offset: number } {
  const host = at.node.nodeType === Node.TEXT_NODE ? at.node.parentElement : at.node as Element;
  const mine = host?.closest(`ins[${BY}]`);
  if (mine && root.contains(mine) && parseStamp(mine.getAttribute(BY))?.by === view.me && at.node.nodeType === Node.TEXT_NODE) {
    const t = at.node as Text;
    t.insertData(at.offset, text);
    mine.setAttribute(BY, st);
    return { node: t, offset: at.offset + text.length };
  }
  const ins = document.createElement('ins');
  ins.setAttribute(BY, st);
  const t = document.createTextNode(text);
  ins.appendChild(t);
  const r = document.createRange();
  r.setStart(at.node, at.offset);
  r.collapse(true);
  // (not inside a deletion: after it)
  const inDel = (at.node.nodeType === Node.TEXT_NODE ? at.node.parentElement : at.node as Element)?.closest(`del[${BY}]`);
  if (inDel && root.contains(inDel)) r.setStartAfter(inDel);
  r.insertNode(ins);
  styleAuthors();
  return { node: t, offset: text.length };
}

/* ------------------------------------------------------------------ the rail */

/** a slide's review in the rail: its open comments and whether suggestions changed it */
export function railReview(s: Element): { comments: number; changed: string | null; deleted: boolean } {
  let comments = 0;
  for (const el of [s, ...Array.from(s.querySelectorAll(`[${COMMENTS}]`))]) if (el.hasAttribute(COMMENTS)) comments += parseThreads(el.getAttribute(COMMENTS)).filter(t => !t.done).length;
  const m = s.matches(MARK_SEL) ? s : s.querySelector(`${MARK_SEL}, ins[${BY}], del[${BY}]`);
  const st = m ? parseStamp(m.getAttribute(DEL) ?? m.getAttribute(INS) ?? m.getAttribute(CHG) ?? m.getAttribute(BY)) : null;
  return { comments, changed: st ? color(st.by) : null, deleted: s.hasAttribute(DEL) };
}

/* ------------------------------------------------------------------ a new comment */

/** Capture the comment's target and words before its text receiver gives up the keyboard. */
export function captureCommentTarget(editing: Element | null, selected: Element[], slide: Element | null): Extract<FromRuntime, { ol: 'comment' }> {
  let el: Element | null = editing ?? (selected.length ? selected[0] : null) ?? slide;
  let quote: string | undefined;
  if (editing) {
    const sel = getSelection();
    const q = sel && sel.rangeCount && editing.contains(sel.anchorNode) ? sel.toString().replace(/\s+/g, ' ').trim() : '';
    if (q) quote = q.slice(0, 200);
  }
  // a part of a drawing, a word: the object it is in
  if (el && !pathOf(el)) el = slide;
  const s = el ? slideOf(el) : null;
  const path = el ? pathOf(el) : null;
  return { ol: 'comment', path: path ? [...path] : null, quote, slide: s ? slides().indexOf(s) : -1, open: false };
}

