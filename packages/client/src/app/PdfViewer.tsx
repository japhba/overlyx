/**
 * A PDF viewer (pdf.js): the pages of a document rendered to canvases, lazily as they scroll
 * into view, fitted to the width of the panel or zoomed. Used for the built PDF in its pane and
 * for PDF files of a project opened in a tab. SyncTeX: `target` scrolls to a box of the page and
 * flashes it (forward search); a double-click on a page reports the point in PDF points from the
 * page's top-left (inverse search) through `onSync`.
 *
 * A rebuilt PDF (a new `url`) replaces the old one without a flicker: the new document loads while
 * the old pages stay on screen, every page is rendered off-screen and copied onto its canvas in
 * one step, and the reader stays on the same page at the same place in it (the page and the
 * offset into it are kept, not the scroll fraction, so pages added above do not move the view).
 * `overlay` floats over the pages.
 *
 * Links (the PDF's link annotations — hyperref's citations, references, contents, URLs): an
 * invisible area over each; a web or mail address opens in a new tab, a place in the document is
 * scrolled to, and Back returns to where the reader was. A file named relative to the document
 * (`\href{README.md}{…}`, `run:` / `file:` links, another PDF) opens in OverLyX, found from `base`.
 *
 * Zoom: Fit width and Fit content (past the margins: the pages cropped to what is painted on them, as
 * big as the pane takes them — pdfzoom.ts) and the steps between, from the
 * toolbar or a mouse wheel's notches with Ctrl/⌘; or a pinch — a trackpad's (Ctrl + wheel in Chromium
 * and Firefox, the gesture events in Safari), two fingers on a touch screen — about the pointer, which
 * stops at the fits and holds there. The zoom is said over the pages while it changes (zoomhud.ts).
 * While a pinch goes on the drawn pages are stretched; they are drawn anew once it settles. A page whose canvas would exceed
 * MAX_CANVAS_PIXELS (an A0 poster zoomed in) is drawn coarser, with a sharp detail canvas over the
 * part of it in view.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
// pdf.js's legacy build: the default ("modern") one needs the newest engines — Map.getOrInsertComputed,
// Math.sumPrecise, the Iterator global (Safari 26.2, Firefox 144, Chrome 147) — and without them the app
// did not even start (Safari < 18.4: `Iterator` is evaluated on import) or rendered no page; the
// legacy build carries polyfills for exactly these
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { formRects, paintDark, useDarkPages } from './pdfdark';
import { setPref } from '../prefs';
import { contentLayout, inkBox, stepZoom, zoomValue, Pinch, FIT_NAMES, GAP, PAD, PT, WIDTH_SPARE, ZOOMS, type Box, type Fit, type Geo, type Levels, type Zoom } from './pdfzoom';
import { zoomPill } from './zoomhud';
import { zoomTarget, type ZoomStep } from './zoomkeys';
import { canLink, copyPlaceLink, type Place } from '../editor/permalink';
import { showContextMenu } from '../editor/contextmenu';
import { relativeLink } from '@overlyx/core/projectKey.ts';
import { openProjectPath, resolveInDocument } from '../openpath';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();

/**
 * Safari's engine (and every browser on iOS): pdf.js turns decoded images into bitmaps on an
 * OffscreenCanvas in its worker, and in WebKit a page with a JPEG photograph beside a PNG plot showed
 * the plot twice — images decoded without it are right (scratch/browsers/pdfjsimg.mts).
 */
const appleWebKit = typeof navigator !== 'undefined' && /Apple Computer/.test(navigator.vendor);

/**
 * One pdf.js worker for every document this page opens: a worker of its own per document would be
 * started (its script parsed) on every rebuild, which delays the new PDF by most of a second.
 * Created on first use, so a page that replaces `workerSrc` first (the VS Code webview) gets its own.
 */
let sharedWorker: pdfjs.PDFWorker | null = null;
function worker(): pdfjs.PDFWorker | undefined {
  try { return (sharedWorker ??= new pdfjs.PDFWorker({})); } catch { return undefined; }
}

/** A place in the PDF (points from the page's top-left): the box to show, `seq` makes a repeated target scroll again. */
export interface PdfTarget { page: number; x: number; y: number; w?: number; h?: number; seq: number }

interface PageInfo { width: number; height: number }

/** a link on a page: its area (pt from the page's top-left), and an address to open, a file next to the document or a destination in the document */
interface PdfLink { x: number; y: number; w: number; h: number; url?: string; file?: string; dest?: unknown }

/** The links of a page (its Link annotations with a web / mail address, a relative file — pdf.js leaves those in `unsafeUrl` — or a destination). */
async function linksOf(page: PDFPageProxy): Promise<PdfLink[]> {
  const viewport = page.getViewport({ scale: 1 });
  const out: PdfLink[] = [];
  for (const a of await page.getAnnotations({ intent: 'display' }) as { subtype?: string; rect?: number[]; url?: string; unsafeUrl?: string; dest?: unknown }[]) {
    if (a.subtype !== 'Link' || !a.rect) continue;
    const url = typeof a.url === 'string' && /^(https?|mailto):/i.test(a.url) ? a.url : undefined;
    const file = !url && typeof a.unsafeUrl === 'string' ? relativeLink(a.unsafeUrl)?.replace(/[?#].*$/, '') || undefined : undefined;
    if (!url && !file && a.dest == null) continue;
    const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]) as number[], [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]) as number[];
    out.push({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), ...(url ? { url } : file ? { file } : { dest: a.dest }) });
  }
  return out;
}

/** Where a destination points: the page (1-based) and the point of it to show at the top (pt from its top), if it says. */
async function placeOf(d: PDFDocumentProxy, dest: unknown): Promise<{ page: number; y: number | null } | null> {
  const explicit = typeof dest === 'string' ? await d.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || !explicit.length) return null;
  const ref = explicit[0];
  const index = typeof ref === 'number' ? ref : ref && typeof ref === 'object' ? await d.getPageIndex(ref as never) : -1;
  if (!(index >= 0 && index < d.numPages)) return null;
  // [ref, {name: 'XYZ'}, left, top, zoom] / [ref, {name: 'FitH' | 'FitBH'}, top]: the top in PDF space (from the bottom)
  const kind = (explicit[1] as { name?: string } | undefined)?.name;
  const top = kind === 'XYZ' ? explicit[3] : kind === 'FitH' || kind === 'FitBH' ? explicit[2] : null;
  if (typeof top !== 'number') return { page: index + 1, y: null };
  const viewport = (await d.getPage(index + 1)).getViewport({ scale: 1 });
  return { page: index + 1, y: viewport.convertToViewportPoint(0, top)[1] };
}

/** what is drawn on a page's canvas: at which scale, the render under way or `done`, whether coarser than the scale (then with a detail canvas over `rect`, CSS px of the page) */
interface PageState { scale: number; task: RenderTask | null; done?: boolean; coarse?: boolean; detail?: { scale: number; rect: Box; task: RenderTask | null; done?: boolean } }

/** the pixels of one page's canvas at most (as in pdf.js's own viewer; browsers refuse far bigger canvases and draw nothing) */
const MAX_CANVAS_PIXELS = 2 ** 25;
/** a pinch has settled — the pages are drawn at their new size — this long after its last step (ms) */
const SETTLE_MS = 160;
/** a pinch by Ctrl + wheel has ended this long after its last event (ms) */
const PINCH_END_MS = 220;
/** a page is measured for Fit content drawn this big (px, its longer side) */
const MEASURE_PX = 400;
/** the fit chosen last, for the next viewer (this browser's) */
const FIT_KEY = 'ol.pdfFit';

/** what is painted on a page (pt from its top-left), from a small drawing of it; null when nothing is */
async function measureContent(page: PDFPageProxy): Promise<Box | null> {
  const v = page.getViewport({ scale: 1 });
  const k = Math.min(1, MEASURE_PX / Math.max(v.width, v.height));
  const viewport = page.getViewport({ scale: k });
  const c = document.createElement('canvas');
  c.width = Math.ceil(viewport.width); c.height = Math.ceil(viewport.height);
  await page.render({ canvas: c, viewport }).promise;
  const ctx = c.getContext('2d');
  const b = ctx && inkBox(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  c.width = c.height = 0;
  return b ? { x: b.x / k, y: b.y / k, w: b.w / k, h: b.h / k } : null;
}

const sameBox = (a: Box | null | undefined, b: Box | null): boolean =>
  a === b || (!!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5);

/** the place of every page: its top (px from the top of the scrolled pages) */
const topsOf = (geo: Geo[]): number[] => {
  const out: number[] = [];
  let y = PAD;
  for (const g of geo) { out.push(y); y += g.crop.h * g.scale + GAP; }
  return out;
};

export function PdfViewer({ url, target, onSync, toolbar, hint, overlay, withCredentials = true, linkId, place, base }: { url: string; target?: PdfTarget | null; onSync?: (page: number, x: number, y: number) => void; toolbar?: ComponentChildren; hint?: string; overlay?: ComponentChildren; withCredentials?: boolean;
  /** a project's PDF file (its tab id): a right-click on a page copies a link to it (`?page=3`, editor/permalink.ts), and `place` goes to the page such a link names */
  linkId?: string; place?: Place | null;
  /** what the PDF's relative links are relative to (`<project>/<path>`: the document it was built from, the PDF file itself); without it they are left out */
  base?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Fit width, Fit content (past the margins), or a factor on 96 dpi */
  const [zoom, setZoom] = useState<Zoom>(() => { try { return localStorage.getItem(FIT_KEY) === 'content' ? 'content' : 'width'; } catch { return 'width'; } });
  /** a fit's pages stretched a little: a pinch held at the fit pulls at it (pdfzoom.ts GIVE) */
  const [stretch, setStretch] = useState(1);
  /** the pane's inner size (px) */
  const [pane, setPane] = useState({ width: 0, height: 0 });
  const width = pane.width;
  const [current, setCurrent] = useState(1);
  const [flash, setFlash] = useState<{ page: number; x: number; y: number; w: number; h: number } | null>(null);
  /** each page's links (by page number), for the document shown */
  const [links, setLinks] = useState<Map<number, PdfLink[]>>(() => new Map());
  /** where the reader was before following links in the document (Back) */
  const [back, setBack] = useState<{ page: number; y: number }[]>([]);
  /** the zoom said over the pages while it changes */
  const hudEl = useRef<HTMLDivElement>(null);
  const hud = useMemo(() => zoomPill(() => hudEl.current), []);
  const rendered = useRef(new Map<number, PageState>());
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  /** per page, the sharp canvas over the part in view when the page's own canvas is coarse */
  const details = useRef(new Map<number, HTMLCanvasElement>());
  /** the document and colours the canvases are drawn for (a zoom keeps what is drawn till it is drawn anew) */
  const drawnFor = useRef<{ doc: PDFDocumentProxy | null; dark: string }>({ doc: null, dark: '' });
  /** what is painted on each page (pt), by page number: kept through a rebuild, till measured anew */
  const boxes = useRef(new Map<number, Box | null>());
  const [boxesVer, setBoxesVer] = useState(0);
  /** the pages to measure, the one read first (set by the drawing of the pages in reach) */
  const wantBoxes = useRef<(ns: number[]) => void>(() => {});
  /** a zoom waiting for the next frame: what to show, and the point of the screen it is about */
  const pendingZoom = useRef<{ zoom: Zoom; stretch: number; x: number; y: number } | null>(null);
  /** the zoom shown (ahead of a render) */
  const zoomNow = useRef<Zoom>(zoom);
  /** the spot of a page (fractions of it) that stays under the point (x, y) while the new zoom lays out */
  const zoomAnchor = useRef<{ page: number; fx: number; fy: number; x: number; y: number } | null>(null);
  /** when the zoom last changed by a pinch (drawing waits until it settles) */
  const zoomedAt = useRef(0);
  /** the pinch under way (Ctrl + wheel, Safari's gesture): its course through the levels, the pointer, the timer that ends it */
  const gesture = useRef<{ pinch: Pinch; x: number; y: number; timer: number } | null>(null);
  /** the frame of a spring back onto a fit */
  const springRaf = useRef(0);
  /** dark pages (pdfdark.ts): baked into the canvases when they are drawn, so a change draws the pages again */
  const { colours, themeDark, invertFigures } = useDarkPages();
  const dark = !!colours;
  const darkKey = colours ? JSON.stringify(colours) + (invertFigures ? '' : ' all') : '';
  const darkRef = useRef({ colours, invertFigures });
  darkRef.current = { colours, invertFigures };
  /** the document shown and its loading task (destroyed when replaced, after the new one is up) */
  const shownTask = useRef<PDFDocumentLoadingTask | null>(null);
  const retired = useRef<PDFDocumentLoadingTask[]>([]);
  /** where the reader was when the pages change size (a new document; Fit content's pages measured): page index and the point of it at the viewport's top (pt from its top) */
  const anchor = useRef<{ page: number; y: number } | null>(null);

  const widthScale = (p: PageInfo) => Math.max(0.2, (width - WIDTH_SPARE) / p.width);
  // Fit content: the pages cropped to what is painted on them (pdfzoom.ts)
  const content = useMemo(() => (pages.length && width ? contentLayout(pages, pages.map((_, i) => boxes.current.get(i + 1)), pane) : null), [pages, width, pane.height, boxesVer]);
  const levels: Levels = pages.length && width ? { width: widthScale(pages[0]) / PT, content: (content?.scale ?? content?.geo[0]?.scale ?? 0) / PT || undefined } : {};
  /** every page's scale (px per pt) and the part of it shown */
  const geo = useMemo<Geo[]>(() => pages.map((p, i) => {
    if (zoom === 'content' && content) return { scale: content.geo[i].scale * stretch, crop: content.geo[i].crop };
    // (Fit content before the pane's size is known: as Fit width)
    return { scale: typeof zoom === 'string' ? widthScale(p) * stretch : zoom * PT, crop: { x: 0, y: 0, w: p.width, h: p.height } };
  }), [pages, zoom, stretch, content, width]);
  const tops = useMemo(() => topsOf(geo), [geo]);
  const layoutRef = useRef({ geo, tops, zoom, levels });
  layoutRef.current = { geo, tops, zoom, levels };

  /** the page at the viewport's top and the point of it there (pt from the page's top) */
  const readAnchor = (): { page: number; y: number } | null => {
    const el = host.current;
    const { geo: g, tops: t } = layoutRef.current;
    if (!el || !g.length) return null;
    for (let i = 0; i < g.length; i++) {
      if (t[i] + g[i].crop.h * g[i].scale + GAP > el.scrollTop || i === g.length - 1) return { page: i, y: g[i].crop.y + (el.scrollTop - t[i]) / g[i].scale };
    }
    return null;
  };

  // load the document; the old one stays on screen until the new one is ready
  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ url, withCredentials, worker: worker(), ...(appleWebKit ? { isOffscreenCanvasSupported: false } : {}) });
    task.promise.then(async d => {
      if (cancelled) return;
      const infos: PageInfo[] = [];
      for (let i = 1; i <= d.numPages; i++) { const p = await d.getPage(i); const v = p.getViewport({ scale: 1 }); infos.push({ width: v.width, height: v.height }); }
      if (cancelled) return;
      anchor.current = readAnchor();
      if (shownTask.current) retired.current.push(shownTask.current);
      shownTask.current = task;
      setError(null);
      setDoc(d);
      setPages(infos);
    }).catch(e => { if (!cancelled) setError(String((e as Error).message ?? e)); });
    // a URL replaced before its document arrived is dropped; the shown one lives until its successor is up
    return () => { cancelled = true; if (shownTask.current !== task) void task.destroy(); };
  }, [url, withCredentials]);
  useEffect(() => () => {
    for (const s of rendered.current.values()) s.task?.cancel();
    for (const t of retired.current) void t.destroy();
    void shownTask.current?.destroy();
    hud.dispose();
    cancelAnimationFrame(springRaf.current);
    if (gesture.current) clearTimeout(gesture.current.timer);
  }, []);

  // the pane's size (the fits) and the visible page
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setPane(p => (p.width === el.clientWidth && p.height === el.clientHeight ? p : { width: el.clientWidth, height: el.clientHeight }));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // the links of the document shown (after its pages are up: a rebuilt PDF is not held back for them)
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    setLinks(new Map());
    void (async () => {
      const found = new Map<number, PdfLink[]>();
      for (let n = 1; n <= doc.numPages && !cancelled; n++) {
        try { const l = await linksOf(await doc.getPage(n)); if (l.length) found.set(n, l); } catch { /* a page without readable annotations */ }
      }
      if (!cancelled) setLinks(found);
    })();
    return () => { cancelled = true; };
  }, [doc]);

  /** Show a point of a page (pt from its top) at the top of the pane; `from`: remember where the reader was, for Back. */
  const showPlace = (page: number, y: number | null, from?: { page: number; y: number } | null) => {
    const el = host.current;
    const { geo: g, tops: t } = layoutRef.current;
    if (!el || page < 1 || page > g.length) return;
    if (from) setBack(b => [...b.slice(-19), from]);
    const i = page - 1;
    el.scrollTo({ top: Math.max(0, y === null ? t[i] - PAD : t[i] + (y - g[i].crop.y) * g[i].scale - 24) });
  };
  const follow = async (dest: unknown) => {
    if (!doc) return;
    const from = readAnchor();
    const place = await placeOf(doc, dest).catch(() => null);
    if (place) showPlace(place.page, place.y, from && { page: from.page + 1, y: from.y });
  };
  const goBack = () => {
    const last = back[back.length - 1];
    if (!last) return;
    setBack(back.slice(0, -1));
    showPlace(last.page, last.y);
  };

  // what is painted on the pages (Fit content, and where it lies among the levels): measured small in
  // idle moments, the page read first, then the others in reach
  useEffect(() => {
    if (!doc) return;
    let disposed = false, busy = false, raf = 0;
    let queue: number[] = [];
    const fresh = new Set<number>();
    const changed = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // the pages past the margins change size: the reader stays at the same place
        if (layoutRef.current.zoom === 'content' && !anchor.current) anchor.current = readAnchor();
        setBoxesVer(v => v + 1);
      });
    };
    const next = () => {
      if (disposed || busy) return;
      const n = queue.find(k => !fresh.has(k) && k <= doc.numPages);
      if (n === undefined) return;
      busy = true;
      const run = async () => {
        try {
          const box = await measureContent(await doc.getPage(n));
          if (!disposed && !sameBox(boxes.current.get(n), box)) { boxes.current.set(n, box); changed(); }
        } catch { /* (a page that cannot be drawn keeps the typical crop) */ }
        fresh.add(n);
        busy = false;
        next();
      };
      const w = window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
      if (w.requestIdleCallback) w.requestIdleCallback(() => void run(), { timeout: 400 });
      else setTimeout(() => void run(), 30);
    };
    wantBoxes.current = ns => { queue = ns; next(); };
    return () => { disposed = true; cancelAnimationFrame(raf); wantBoxes.current = () => {}; };
  }, [doc]);

  /** shown next frame: a zoom (a fit's pages stretched by `stretch`) about the point (x, y) of the screen — the spot of the page under it stays there */
  const request = (z: Zoom, stretch: number, x: number, y: number) => {
    const first = !pendingZoom.current;
    pendingZoom.current = { zoom: z, stretch, x, y };
    if (first) requestAnimationFrame(applyZoom);
  };
  const applyZoom = () => {
    const p = pendingZoom.current, el = host.current;
    pendingZoom.current = null;
    if (!p || !el) return;
    // the page under the point (or the nearest) keeps the same spot under it
    let best = Infinity;
    for (const box of el.querySelectorAll<HTMLElement>('.pdf-page-box')) {
      const r = box.getBoundingClientRect();
      const d = p.y < r.top ? r.top - p.y : p.y > r.bottom ? p.y - r.bottom : 0;
      if (d < best) {
        best = d;
        const sr = (box.firstElementChild as HTMLElement).getBoundingClientRect();
        zoomAnchor.current = { page: Number(box.dataset.page), fx: (p.x - sr.left) / sr.width, fy: (p.y - sr.top) / sr.height, x: p.x, y: p.y };
      }
      if (d === 0) break;
    }
    zoomedAt.current = performance.now();
    zoomNow.current = p.zoom;
    setZoom(p.zoom);
    setStretch(p.stretch);
    hud.show(zoomValue(p.zoom, layoutRef.current.levels), typeof p.zoom === 'string' ? FIT_NAMES[p.zoom] : null);
  };
  /** the fit chosen last is the next viewer's */
  const remember = (z: Zoom) => { if (typeof z === 'string') try { localStorage.setItem(FIT_KEY, z); } catch { /* storage unavailable */ } };
  const middle = () => { const r = host.current?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 }; };
  const springStop = () => { cancelAnimationFrame(springRaf.current); springRaf.current = 0; };
  /** a fit's pages spring back from `from` to their size */
  const springTo = (z: Fit, from: number, x: number, y: number) => {
    springStop();
    const t0 = performance.now();
    const frame = () => {
      const t = Math.min(1, (performance.now() - t0) / 220), k = 1 - (1 - t) ** 3;
      request(z, from + (1 - from) * k, x, y);
      springRaf.current = t < 1 ? requestAnimationFrame(frame) : 0;
    };
    frame();
  };
  /** a step in or out (−, +, a mouse wheel's notch): the steps and the fits in one order; about a point of the screen (the pane's middle) */
  const step = (dir: 1 | -1, x?: number, y?: number) => {
    const l = layoutRef.current.levels;
    if (!l.width) return;
    springStop();
    const m = middle();
    const z = stepZoom(zoomValue(pendingZoom.current?.zoom ?? zoomNow.current, l), dir, l);
    remember(z);
    request(z, 1, x ?? m.x, y ?? m.y);
  };
  /** a zoom chosen from the menu */
  const choose = (z: Zoom) => { springStop(); remember(z); const m = middle(); request(z, 1, m.x, m.y); };
  // Ctrl/⌘ + − once the PDF was pressed on, or is all there is (app/zoomkeys.ts): a step; 0: Fit width
  const keyZoom = useRef<(d: ZoomStep) => void>(() => {});
  keyZoom.current = d => { if (d === 0) choose('width'); else step(d); };
  useEffect(() => { const el = host.current?.closest<HTMLElement>('.pdf-viewer'); return el ? zoomTarget(el, d => keyZoom.current(d)) : undefined; }, []);
  /** a pinch's step (log of the factor) about the pointer: on through the levels, stopping at the fits (pdfzoom.ts Pinch) */
  const pinchBy = (d: number, x: number, y: number, timed: boolean) => {
    springStop();
    let g = gesture.current;
    if (!g) g = gesture.current = { pinch: new Pinch(pendingZoom.current?.zoom ?? zoomNow.current, layoutRef.current.levels), x, y, timer: 0 };
    g.x = x; g.y = y;
    clearTimeout(g.timer);
    if (timed) g.timer = window.setTimeout(endPinch, PINCH_END_MS);
    const shown = g.pinch.by(d, layoutRef.current.levels);
    request(shown.zoom, shown.stretch, x, y);
  };
  /** the pinch let go: held at a fit, or near one, it springs onto it */
  const endPinch = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    clearTimeout(g.timer);
    const s = g.pinch.end(layoutRef.current.levels);
    if (!s) return;
    remember(s.zoom);
    springTo(s.zoom, s.from, g.x, g.y);
  };

  // a pinch on a trackpad (Ctrl + wheel; Safari's gesture events) or with two fingers, or a mouse wheel's notches with Ctrl/⌘
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (!dy) return;
      // a mouse wheel's notch (lines, or a hundred px or so at once): a step, as the browser's own zoom
      // takes; a trackpad sends many small deltas — a pinch, through the levels
      if (e.deltaMode !== 0 || Math.abs(dy) >= 50) { if (!gesture.current) step(dy < 0 ? 1 : -1, e.clientX, e.clientY); return; }
      pinchBy(-dy * 0.01, e.clientX, e.clientY, true);
    };
    // two fingers on a touch screen (an iPad, a phone): the viewer's pinch, not the browser's — about
    // their middle, which pans the pages as it moves; one finger scrolls as ever
    let touch: { d: number; x: number; y: number } | null = null;
    const two = (t: TouchList) => ({ d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const onTouch = (e: TouchEvent) => {
      if (e.type === 'touchstart') {
        if (e.touches.length === 2) { e.preventDefault(); touch = two(e.touches); }
        return;
      }
      if (e.type === 'touchmove') {
        if (!touch || e.touches.length < 2) return;
        e.preventDefault();
        const now = two(e.touches);
        el.scrollLeft -= now.x - touch.x;
        el.scrollTop -= now.y - touch.y;
        if (now.d > 0 && touch.d > 0 && now.d !== touch.d) pinchBy(Math.log(now.d / touch.d), now.x, now.y, false);
        touch = now;
        return;
      }
      if (touch && e.touches.length < 2) { touch = null; endPinch(); }
    };
    // Safari's trackpad pinch: its scale is from where the pinch began (on an iPad the fingers' touches are the measure)
    let last = 1;
    const onGesture = (e: Event & { scale?: number; clientX?: number; clientY?: number }) => {
      e.preventDefault();
      if (touch) return;
      if (e.type === 'gestureend') { endPinch(); return; }
      if (e.type === 'gesturestart') { last = 1; return; }
      const s = e.scale ?? 1;
      if (!(s > 0)) return;
      const r = el.getBoundingClientRect();
      pinchBy(Math.log(s / last), e.clientX ?? r.left + r.width / 2, e.clientY ?? r.top + r.height / 2, false);
      last = s;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) el.addEventListener(t, onGesture as EventListener, { passive: false });
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) el.addEventListener(t, onTouch as EventListener, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      for (const t of ['gesturestart', 'gesturechange', 'gestureend']) el.removeEventListener(t, onGesture as EventListener);
      for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) el.removeEventListener(t, onTouch as EventListener);
    };
  }, []);

  // a zoom laid out: scroll so that the spot of the page is under the point again (before the paint)
  useLayoutEffect(() => {
    const el = host.current, a = zoomAnchor.current;
    zoomAnchor.current = null;
    const sheet = a && el?.querySelector<HTMLElement>(`.pdf-page-box[data-page="${a.page}"] > .pdf-sheet`);
    if (!el || !a || !sheet) return;
    const r = sheet.getBoundingClientRect();
    el.scrollLeft += r.left + a.fx * r.width - a.x;
    el.scrollTop += r.top + a.fy * r.height - a.y;
  }, [zoom, stretch]);

  // a new document, Fit content's pages measured: back to the same page, the same point of it at the top (before the paint)
  useLayoutEffect(() => {
    const el = host.current, a = anchor.current;
    if (!el || !a || !geo.length || !width) return;
    anchor.current = null;
    const i = Math.min(a.page, geo.length - 1);
    const top = Math.round(tops[i] + (a.y - geo[i].crop.y) * geo[i].scale);
    if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
  }, [pages, boxesVer]);

  // render the pages that are (nearly) visible, at the current scale — off-screen, then copied in one step
  useEffect(() => {
    const el = host.current;
    if (!el || !doc || !pages.length || !width) return;
    // the documents this one replaced can go now (their renders were cancelled with the previous run)
    for (const t of retired.current.splice(0)) void t.destroy();
    // another document, other colours: everything is drawn anew
    if (drawnFor.current.doc !== doc || drawnFor.current.dark !== darkKey) {
      for (const s of rendered.current.values()) { s.task?.cancel(); s.detail?.task?.cancel(); }
      rendered.current.clear();
      drawnFor.current = { doc, dark: darkKey };
    }
    let disposed = false;
    const renderVisible = () => {
      if (disposed) return;
      const top = el.scrollTop - el.clientHeight, bottom = el.scrollTop + 2 * el.clientHeight;
      let cur = 1, best = Infinity;
      const near: number[] = [];
      geo.forEach((g, i) => {
        const y = tops[i], h = g.crop.h * g.scale + GAP;
        const d = Math.abs(y + h / 2 - (el.scrollTop + el.clientHeight / 3));
        if (d < best) { best = d; cur = i + 1; }
        if (y + h >= top && y <= bottom) { near.push(i + 1); void renderPage(i + 1, g.scale); }
      });
      setCurrent(cur);
      wantBoxes.current(near.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur)));
    };
    /** the part of a coarse page in view (and half a window around it), drawn sharp on the page's detail canvas */
    const renderDetail = async (n: number, scale: number) => {
      const canvas = details.current.get(n), box = canvas?.parentElement;
      const state = rendered.current.get(n);
      if (!canvas || !box || !state || state.scale !== scale || state.task || !state.coarse) return;
      const hr = el.getBoundingClientRect(), br = box.getBoundingClientRect();
      const vis = { l: hr.left - br.left, t: hr.top - br.top, r: hr.right - br.left, b: hr.bottom - br.top };
      if (vis.r <= 0 || vis.b <= 0 || vis.l >= br.width || vis.t >= br.height) return;
      // still covered by the detail drawn (or being drawn) at this scale
      const d = state.detail;
      if (d && d.scale === scale && d.rect.x <= Math.max(0, vis.l) && d.rect.y <= Math.max(0, vis.t) && d.rect.x + d.rect.w >= Math.min(br.width, vis.r) && d.rect.y + d.rect.h >= Math.min(br.height, vis.b)) return;
      d?.task?.cancel();
      const mx = hr.width / 2, my = hr.height / 2;
      const x = Math.max(0, Math.floor(vis.l - mx)), y = Math.max(0, Math.floor(vis.t - my));
      const rect = { x, y, w: Math.min(Math.ceil(br.width), Math.ceil(vis.r + mx)) - x, h: Math.min(Math.ceil(br.height), Math.ceil(vis.b + my)) - y };
      const detail: NonNullable<PageState['detail']> = { scale, rect, task: null };
      state.detail = detail;
      try {
        const page = await doc.getPage(n);
        if (disposed || state.detail !== detail) return;
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr, offsetX: -rect.x * dpr, offsetY: -rect.y * dpr });
        const off = document.createElement('canvas');
        off.width = Math.ceil(rect.w * dpr); off.height = Math.ceil(rect.h * dpr);
        const task = page.render({ canvas: off, viewport });
        detail.task = task;
        const ops = darkRef.current.colours ? page.getOperatorList().catch(() => null) : null;
        await task.promise;
        const figures = ops ? formRects(await ops, viewport.transform, off.width, off.height) : [];
        if (disposed || state.detail !== detail) return;
        detail.task = null;
        detail.done = true;
        canvas.width = off.width; canvas.height = off.height;
        // placed in fractions of the page, so that a pinch stretches it with the page
        const W = br.width, H = br.height;
        Object.assign(canvas.style, { left: `${rect.x / W * 100}%`, top: `${rect.y / H * 100}%`, width: `${rect.w / W * 100}%`, height: `${rect.h / H * 100}%` });
        const ctx = canvas.getContext('2d');
        const { colours: dc, invertFigures: smart } = darkRef.current;
        if (ctx && dc) {
          // the photographs pdf.js found on its first drawing of the page, as fractions of that (whole-page) canvas
          const full = (page as unknown as { imageCoordinates?: ArrayLike<number> | null }).imageCoordinates;
          const coords = full && Array.from(full, (v, i) => i % 2 === 0 ? (v * W - rect.x) / rect.w : (v * H - rect.y) / rect.h);
          paintDark(ctx, off, dc, coords, !smart, figures);
        } else ctx?.drawImage(off, 0, 0);
        canvas.classList.add('ready');
      } catch {
        if (state.detail === detail) state.detail = undefined;
      }
    };
    const renderPage = async (n: number, scale: number) => {
      const canvas = canvases.current.get(n);
      if (!canvas) return;
      const state = rendered.current.get(n);
      if (state && state.scale === scale) { if (!state.task) void renderDetail(n, scale); return; }
      state?.task?.cancel();
      state?.detail?.task?.cancel();
      const claim: PageState = { scale, task: null };
      rendered.current.set(n, claim);   // claimed: a second pass must not start the same render
      try {
        const page = await doc.getPage(n);
        if (disposed) return;
        const dpr = window.devicePixelRatio || 1;
        // no bigger than MAX_CANVAS_PIXELS: a huge page is drawn coarser, and sharp where it is in view
        const base = page.getViewport({ scale: scale * dpr });
        const k = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / ((base.width + 1) * (base.height + 1))));   // (+1: the canvas is rounded up)
        claim.coarse = k < 1;
        const viewport = k < 1 ? page.getViewport({ scale: scale * dpr * k }) : base;
        const off = document.createElement('canvas');
        off.width = Math.ceil(viewport.width); off.height = Math.ceil(viewport.height);
        // recordImages: where the raster images went (pdf.js keeps them on the page, as fractions of the canvas), for the dark pages' photographs
        const task = page.render({ canvas: off, viewport, recordImages: true });
        claim.task = task;
        // dark pages: where the included figures went (the drawing commands, from the worker alongside the rendering)
        const ops = darkRef.current.colours ? page.getOperatorList().catch(() => null) : null;
        await task.promise;
        const figures = ops ? formRects(await ops, viewport.transform, off.width, off.height) : [];
        if (disposed || rendered.current.get(n)?.task !== task) return;
        claim.task = null;
        claim.done = true;
        // resizing clears a canvas: size it and draw the finished page in the same task, so the old picture never blanks
        canvas.width = off.width; canvas.height = off.height;
        const ctx = canvas.getContext('2d');
        const { colours: dc, invertFigures: smart } = darkRef.current;
        if (ctx && dc) paintDark(ctx, off, dc, (page as unknown as { imageCoordinates?: ArrayLike<number> | null }).imageCoordinates, !smart, figures);
        else ctx?.drawImage(off, 0, 0);
        canvas.classList.add('ready');
        if (claim.coarse) void renderDetail(n, scale);
        else details.current.get(n)?.classList.remove('ready');
      } catch {
        if (rendered.current.get(n) === claim) rendered.current.delete(n);   // cancelled, or the document was replaced meanwhile
      }
    };
    // drawn now, or once a pinch has settled (meanwhile the drawn pages stretch)
    let raf = 0, timer = 0;
    const schedule = () => {
      cancelAnimationFrame(raf); clearTimeout(timer);
      const wait = zoomedAt.current + SETTLE_MS - performance.now();
      if (wait > 0) timer = window.setTimeout(schedule, wait);
      else raf = requestAnimationFrame(renderVisible);
    };
    if (zoomedAt.current + SETTLE_MS > performance.now()) schedule(); else renderVisible();
    el.addEventListener('scroll', schedule);
    return () => {
      disposed = true; el.removeEventListener('scroll', schedule); cancelAnimationFrame(raf); clearTimeout(timer);
      // drawings under way are given up (begun anew at the new size); what is drawn stays (a pinch let go where it began draws nothing)
      for (const [n, s] of rendered.current) {
        if (!s.done) { s.task?.cancel(); rendered.current.delete(n); }
        else if (s.detail && !s.detail.done) { s.detail.task?.cancel(); s.detail = undefined; }
      }
    };
  }, [doc, geo, darkKey]);

  // forward search: scroll the target box into view and flash it
  useEffect(() => {
    const el = host.current;
    if (!el || !target || !pages.length || target.page < 1 || target.page > pages.length) return;
    const { geo: g, tops: t } = layoutRef.current;
    const i = target.page - 1;
    el.scrollTo({ top: Math.max(0, t[i] + (target.y - g[i].crop.y) * g[i].scale - el.clientHeight / 3), behavior: 'smooth' });
    setFlash({ page: target.page, x: target.x, y: target.y, w: target.w ?? 200, h: target.h ?? 12 });
    const timer = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(timer);
  }, [target?.seq, pages, width > 0]);

  const gotoPage = (n: number) => {
    const el = host.current;
    if (!el || !pages.length) return;
    n = Math.max(1, Math.min(pages.length, n));
    el.scrollTo({ top: tops[n - 1] - PAD });
  };
  // a link's page (once the pages are laid out)
  useEffect(() => { if (place?.page && pages.length && width > 0) gotoPage(place.page); }, [place, pages.length, width > 0]);
  const pageMenu = (n: number) => (e: MouseEvent) => {
    if (!linkId || e.shiftKey || !canLink(linkId)) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: `Copy link to page ${n}`, icon: 'link', action: () => copyPlaceLink(linkId, { page: n }, `page ${n}`) },
      { label: (navigator.platform.includes('Mac') ? '⇧' : 'Shift+') + 'right-click: the browser menu', info: true },
    ]);
  };

  const shownZoom = zoomValue(zoom, levels);
  const zoomPick = typeof zoom === 'string' ? zoom : ZOOMS.includes(zoom) ? String(zoom) : 'custom';
  return (
    <div class={'pdf-viewer' + (dark ? ' dark-pages' : '')}>
      <div class="pdf-toolbar">
        <button class="small-btn" title="Previous page" onClick={() => gotoPage(current - 1)}>‹</button>
        <input class="pdf-page" type="number" min={1} max={pages.length || 1} value={current} onChange={e => gotoPage(Number((e.target as HTMLInputElement).value))} title="Page" />
        <span class="pdf-count">/ {pages.length || '–'}</span>
        <button class="small-btn" title="Next page" onClick={() => gotoPage(current + 1)}>›</button>
        <span class="pdf-sep" />
        <button class="small-btn" title="Zoom out" onClick={() => step(-1)}>−</button>
        <select class="pdf-zoom" data-pdf-zoom value={zoomPick} onChange={e => { const v = (e.target as HTMLSelectElement).value; if (v !== 'custom') choose(v in FIT_NAMES ? v as Fit : Number(v)); }}
          title={`Zoom (${Math.round(shownZoom * 100)} %). Fit content zooms past the margins: what is printed on the pages, as big as the pane takes it. A pinch stops at Fit width and Fit content.`}>
          <option value="width">{FIT_NAMES.width}</option>
          <option value="content">{FIT_NAMES.content}</option>
          {zoomPick === 'custom' && <option value="custom">{Math.round(shownZoom * 100)}%</option>}
          {ZOOMS.map(z => <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>)}
        </select>
        <button class="small-btn" title="Zoom in" onClick={() => step(1)}>+</button>
        {back.length > 0 && <button class="small-btn" data-pdf-back title="Back to where you were before following a link" onClick={goBack}>↩ Back</button>}
        {themeDark && <button class={'small-btn pdf-dark-toggle' + (dark ? ' active' : '')} data-pdf-dark aria-pressed={dark} onClick={() => setPref('darkPages', !dark)}
          title={dark ? 'Smart invert: the pages light on dark, photographs in their colours — documents, PDFs and slides alike. Click for their own colours' : 'The pages’ own colours — click to smart-invert them (documents, PDFs and slides alike)'}>◐</button>}
        {toolbar && <span class="pdf-sep" />}
        {toolbar}
        {hint && <span class="pdf-hint">{hint}</span>}
      </div>
      <div class="pdf-stage">
        {overlay}
        <div ref={hudEl} class="zoom-hud" aria-hidden="true" data-pdf-zoomhud />
        <div class={'pdf-pages' + (typeof zoom === 'string' ? ' fitted' : '')} ref={host} data-zoom={typeof zoom === 'string' ? zoom : undefined}>
          {error && <div class="pdf-error">Could not open the PDF: {error}</div>}
          {pages.map((p, i) => {
            const g = geo[i], s = g.scale, n = i + 1;
            return (
              <div key={n} class="pdf-page-box" style={{ width: `${g.crop.w * s}px`, height: `${g.crop.h * s}px` }} data-page={n} onContextMenu={pageMenu(n)}
                onDblClick={e => { if (!onSync) return; const r = ((e.currentTarget as HTMLElement).firstElementChild as HTMLElement).getBoundingClientRect(); onSync(n, (e.clientX - r.left) / s, (e.clientY - r.top) / s); }}>
                {/* the whole page; the box shows the part of it in `crop` (Fit content: what is painted on it) */}
                <div class="pdf-sheet" style={{ width: `${p.width * s}px`, height: `${p.height * s}px`, left: `${-g.crop.x * s}px`, top: `${-g.crop.y * s}px` }}>
                  <canvas ref={c => { if (c) canvases.current.set(n, c); else canvases.current.delete(n); }} />
                  <canvas class="pdf-detail" ref={c => { if (c) details.current.set(n, c); else details.current.delete(n); }} />
                  {links.get(n)?.map((l, k) => {
                    const file = l.file && base ? resolveInDocument(base, l.file) : null;
                    if (l.file && !file) return null;
                    return <a key={k} class="pdf-link" style={{ left: `${l.x * s}px`, top: `${l.y * s}px`, width: `${l.w * s}px`, height: `${l.h * s}px` }}
                      {...(l.url ? { href: l.url, target: '_blank', rel: 'noopener noreferrer', title: l.url }
                        : file ? { href: '#', title: 'Open ' + file.path, onClick: (e: MouseEvent) => { e.preventDefault(); openProjectPath(file.project, file.path); } }
                        : { href: '#', onClick: (e: MouseEvent) => { e.preventDefault(); void follow(l.dest); } })} />;
                  })}
                  {flash && flash.page === n && <div class="pdf-flash" style={{ left: `${flash.x * s - 4}px`, top: `${flash.y * s - 3}px`, width: `${Math.max(24, flash.w * s + 8)}px`, height: `${flash.h * s + 6}px` }} />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
