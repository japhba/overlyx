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
 * - view: math typeset, nothing else (a page reached by a link from another);
 * - embed: one HTML block of an article, the page around it hidden (embed.ts: the document editor's).
 *
 * In every mode TeX math is typeset (math.ts) and speaker notes are hidden; `window.__olReady`
 * turns true once fonts, math and pictures have settled (the renderer waits for it).
 */
import { RAIL_NUM, ASIDE_ATTR, type ToRuntime, type Path, type PeerInfo } from '../protocol';
import { MODE, post, state, setFolderBase, detectKind, slideBoxes, pageSize, sendLayout, slides, srcOf, pathOf, docRect, isForeign, layoutHooks, liveAt, slideOf, penBusy, whenPenRests } from './env';
import { safeColor } from './carets';
import { inkOn } from '../../app/contrast';
import { startMath, typesetPage, useCachedMath } from './math';
import { mapAssets, mappedAttribute, setMappedAttribute } from '../offlineassets';
import { renderCites, refreshCites, addEntries, CITE_CSS } from './cite';
import { applySource, applyPatches, whenTypeset } from './reconcile';
import * as edit from './edit';
import { setGuidesShown } from './guides';
import { weave } from './weave';
import { arrange, paint, valign, restack } from './arrange';
import { wantObjects } from './objects';
import { nodeCommand } from './pathedit';
import { stepCommand } from './animate';
import { setView, refreshView, reportColors } from './view';
import { startPresenting } from './present';
import { report, rememberPage } from './report';
import { ensureSolo, notePageBackground, PAGE_BG, SOLO_PAD } from './solo';
import { setDarkSlides, darkSlidesChanged } from './darkpages';
import { installReviewCss, setReview, railReview } from './review';
import { exportPageSvg } from './svgexport';
import { startEmbed, embedSettled, startViewSync, viewSettled } from './embed';
import { startLinks } from './links';
import { looksOf } from './placeholders';
import { installStorage } from './storage';

// a page's localStorage where the sandbox refuses the browser's (storage.ts), before the page's scripts run
installStorage(MODE === 'view');

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
let railDrag: { from: number; y0: number; to: number | null; x: number; y: number; touch: boolean; hold?: ReturnType<typeof setTimeout> } | null = null;
/** the others on the page: a dot with their initials on the slide they are at */
let railPeers: PeerInfo[] = [];
/** who the rail shows where (`window.__ol.railPeers()`, for tests) */
let railDrawn: { slide: number; name: string }[] = [];

/** the slide a person is at: the one with the text they retype or what they selected, else the one they look at */
function peerSlide(p: PeerInfo, ss: HTMLElement[]): number {
  for (const path of [p.caret?.path, ...p.paths]) {
    const s = path ? slideOf(liveAt(path)) : null;
    const i = s ? ss.indexOf(s) : -1;
    if (i >= 0) return i;
  }
  return p.slide ?? -1;
}

const escAttr = (t: string): string => t.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const initials = (name: string): string => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? '?') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
};

/** the gap (screen px) between two thumbnails */
const RAIL_GAP = 12;

function startThumb(): void {
  addStyle(`html, body { scrollbar-width: none; } html::-webkit-scrollbar { display: none; } html, html * { cursor: pointer !important; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }`);
  // the slides one under the other, a gap between, each with its edge, on the rail's own colour
  // (railDesk; solo.ts PAGE_BG) — their numbers in the room left of them (RAIL_NUM)
  document.documentElement.classList.add('ol-thumb');
  addStyle(`html.ol-thumb { padding: ${SOLO_PAD}px ${SOLO_PAD}px ${SOLO_PAD}px calc(${SOLO_PAD}px + var(--ol-num, 0px)) !important; margin: 0 !important; box-sizing: content-box !important; height: auto !important; min-height: 0 !important; scroll-snap-type: none !important; }
    html.ol-thumb :is(body, :has(> .slide)) { display: block !important; gap: 0 !important; padding: 0 !important; margin: 0 !important; transform: none !important; zoom: 1 !important;
      height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; scroll-snap-type: none !important; }
    html.ol-thumb .slide { margin: 0 0 var(--ol-gap, 40px) 0 !important; transform: none !important;
      box-shadow: 0 0 0 var(--ol-hair, 1px) rgba(0, 0, 0, 0.2), 0 var(--ol-hair, 1px) calc(4 * var(--ol-hair, 1px)) rgba(0, 0, 0, 0.18) !important; }
    :where(html.ol-thumb .slide) { ${PAGE_BG} }
    html.ol-thumb .slide[data-ol-skip] { opacity: .45 !important; }`);
  notePageBackground();
  const host = document.createElement('ol-overlay');
  host.setAttribute('data-ol-runtime', '');
  host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;display:block;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .n { position: absolute; width: calc(${RAIL_NUM - 6}px / var(--s)); transform: translateX(calc(-100% - 6px / var(--s))); text-align: right; font: 500 calc(11px / var(--s)) / 1 system-ui, sans-serif; font-variant-numeric: tabular-nums; color: #8a8f98; }
    .n.on { color: #2f6fde; font-weight: 700; }
    .cur { position: absolute; box-sizing: border-box; border: calc(2.5px / var(--s)) solid #2f6fde; border-radius: calc(4px / var(--s)); }
    .drop { position: absolute; height: calc(3px / var(--s)); background: #2f6fde; }
    .c { position: absolute; transform: translate(calc(-100% - 4px / var(--s)), calc(4px / var(--s))); display: flex; align-items: center; gap: calc(2px / var(--s)); font: 700 calc(11px / var(--s)) system-ui, sans-serif; color: #3a2a00; background: #f6b400; padding: calc(1px / var(--s)) calc(5px / var(--s)); border-radius: calc(8px / var(--s)) calc(8px / var(--s)) calc(8px / var(--s)) calc(2px / var(--s)); }
    .chg { position: absolute; width: calc(3px / var(--s)); transform: translateX(calc(-5px / var(--s))); border-radius: calc(2px / var(--s)); }
    .del { position: absolute; transform: translate(-50%, -50%); font: 700 calc(12px / var(--s)) system-ui, sans-serif; color: #fff; background: #d2453c; padding: calc(2px / var(--s)) calc(8px / var(--s)); border-radius: calc(4px / var(--s)); }
    .del.skip { background: #5f6368; font-weight: 600; }
    .who { position: absolute; display: flex; gap: calc(2px / var(--s)); transform: translate(calc(-100% - 4px / var(--s)), calc(-100% - 4px / var(--s))); }
    .who span { display: grid; place-items: center; width: calc(18px / var(--s)); height: calc(18px / var(--s)); border-radius: 50%; font: 700 calc(9px / var(--s)) system-ui, sans-serif; box-shadow: 0 0 0 calc(1.5px / var(--s)) #fff; }
  </style><div class="l"></div>`;
  railLayer = root.querySelector('.l') as HTMLElement;
  document.documentElement.appendChild(host);
  addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); }, true);
  addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    if (e.button !== 0) return;
    const i = slideAt(e.pageY);
    if (i < 0) return;
    const d: NonNullable<typeof railDrag> = { from: i, y0: e.pageY, to: null, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' };
    // a finger or a pen has no right button, and iPad Safari sends no contextmenu: a slide held
    // still for a moment opens its menu (as the canvas picks up an object, edit.ts)
    if (d.touch) d.hold = setTimeout(() => { if (railDrag !== d || d.to !== null) return; railEnd(); post({ ol: 'contextmenu', x: d.x, y: d.y, slide: d.from }); }, 450);
    railDrag = d;
    addEventListener('pointermove', railMove, true);
    addEventListener('pointerup', railUp, true);
    addEventListener('pointercancel', railEnd, true);
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
  if (railDrag.hold) { clearTimeout(railDrag.hold); railDrag.hold = undefined; }
  railDrag.to = dropIndex(e.pageY);
  const ss = slides(), r0 = docRect(ss[0] ?? document.body);
  if (scrollY > 0 && e.clientY < 40) scrollBy(0, -20 / railScale);
  if (e.clientY > innerHeight - 40) scrollBy(0, 20 / railScale);
  drawRail();
  void r0;
}

/** the press on the rail is over (lifted, held for the menu, or taken by the browser's scrolling) */
function railEnd(): void {
  removeEventListener('pointermove', railMove, true);
  removeEventListener('pointerup', railUp, true);
  removeEventListener('pointercancel', railEnd, true);
  if (railDrag?.hold) clearTimeout(railDrag.hold);
  railDrag = null;
  drawRail();
}

function railUp(e: PointerEvent): void {
  const d = railDrag;
  railEnd();
  if (!d) return;
  // a tap on the slide already shown opens its menu, as in Keynote and PowerPoint on an iPad
  if (d.to === null && d.touch && d.from === railCurrent) { post({ ol: 'contextmenu', x: e.clientX, y: e.clientY, slide: d.from }); return; }
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
  const st = document.documentElement.style;
  st.setProperty('--ol-num', `${RAIL_NUM / railScale}px`);
  st.setProperty('--ol-gap', `${RAIL_GAP / railScale}px`);
  st.setProperty('--ol-hair', `${1 / railScale}px`);
  const ss = slides();
  const parts: string[] = [];
  railDrawn = [];
  ss.forEach((s, i) => {
    const r = docRect(s);
    parts.push(`<div class="n${i === railCurrent ? ' on' : ''}" style="left:${r.x}px;top:${r.y}px">${i + 1}</div>`);
    // the slide's open comments and suggestions (review.ts)
    const rv = railReview(s);
    if (rv.changed) parts.push(`<div class="chg" style="left:${r.x}px;top:${r.y}px;height:${r.h}px;background:${rv.changed}" title="Suggested changes"></div>`);
    if (rv.deleted) parts.push(`<div class="del" style="left:${r.x + r.w / 2}px;top:${r.y + r.h / 2}px">Deleted</div>`);
    else if (s.hasAttribute('data-ol-skip')) parts.push(`<div class="del skip" style="left:${r.x + r.w / 2}px;top:${r.y + r.h / 2}px">Skipped</div>`);
    if (rv.comments) parts.push(`<div class="c" style="left:${r.x + r.w}px;top:${r.y}px">💬 ${rv.comments}</div>`);
    // (a ring round it, a hair apart from its edge)
    const o = 4 / railScale;
    if (i === railCurrent) parts.push(`<div class="cur" style="left:${r.x - o}px;top:${r.y - o}px;width:${r.w + 2 * o}px;height:${r.h + 2 * o}px"></div>`);
    const here = railPeers.filter(p => peerSlide(p, ss) === i).slice(0, 4);
    for (const p of here) railDrawn.push({ slide: i, name: p.name });
    if (here.length) {
      const dots = here.map(p => { const c = safeColor(p.color); return `<span title="${escAttr(p.name)}" style="background:${c};color:${inkOn(c)}">${escAttr(initials(p.name))}</span>`; }).join('');
      parts.push(`<div class="who" data-ol-rail-peers="${i}" style="left:${r.x + r.w}px;top:${r.y + r.h}px">${dots}</div>`);
    }
  });
  if (railDrag && railDrag.to !== null) {
    const t = railDrag.to;
    const r = t < ss.length ? docRect(ss[t]) : docRect(ss[ss.length - 1]);
    const y = t < ss.length ? r.y - (RAIL_GAP / 2 + 1.5) / railScale : r.y + r.h + (RAIL_GAP / 2 - 1.5) / railScale;
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

/* ------------------------------------------------------------------ slides light on dark (darkpages.ts) */

let railDeskCss: HTMLStyleElement | null = null;
/** the rail's background between the thumbnails: the editor's rail's own colour (or the page's own: null) */
function railDesk(desk: string | null): void {
  if (!railDeskCss) { railDeskCss = document.createElement('style'); railDeskCss.setAttribute('data-ol-runtime', ''); document.head.appendChild(railDeskCss); }
  railDeskCss.textContent = desk && /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s]+\))$/i.test(desk) ? `html:not(.ol-bg-read), html:not(.ol-bg-read) body { background: ${desk} !important; }` : '';
}

/* ------------------------------------------------------------------ messages */

function onMessage(e: MessageEvent): void {
  if (e.source !== window.parent) return;
  const m = e.data as ToRuntime;
  if (!m || typeof m !== 'object' || typeof m.ol !== 'string') return;
  if (MODE === 'present' && m.ol !== 'assets' && m.ol !== 'folder') return;
  switch (m.ol) {
    case 'exportSvg':
      try { post({ ol: 'exportedSvg', id: m.id, svg: exportPageSvg(edit.visibleSlideEl() ?? slides()[0], m.except) }); }
      catch (e) { post({ ol: 'exportedSvg', id: m.id, error: String((e as Error).message ?? e) }); }
      break;
    case 'folder': {
      setFolderBase(m.base);
      break;
    }
    case 'assets':
      if (!window.__OL) window.__OL = {};
      window.__OL.assetUrls = m.urls;
      useCachedMath(m.urls);
      mapAssets(document.documentElement, m.urls, document.baseURI);
      break;
    case 'source': {
      const first = state.src === null;
      // (patches of the version shown: only what they change parsed — else all of the text, asked for when not sent)
      // (inside slides only: the page's colours and the slides' backdrop stay as they were)
      let inSlides = false;
      if (m.patch && applyPatches(m.patch.base, m.patch.list, m.version)) inSlides = m.patch.list.every(p => !!slideOf(liveAt(p.path)));
      else {
        if (typeof m.html !== 'string') { post({ ol: 'needSource' }); return; }
        if (!applySource(m.html, m.version)) return;
      }
      // (the kind as the text has it now: the page first served may have been another version)
      state.kind = detectKind();
      if (MODE === 'edit') { ensureSolo(); edit.afterSource(); void whenTypeset().then(() => edit.draw()); }
      if (MODE === 'thumb') { notePageBackground(); drawRail(); }
      darkSlidesChanged();
      if (first) void settle().then(() => { sendLayout(); if (MODE === 'edit') { refreshView(); reportColors(); } });
      // (a stroke on a slide while the pen writes on: the slides measured again once it rests)
      else if (inSlides && MODE === 'edit' && penBusy()) whenPenRests(sendLayout);
      else requestAnimationFrame(() => { sendLayout(); if (MODE === 'thumb') drawRail(); if (MODE === 'edit' && !inSlides) { refreshView(); reportColors(); } });
      break;
    }
    case 'select': if (MODE === 'edit') edit.selectPaths(m.paths as Path[]); break;
    case 'looks': post({ ol: 'looks', id: m.id, looks: looksOf(m.paths.map(p => liveAt(p))) }); break;
    case 'editText': if (MODE === 'edit') edit.editTextAt(m.path, m.selectAll, m.math); break;
    case 'stopText': if (MODE === 'edit') edit.stopText(m.save !== false); break;
    case 'scrollTo': if (MODE === 'edit') edit.scrollToSlide(m.slide, m.smooth); else if (MODE === 'thumb') railShow(m.slide); break;
    case 'scale': if (MODE === 'edit') edit.setScale(m.scale, m.anchor); else { railScale = m.scale; drawRail(); } break;
    case 'tool': if (MODE === 'edit') edit.setTool(m.tool, m.ink, m.held); break;
    case 'inkConvert': if (MODE === 'edit') edit.inkConvert(m.as); break;
    case 'inkTyped': if (MODE === 'edit') edit.inkTyped(m.text, m.as); break;
    case 'guides': if (MODE === 'edit') setGuidesShown(m.show); break;
    case 'exec': if (MODE === 'edit') edit.exec(m.command, m.value); break;
    case 'peers': if (MODE === 'edit') edit.setPeers(m.peers); else if (MODE === 'thumb') { railPeers = m.peers; drawRail(); } break;
    case 'dark': if (MODE === 'edit' || MODE === 'thumb') { setDarkSlides(m.invert, !!m.figures); if (MODE === 'thumb') railDesk(m.desk); } break;
    case 'current': if (MODE === 'thumb') railShow(m.slide); break;
    case 'asset': refreshAsset(m.path, m.v); break;
    case 'arrange': if (MODE === 'edit') arrange(m.how); break;
    case 'paint': if (MODE === 'edit') paint(m.paint); break;
    case 'valign': if (MODE === 'edit') valign(m.v); break;
    case 'view': if (MODE === 'edit') setView(m.view); break;
    case 'crop': if (MODE === 'edit') edit.cropAt(m.path, { aspect: m.aspect, shape: m.shape }); break;
    case 'cropPreset': if (MODE === 'edit') edit.cropPreset(m.path, m); break;
    case 'cropAspect': if (MODE === 'edit') edit.setCropAspect(m.aspect, m.shape); break;
    case 'endCrop': if (MODE === 'edit') edit.endCrop(m.commit); break;
    case 'mathShown': if (MODE === 'edit') edit.mathShown(m.id); break;
    case 'mathSet': if (MODE === 'edit') edit.mathSet(m.id, m.tex); break;
    case 'mathDone': if (MODE === 'edit') edit.mathDone(m.id, m.tex, m.dir, m.putBack, m.keys); break;
    case 'mathDisplay': if (MODE === 'edit') edit.mathDisplay(m.id); break;
    case 'typeKeys': if (MODE === 'edit') edit.typeKeys(m.keys); break;
    case 'bib': addEntries(m.entries); break;
    case 'insertRef': if (MODE === 'edit') edit.insertRef(m.src); break;
    case 'insertMath': if (MODE === 'edit') edit.insertMath(m.display); break;
    case 'nodes': if (MODE === 'edit') nodeCommand(m.cmd); break;
    case 'steps': if (MODE === 'edit') stepCommand(m.cmd); break;
    case 'selectAll': if (MODE === 'edit') edit.selectAllOnSlide(); break;
    case 'objects': if (MODE === 'edit') wantObjects(m.on); break;
    case 'hover': if (MODE === 'edit') edit.hoverPath(m.path); break;
    case 'restack': if (MODE === 'edit') restack(m.path, m.ref, m.front); break;
    case 'canvasKey': if (MODE === 'edit') { if (m.key === 'Escape') edit.escapeCanvas(m.shift); else if (m.key === 'Delete' || m.key === 'Backspace') edit.removeSelected(); else edit.nudge(m.key, m.shift); } break;
    case 'review': if (MODE === 'edit') { setReview(m.view); edit.report(); edit.draw(); } break;
    case 'newComment': if (MODE === 'edit') edit.newComment(); break;
    case 'paste': if (MODE === 'edit') edit.pasteHere(m); break;
    case 'weave': if (MODE === 'edit') weave(); break;
  }
}

/** a file the page uses changed: stylesheets and pictures fetched again in place, anything else reloads the page */
function refreshAsset(path: string, v: number): void {
  const base = document.baseURI;
  const matches = (url: string | null) => {
    if (!url || /^(data|blob):/i.test(url)) return false;
    try {
      const u = new URL(url, base);
      return u.origin === new URL(base).origin && decodeURIComponent(u.pathname).endsWith('/' + path);
    } catch { return false; }
  };
  const refresh = (el: Element, name: string) => {
    const raw = mappedAttribute(el, name);
    if (!matches(raw)) return false;
    const url = new URL(raw!, base), fresh = new URL(url.href);
    fresh.searchParams.set('olv', String(v));
    // Keep the source and selected DOM node unchanged. The next assets message
    // can replace this temporary fetch URL with its newly cached data URL.
    setMappedAttribute(el, name, raw!, { [url.href]: fresh.href }, base);
    return true;
  };
  let hit = false;
  for (const l of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))) if (refresh(l, 'href')) hit = true;
  for (const i of Array.from(document.querySelectorAll<HTMLImageElement>('img[src], image[href], source[src]'))) {
    const a = i.hasAttribute('src') ? 'src' : 'href';
    if (refresh(i, a)) hit = true;
  }
  if (hit) return;
  // a script, data a script loads, a font, an @import: only a reload is sure to take it
  const used = Array.from(document.querySelectorAll('script[src]')).some(sc => matches(mappedAttribute(sc, 'src'))) || performance.getEntriesByType('resource').some(e => matches(e.name));
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
      await typesetPage();
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
  // a skipped slide (the editor's Skip slide): not presented, not printed
  if (MODE === 'present' || MODE === 'print') addStyle('.slide[data-ol-skip] { display: none !important; }');
  // what lies beside a slide (drawn on the canvas round it, solo.ts): only while editing
  if (MODE !== 'edit') addStyle(`[${ASIDE_ATTR}] { display: none !important; }`);
  // suggestions shown while editing, accepted everywhere else (review.ts)
  installReviewCss();
  if (MODE === 'check') rememberPage();
  // the formulas hidden (never their TeX on screen) and MathJax fetched while the page's fonts load
  startMath();
  // citations and lists of references (cite.ts)
  addStyle(CITE_CSS);
  if (document.body) { renderCites([document.body]); refreshCites(); }
  window.__ol = { report, version: () => state.version, slides: () => slideBoxes(), size: pageSize, peerCarets: edit.peerCarets, railPeers: () => railDrawn };
  if (MODE === 'present') startPresenting();
  if (MODE === 'edit') { edit.startEditing(); ensureSolo(); }
  if (MODE === 'thumb') startThumb();
  if (MODE === 'embed') startEmbed();
  if (MODE === 'view') startViewSync();
  // links that leave OverLyX: a new tab; to the project's files: OverLyX (links.ts)
  if (MODE === 'view' || MODE === 'embed' || MODE === 'present') startLinks(MODE !== 'present');
  if (MODE === 'present') addEventListener('message', onMessage);
  if (MODE === 'edit' || MODE === 'thumb') {
    addEventListener('message', onMessage);
    const sz = pageSize();
    post({ ol: 'ready', version: null, kind: state.kind, slides: slideBoxes(), width: sz.width, height: sz.height, docHeight: document.documentElement.scrollHeight, macros: window.__OL?.macros, solo: layoutHooks.solo?.() });
  }
  void settle().then(() => {
    slideBoxes();   // (numbers the slides for the renderer's screenshots)
    if (MODE === 'print') {
      printCss();
      // opened to be printed (the VS Code extension's "Print or save as PDF"): the browser's print dialog
      if (location.hash === '#print') setTimeout(() => print(), 300);
    }
    window.__olReady = true;
    if (MODE === 'embed') embedSettled();
    if (MODE === 'view') viewSettled();
    if (MODE === 'edit' || MODE === 'thumb') { sendLayout(); if (MODE === 'edit') { edit.visibleSlide(); refreshView(); reportColors(); } }
  });
  void isForeign;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
