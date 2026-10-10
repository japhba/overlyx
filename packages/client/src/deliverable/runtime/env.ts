/**
 * The runtime's shared state: its mode (the server's `window.__OL`), messages to the editor, the
 * pairing of the live page with the source it was rendered from (`srcOf` / `liveOf`), slides and
 * paths. The live page differs from its source — MathJax typesets, the page's own scripts add and
 * change elements, the runtime adds its overlay — so an element of the page is found in the text
 * through the source element it was made from, never by its place in the live tree.
 */
import type { FromRuntime, DeliverableKind, Path, SlideBox } from '../protocol';

export type Mode = 'edit' | 'thumb' | 'present' | 'print' | 'check' | 'view';

declare global {
  interface Window { __OL?: { mode?: Mode }; __olReady?: boolean; __ol?: unknown; MathJax?: any }
}

export const MODE: Mode = (window.__OL?.mode ?? 'view') as Mode;
/** the runtime's own files (its script's folder) */
export const BASE: string = (() => {
  const s = document.currentScript as HTMLScriptElement | null;
  try { return new URL('.', s?.src || location.href).href; } catch { return '/_ol/'; }
})();

export function post(msg: FromRuntime): void {
  if (window.parent === window) return;
  window.parent.postMessage(msg, '*');
}

/** elements the runtime (or MathJax) put into the page: never part of the source */
export function isForeign(el: Element): boolean {
  if (el.hasAttribute('data-ol-runtime')) return true;
  const t = el.localName;
  return t === 'ol-overlay' || t === 'mjx-container' || (t === 'style' && /^MJX/.test(el.id)) || (t === 'svg' && el.id === 'MJX-SVG-global-cache');
}

/* ------------------------------------------------------------------ the source and its pairing */

export const state = {
  /** the source the page shows now (the editor's text at `version`), parsed */
  src: null as Document | null,
  version: null as number | null,
  html: '',
  kind: 'page' as DeliverableKind,
};

/** live element → the source element it was made from */
export const srcOf = new WeakMap<Element, Element>();
/** source element → its live element */
export const liveOf = new WeakMap<Element, Element>();

export function link(live: Element, src: Element): void {
  srcOf.set(live, src);
  liveOf.set(src, live);
}

/** the path of a source element (indices among element children from <html>) */
export function srcPath(src: Element): Path {
  const out: number[] = [];
  let cur: Element = src;
  while (cur.parentElement) {
    const p = cur.parentElement;
    out.unshift(Array.prototype.indexOf.call(p.children, cur));
    cur = p;
  }
  return out;
}

/** the path of a live element (through its source), or null for one the source does not have */
export function pathOf(live: Element): Path | null {
  const s = srcOf.get(live);
  return s && s.ownerDocument === state.src ? srcPath(s) : null;
}

/** the live element at a source path */
export function liveAt(path: Path): Element | null {
  if (!state.src) return null;
  let el: Element | null = state.src.documentElement;
  for (const i of path) { el = el?.children[i] ?? null; if (!el) return null; }
  return el ? liveOf.get(el) ?? null : null;
}

/** the nearest element of the source at or above `el` */
export function sourced(el: Element | null): Element | null {
  for (let e = el; e; e = e.parentElement) if (srcOf.has(e) && srcOf.get(e)!.ownerDocument === state.src) return e;
  return null;
}

/* ------------------------------------------------------------------ slides */

export function slides(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const visit = (n: Element) => {
    for (const c of Array.from(n.children)) {
      if (isForeign(c)) continue;
      if (c.classList.contains('slide')) { out.push(c as HTMLElement); continue; }
      if (c.localName !== 'script' && c.localName !== 'style' && c.localName !== 'template') visit(c);
    }
  };
  if (document.body) visit(document.body);
  return out;
}

export function detectKind(): DeliverableKind {
  const m = document.querySelector('meta[name="overlyx" i]');
  const k = (m?.getAttribute('content') ?? '').trim().toLowerCase().split(/[\s;,]/)[0];
  if (k === 'deck' || k === 'slides') return 'deck';
  if (k === 'poster') return 'poster';
  if (k === 'page' || k === 'webpage') return 'page';
  const n = slides().length;
  return n > 1 ? 'deck' : n === 1 ? 'poster' : 'page';
}

/** the slide an element is on */
export function slideOf(el: Element | null): HTMLElement | null {
  for (let e = el; e; e = e.parentElement) if (e.classList?.contains('slide')) return e as HTMLElement;
  return null;
}

export function docRect(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
}

export function slideTitle(s: Element): string {
  const h = s.querySelector('h1, h2, h3, h4');
  return ((h?.textContent ?? s.textContent ?? '').replace(/\s+/g, ' ').trim()).slice(0, 80);
}

export function slideBoxes(): SlideBox[] {
  return slides().map((s, i) => {
    s.setAttribute('data-ol-slide-index', String(i));
    const src = srcOf.get(s);
    return { index: i, path: src ? srcPath(src) : [], rect: docRect(s), title: slideTitle(s) };
  });
}

/** the pages' size: the first slide's (CSS px), or the viewport's for a web page */
export function pageSize(): { width: number; height: number } {
  const s = slides()[0];
  if (s) return { width: s.offsetWidth, height: s.offsetHeight };
  return { width: document.documentElement.clientWidth, height: document.documentElement.scrollHeight };
}

export function sendLayout(): void {
  const sz = pageSize();
  post({ ol: 'layout', slides: slideBoxes(), width: sz.width, height: sz.height, docHeight: document.documentElement.scrollHeight });
}
