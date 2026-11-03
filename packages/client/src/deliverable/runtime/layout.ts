/** Layout for agents, measured in the same settled page as their screenshot. */
import type { DeliverableLayout, LayoutBox, LayoutObject } from '@overlyx/core/html/layout.ts';
import { isForeign, slides, state } from './env';

const SKIP = '[data-ol-runtime], .notes, script, style, template, link, meta, noscript, mjx-assistive-mml';
const MATH = 'mjx-container, .katex, .MathJax, math';
const invisible = /^[\s\u200b-\u200d\u2060\ufeff]*$/;
const round = (n: number) => Math.round(n * 1000) / 1000;

function shown(el: Element): boolean {
  const c = getComputedStyle(el);
  return c.display !== 'none' && c.visibility !== 'hidden' && c.visibility !== 'collapse' && c.opacity !== '0';
}

/** No authored ids or class names enter a selector: duplicates and CSS punctuation are harmless. */
function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e; e = e.parentElement) {
    parts.unshift(e.parentElement ? `:nth-child(${Array.prototype.indexOf.call(e.parentElement.children, e) + 1})` : 'html');
  }
  return parts.join(' > ');
}

function textRects(el: Element): DOMRect[] {
  const rects: DOMRect[] = [], range = document.createRange();
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const p = n.parentElement;
    if (!p || invisible.test(n.nodeValue ?? '') || p.closest(`${SKIP}, ${MATH}`) || !shown(p)) continue;
    range.selectNodeContents(n);
    rects.push(...Array.from(range.getClientRects()).filter(r => r.width > 0.5 && r.height > 0.5));
  }
  // Inline MathJax 4 may have several SVG chunks on different lines.
  for (const m of Array.from(el.querySelectorAll(MATH))) {
    if (m.parentElement?.closest(MATH) || !shown(m)) continue;
    const chunks = m.querySelectorAll('svg');
    for (const c of chunks.length ? Array.from(chunks) : [m]) {
      const r = c.getBoundingClientRect();
      if (r.width > 0.5 && r.height > 0.5) rects.push(r);
    }
  }
  return rects;
}

/** Inline spans with different font sizes still share a line. Start with the shortest boxes so
 * a tall formula does not join two neighbouring text lines. */
function lineCount(rects: DOMRect[]): number {
  const lines: DOMRect[] = [];
  for (const r of rects.slice().sort((a, b) => a.height - b.height)) {
    if (!lines.some(l => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > Math.min(l.height, r.height) / 2)) lines.push(r);
  }
  return lines.length;
}

function unwrappedLines(el: Element): number {
  const saved: { el: Element; style: string | null }[] = [];
  try {
    for (const e of [el, ...Array.from(el.querySelectorAll('*'))]) {
      if (!(e instanceof HTMLElement) || e.closest(SKIP)) continue;
      saved.push({ el: e, style: e.getAttribute('style') });
      const ws = getComputedStyle(e).whiteSpace;
      e.style.setProperty('white-space', /pre|break-spaces/.test(ws) ? 'pre' : 'nowrap', 'important');
    }
    return lineCount(textRects(el));
  } finally {
    for (const s of saved) {
      if (s.style === null) s.el.removeAttribute('style'); else s.el.setAttribute('style', s.style);
    }
  }
}

function measure(scope: Element, index: number) {
  const frame = scope.getBoundingClientRect();
  const origin = state.kind === 'page' ? { x: -scrollX, y: -scrollY } : { x: frame.left, y: frame.top };
  const box = (r: DOMRect): LayoutBox => ({ x: round(r.left - origin.x), y: round(r.top - origin.y), w: round(r.width), h: round(r.height) });
  const objects: LayoutObject[] = [];
  const visit = (el: Element) => {
    if (isForeign(el) || el.matches(SKIP) || !shown(el)) return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const kids = Array.from(el.children).filter(c => !isForeign(c) && !c.matches(SKIP));
    const group = el.classList.contains('ol-group') || kids.length > 1 &&
      !Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && !invisible.test(n.textContent ?? '')) &&
      kids.every(k => /^(absolute|fixed)$/.test(getComputedStyle(k).position));
    const object: LayoutObject = {
      selector: selectorOf(el), ...(el.id ? { id: el.id } : {}), tag: el.localName, box: box(r), formulas: [],
    };
    if (!group) {
      for (const m of Array.from(el.querySelectorAll('mjx-container'))) {
        const marks = Array.from(m.querySelectorAll('[data-mml-node][class], [data-mml-node][id]')).flatMap(mark => {
          const classes = Array.from(mark.classList).filter(c => !/^mjx-/i.test(c));
          const id = mark.id && !/^mjx-/i.test(mark.id) ? mark.id : undefined;
          return classes.length || id ? [{ classes, ...(id ? { id } : {}), box: box(mark.getBoundingClientRect()) }] : [];
        });
        object.formulas.push({ box: box(m.getBoundingClientRect()), marks });
      }
      const rects = textRects(el);
      if (rects.length) {
        const lines = lineCount(rects);
        object.text = { lineCount: lines, wraps: lines > unwrappedLines(el),
          overflow: { x: el.scrollWidth > el.clientWidth + 2, y: el.scrollHeight > el.clientHeight + 2 },
          fontFamily: getComputedStyle(el).fontFamily, fonts: null };
      }
    }
    objects.push(object);
    if (group) kids.forEach(visit);
  };
  Array.from(scope.children).forEach(visit);
  return { index, width: state.kind === 'page' ? document.documentElement.clientWidth : frame.width,
    height: state.kind === 'page' ? document.documentElement.scrollHeight : frame.height, objects };
}

export function layout(pages: number[]): DeliverableLayout {
  const ss = slides();
  const scopes = state.kind === 'page' || !ss.length ? [document.body] : ss;
  return { units: 'css-px', pages: pages.filter((i, n) => i >= 0 && i < scopes.length && pages.indexOf(i) === n).map(i => measure(scopes[i], i)) };
}
