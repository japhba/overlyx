/**
 * The OverLyX runtime of HTML deliverables (decks, posters, web pages): injected into the page by
 * the server (deliverables.ts) as the first thing in its <head>, in one of these modes —
 *
 * - edit: the editor's canvas (edit.ts) — the page as its text has it, updated in place on every
 *   change (reconcile.ts), objects selected, moved, resized, retyped;
 * - thumb: the editor's slide rail — the same page, small, slides numbered, dragged to reorder;
 * - present: one slide at a time (present.ts);
 * - print: one slide per PDF page (the export);
 * - check: the agents' render_page — the page as it is, and `__ol.report()` (report.ts);
 * - view: math typeset, nothing else (a page reached by a link from another).
 *
 * In every mode TeX math is typeset (math.ts) and speaker notes are hidden; `window.__olReady`
 * turns true once fonts, math and pictures have settled (the renderer waits for it).
 */
import type { ToRuntime, Path } from '../protocol';
import { MODE, post, state, detectKind, slideBoxes, pageSize, sendLayout, slides, srcOf, pathOf, docRect, isForeign } from './env';
import { startMath } from './math';
import { applySource } from './reconcile';
import * as edit from './edit';
import { startPresenting } from './present';
import { report } from './report';

function addStyle(css: string): HTMLStyleElement {
  const s = document.createElement('style');
  s.setAttribute('data-ol-runtime', '');
  s.textContent = css;
  (document.head ?? document.documentElement).appendChild(s);
  return s;
}

const NOTES_CSS = `.slide aside.notes, .slide > .notes { display: none !important; }`;

function printCss(): void {
  addStyle(`html, body { margin: 0 !important; padding: 0 !important; background: none !important; }
    :is(body, :has(> .slide)) { display: block !important; gap: 0 !important; padding: 0 !important; margin: 0 !important; transform: none !important; zoom: 1 !important; }
    .slide { margin: 0 !important; break-after: page; break-inside: avoid; box-shadow: none !important; transform: none !important; }
    .slide:last-of-type { break-after: auto; }
    body > :not(.slide):not(:has(.slide)):not(script):not(style):not([data-ol-runtime]) { display: none !important; }
    @media print { html, body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; } }`);
  const s = slides()[0];
  if (s) addStyle(`@page { size: ${s.offsetWidth}px ${s.offsetHeight}px; margin: 0; }`);
}

/* ------------------------------------------------------------------ the rail */

let railCurrent = -1;
let railScale = 0.15;
let railLayer: HTMLElement | null = null;
let railDrag: { from: number; y0: number; to: number | null } | null = null;

function startThumb(): void {
  addStyle(`html, body { scrollbar-width: none; } html::-webkit-scrollbar { display: none; } html, html * { cursor: pointer !important; }`);
  const host = document.createElement('ol-overlay');
  host.setAttribute('data-ol-runtime', '');
  host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;display:block;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .n { position: absolute; font: 600 calc(12px / var(--s)) system-ui, sans-serif; color: #fff; background: rgba(40,44,52,.82); padding: calc(1px / var(--s)) calc(6px / var(--s)); border-radius: calc(4px / var(--s)); transform: translate(calc(4px / var(--s)), calc(4px / var(--s))); }
    .cur { position: absolute; box-sizing: border-box; border: calc(3px / var(--s)) solid #2f6fde; border-radius: calc(3px / var(--s)); }
    .drop { position: absolute; height: calc(3px / var(--s)); background: #2f6fde; }
  </style><div class="l"></div>`;
  railLayer = root.querySelector('.l') as HTMLElement;
  document.documentElement.appendChild(host);
  addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); }, true);
  addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    if (e.button !== 0) return;
    const i = slideAt(e.pageY);
    if (i < 0) return;
    railDrag = { from: i, y0: e.pageY, to: null };
    addEventListener('pointermove', railMove, true);
    addEventListener('pointerup', railUp, true);
  }, true);
  addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    const i = slideAt(e.pageY);
    post({ ol: 'contextmenu', x: e.clientX, y: e.clientY, slide: i });
  }, true);
  addEventListener('keydown', e => { e.preventDefault(); post({ ol: 'key', key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }); }, true);
  addEventListener('resize', drawRail);
  new ResizeObserver(drawRail).observe(document.documentElement);
}

function slideAt(y: number): number {
  const ss = slides();
  let best = -1, bd = Infinity;
  ss.forEach((s, i) => { const r = docRect(s); const d = y < r.y ? r.y - y : y > r.y + r.h ? y - r.y - r.h : 0; if (d < bd) { bd = d; best = i; } });
  return best;
}

/** where a dragged slide would go: before slide `to` (slides.length: after the last) */
function dropIndex(y: number): number {
  const ss = slides();
  for (let i = 0; i < ss.length; i++) { const r = docRect(ss[i]); if (y < r.y + r.h / 2) return i; }
  return ss.length;
}

function railMove(e: PointerEvent): void {
  if (!railDrag) return;
  if (railDrag.to === null && Math.abs(e.pageY - railDrag.y0) * railScale < 6) return;
  railDrag.to = dropIndex(e.pageY);
  const ss = slides(), r0 = docRect(ss[0] ?? document.body);
  if (scrollY > 0 && e.clientY < 40) scrollBy(0, -20 / railScale);
  if (e.clientY > innerHeight - 40) scrollBy(0, 20 / railScale);
  drawRail();
  void r0;
}

function railUp(e: PointerEvent): void {
  removeEventListener('pointermove', railMove, true);
  removeEventListener('pointerup', railUp, true);
  const d = railDrag;
  railDrag = null;
  drawRail();
  if (!d) return;
  if (d.to === null) { post({ ol: 'goto', slide: d.from }); return; }
  const ss = slides();
  const moved = ss[d.from];
  if (d.to === d.from || d.to === d.from + 1 || !moved) return;
  const src = srcOf.get(moved);
  const path = pathOf(moved);
  if (!src || !path || state.version === null) return;
  const parentSrc = src.parentElement!;
  const siblings = Array.from(parentSrc.children).filter(c => c !== src);
  let index: number;
  if (d.to < ss.length) { const before = srcOf.get(ss[d.to]); index = before ? siblings.indexOf(before) : siblings.length; }
  else { const last = srcOf.get(ss[ss.length - 1]); index = last ? siblings.indexOf(last) + 1 : siblings.length; }
  if (index < 0) return;
  const parentPath = path.slice(0, -1);
  post({ ol: 'ops', version: state.version, ops: [{ t: 'move', path, parent: parentPath, index }] });
  void e;
}

function drawRail(): void {
  if (!railLayer) return;
  railLayer.style.setProperty('--s', String(railScale));
  const ss = slides();
  const parts: string[] = [];
  ss.forEach((s, i) => {
    const r = docRect(s);
    parts.push(`<div class="n" style="left:${r.x}px;top:${r.y}px">${i + 1}</div>`);
    if (i === railCurrent) parts.push(`<div class="cur" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px"></div>`);
  });
  if (railDrag && railDrag.to !== null) {
    const t = railDrag.to;
    const r = t < ss.length ? docRect(ss[t]) : docRect(ss[ss.length - 1]);
    const y = t < ss.length ? r.y - 12 / railScale : r.y + r.h + 12 / railScale;
    parts.push(`<div class="drop" style="left:${r.x}px;top:${y}px;width:${r.w}px"></div>`);
  }
  railLayer.innerHTML = parts.join('');
}

function railShow(i: number): void {
  railCurrent = i;
  drawRail();
  const s = slides()[i];
  if (!s) return;
  const r = docRect(s);
  if (r.y < scrollY || r.y + r.h > scrollY + innerHeight) scrollTo({ top: Math.max(0, r.y - 20 / railScale) });
}

/* ------------------------------------------------------------------ messages */

function onMessage(e: MessageEvent): void {
  if (e.source !== window.parent) return;
  const m = e.data as ToRuntime;
  if (!m || typeof m !== 'object' || typeof m.ol !== 'string') return;
  switch (m.ol) {
    case 'source': {
      const first = state.src === null;
      const ok = applySource(m.html, m.version);
      if (!ok) return;
      if (MODE === 'edit') edit.afterSource();
      if (MODE === 'thumb') drawRail();
      state.kind = detectKind();
      if (first) void settle().then(() => sendLayout());
      else requestAnimationFrame(() => { sendLayout(); if (MODE === 'thumb') drawRail(); });
      break;
    }
    case 'select': if (MODE === 'edit') edit.selectPaths(m.paths as Path[]); break;
    case 'editText': if (MODE === 'edit') edit.editTextAt(m.path, m.selectAll); break;
    case 'scrollTo': if (MODE === 'edit') edit.scrollToSlide(m.slide, m.smooth); else if (MODE === 'thumb') railShow(m.slide); break;
    case 'scale': if (MODE === 'edit') edit.setScale(m.scale); else { railScale = m.scale; drawRail(); } break;
    case 'tool': if (MODE === 'edit') edit.setTool(m.tool); break;
    case 'exec': if (MODE === 'edit') edit.exec(m.command, m.value); break;
    case 'peers': if (MODE === 'edit') edit.setPeers(m.peers); break;
    case 'current': if (MODE === 'thumb') railShow(m.slide); break;
    case 'asset': refreshAsset(m.path, m.v); break;
  }
}

/** a file the page uses changed: stylesheets and pictures fetched again in place, anything else reloads the page */
function refreshAsset(path: string, v: number): void {
  const matches = (url: string | null) => {
    if (!url || /^(data|blob):/i.test(url) || (/^https?:/i.test(url) && !url.includes('/ol-d/'))) return false;
    try { return decodeURIComponent(new URL(url, location.href).pathname).endsWith('/' + path); } catch { return false; }
  };
  const bust = (url: string) => { const u = new URL(url, location.href); u.searchParams.set('olv', String(v)); return u.pathname + u.search; };
  let hit = false;
  for (const l of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))) if (matches(l.getAttribute('href'))) { l.href = bust(l.getAttribute('href')!); hit = true; }
  for (const i of Array.from(document.querySelectorAll<HTMLImageElement>('img[src], image[href], source[src]'))) {
    const a = i.hasAttribute('src') ? 'src' : 'href';
    if (matches(i.getAttribute(a))) { i.setAttribute(a, bust(i.getAttribute(a)!)); hit = true; }
  }
  if (hit) return;
  // a script, data a script loads, a font, an @import: only a reload is sure to take it
  const used = Array.from(document.querySelectorAll('script[src]')).some(sc => matches(sc.getAttribute('src'))) || performance.getEntriesByType('resource').some(e => matches(e.name));
  if (used) location.reload();
}

/* ------------------------------------------------------------------ settling */

function waitImages(): Promise<void> {
  const imgs = Array.from(document.images).filter(i => !i.complete);
  if (!imgs.length) return Promise.resolve();
  return Promise.race([
    Promise.all(imgs.map(i => new Promise<void>(r => { i.addEventListener('load', () => r(), { once: true }); i.addEventListener('error', () => r(), { once: true }); }))).then(() => undefined),
    new Promise<void>(r => setTimeout(r, 8000)),
  ]);
}

const frames = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

let settled: Promise<void> | null = null;
function settle(): Promise<void> {
  if (!settled) {
    settled = (async () => {
      try { await Promise.race([document.fonts?.ready, new Promise(r => setTimeout(r, 8000))]); } catch { /* ignore */ }
      await startMath();
      await waitImages();
      // the page's own scripts (a chart drawn after load) get a moment
      await new Promise(r => setTimeout(r, MODE === 'check' || MODE === 'print' ? 400 : 50));
      await frames();
    })();
  }
  return settled;
}

function init(): void {
  state.kind = detectKind();
  addStyle(NOTES_CSS);
  window.__ol = { report, version: () => state.version, slides: () => slideBoxes(), size: pageSize };
  if (MODE === 'present') startPresenting();
  if (MODE === 'edit') edit.startEditing();
  if (MODE === 'thumb') startThumb();
  if (MODE === 'edit' || MODE === 'thumb') {
    addEventListener('message', onMessage);
    const sz = pageSize();
    post({ ol: 'ready', version: null, kind: state.kind, slides: slideBoxes(), width: sz.width, height: sz.height, docHeight: document.documentElement.scrollHeight });
  }
  void settle().then(() => {
    slideBoxes();   // (numbers the slides for the renderer's screenshots)
    if (MODE === 'print') printCss();
    window.__olReady = true;
    if (MODE === 'edit' || MODE === 'thumb') { sendLayout(); if (MODE === 'edit') edit.visibleSlide(); }
  });
  void isForeign;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
