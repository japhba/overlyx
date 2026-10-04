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
 * `busy` draws a thin progress line along the top; `overlay` floats over the pages.
 *
 * Zoom: the toolbar's steps, or a pinch on a trackpad (Ctrl + wheel in Chromium and Firefox, the
 * gesture events in Safari) and Ctrl/⌘ + wheel about the pointer. While a pinch goes on the drawn
 * pages are stretched; they are drawn anew once it settles. A page whose canvas would exceed
 * MAX_CANVAS_PIXELS (an A0 poster zoomed in) is drawn coarser, with a sharp detail canvas over the
 * part of it in view.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
// pdf.js's legacy build: the default ("modern") one needs the newest engines — Map.getOrInsertComputed,
// Math.sumPrecise, the Iterator global (Safari 26.2, Firefox 144, Chrome 147) — and without them the app
// did not even start (Safari < 18.4: `Iterator` is evaluated on import) or rendered no page; the
// legacy build carries polyfills for exactly these
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { formRects, paintDark, useDarkPages } from './pdfdark';
import { setPref } from '../prefs';

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

/** a rectangle of a page box, in CSS pixels */
interface BoxRect { x: number; y: number; w: number; h: number }
/** what is drawn on a page's canvas: at which scale, the render under way, whether coarser than the scale (then with a detail canvas) */
interface PageState { scale: number; task: RenderTask | null; coarse?: boolean; detail?: { scale: number; rect: BoxRect; task: RenderTask | null } }

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
/** the zoom range a pinch can reach */
const MIN_ZOOM = 0.25, MAX_ZOOM = 8;
/** the pixels of one page's canvas at most (as in pdf.js's own viewer; browsers refuse far bigger canvases and draw nothing) */
const MAX_CANVAS_PIXELS = 2 ** 25;
/** a pinch has settled — the pages are drawn at their new size — this long after its last step (ms) */
const SETTLE_MS = 160;
/** vertical gap below every page (px, styles.css .pdf-page-box margin) */
const GAP = 12;
/** padding above the first page (styles.css .pdf-pages) */
const PAD = 12;

export function PdfViewer({ url, target, onSync, toolbar, hint, busy, overlay }: { url: string; target?: PdfTarget | null; onSync?: (page: number, x: number, y: number) => void; toolbar?: ComponentChildren; hint?: string; busy?: boolean; overlay?: ComponentChildren }) {
  const host = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 'width' fits the page to the panel; a number is a zoom factor on 96 dpi */
  const [zoom, setZoom] = useState<'width' | number>('width');
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const [flash, setFlash] = useState<{ page: number; x: number; y: number; w: number; h: number } | null>(null);
  const rendered = useRef(new Map<number, PageState>());
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  /** per page, the sharp canvas over the part in view when the page's own canvas is coarse */
  const details = useRef(new Map<number, HTMLCanvasElement>());
  /** a pinch step waiting for the next frame: the zoom asked for and the pointer */
  const pendingZoom = useRef<{ z: number; x: number; y: number } | null>(null);
  /** the spot of a page (fractions of it) that stays under the pointer (x, y) while the new zoom lays out */
  const zoomAnchor = useRef<{ page: number; fx: number; fy: number; x: number; y: number } | null>(null);
  /** when the zoom last changed by a pinch (drawing waits until it settles) */
  const zoomedAt = useRef(0);
  /** dark pages (pdfdark.ts): baked into the canvases when they are drawn, so a change draws the pages again */
  const { colours, themeDark, invertFigures } = useDarkPages();
  const dark = !!colours;
  const darkKey = colours ? JSON.stringify(colours) + (invertFigures ? '' : ' all') : '';
  const darkRef = useRef({ colours, invertFigures });
  darkRef.current = { colours, invertFigures };
  /** the document shown and its loading task (destroyed when replaced, after the new one is up) */
  const shownTask = useRef<PDFDocumentLoadingTask | null>(null);
  const retired = useRef<PDFDocumentLoadingTask[]>([]);
  /** where the reader was when a new document came in: page index and how far into it the viewport's top is */
  const anchor = useRef<{ page: number; frac: number } | null>(null);
  const layoutRef = useRef<{ pages: PageInfo[]; scaleFor: (p: PageInfo) => number }>({ pages: [], scaleFor: () => 1 });

  const scaleFor = (p: PageInfo) => (zoom === 'width' ? Math.max(0.2, (width - 28) / p.width) : zoom * (96 / 72));
  layoutRef.current = { pages, scaleFor };

  /** the page at the viewport's top and the fraction of it above the top edge */
  const readAnchor = (): { page: number; frac: number } | null => {
    const el = host.current;
    const { pages: ps, scaleFor: sf } = layoutRef.current;
    if (!el || !ps.length) return null;
    let y = PAD;
    for (let i = 0; i < ps.length; i++) {
      const h = ps[i].height * sf(ps[i]) + GAP;
      if (y + h > el.scrollTop || i === ps.length - 1) return { page: i, frac: Math.max(0, Math.min(1, (el.scrollTop - y) / h)) };
      y += h;
    }
    return null;
  };

  // load the document; the old one stays on screen until the new one is ready
  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ url, withCredentials: true, worker: worker(), ...(appleWebKit ? { isOffscreenCanvasSupported: false } : {}) });
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
  }, [url]);
  useEffect(() => () => {
    for (const s of rendered.current.values()) s.task?.cancel();
    for (const t of retired.current) void t.destroy();
    void shownTask.current?.destroy();
  }, []);

  // the panel's width (fit-to-width) and the visible page
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // a pinch on a trackpad, or Ctrl/⌘ + wheel: zoom about the pointer (one step per frame)
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const shown = () => { const { pages: ps, scaleFor: sf } = layoutRef.current; return ps.length ? sf(ps[0]) / (96 / 72) : 1; };
    const apply = () => {
      const p = pendingZoom.current;
      pendingZoom.current = null;
      if (!p) return;
      // the page under the pointer (or the nearest) keeps the same spot under it
      let best = Infinity;
      for (const box of el.querySelectorAll<HTMLElement>('.pdf-page-box')) {
        const r = box.getBoundingClientRect();
        const d = p.y < r.top ? r.top - p.y : p.y > r.bottom ? p.y - r.bottom : 0;
        if (d < best) { best = d; zoomAnchor.current = { page: Number(box.dataset.page), fx: (p.x - r.left) / r.width, fy: (p.y - r.top) / r.height, x: p.x, y: p.y }; }
        if (d === 0) break;
      }
      zoomedAt.current = performance.now();
      setZoom(p.z);
    };
    const zoomAt = (z: number, x: number, y: number) => {
      const first = !pendingZoom.current;
      pendingZoom.current = { z: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)), x, y };
      if (first) requestAnimationFrame(apply);
    };
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      // a trackpad sends many small deltas, a mouse wheel ±100 a notch (×1.28 then)
      zoomAt((pendingZoom.current?.z ?? shown()) * Math.exp(-Math.max(-25, Math.min(25, dy)) * 0.01), e.clientX, e.clientY);
    };
    // Safari's trackpad pinch
    let gestureBase = 1;
    const onGesture = (e: Event & { scale?: number; clientX?: number; clientY?: number }) => {
      e.preventDefault();
      if (e.type === 'gesturestart') { gestureBase = shown(); return; }
      const r = el.getBoundingClientRect();
      zoomAt(gestureBase * (e.scale ?? 1), e.clientX ?? r.left + r.width / 2, e.clientY ?? r.top + r.height / 2);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGesture as EventListener, { passive: false });
    el.addEventListener('gesturechange', onGesture as EventListener, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGesture as EventListener);
      el.removeEventListener('gesturechange', onGesture as EventListener);
    };
  }, []);

  // a pinch step laid out: scroll so that the spot of the page is under the pointer again (before the paint)
  useLayoutEffect(() => {
    const el = host.current, a = zoomAnchor.current;
    zoomAnchor.current = null;
    const box = a && el?.querySelector<HTMLElement>(`.pdf-page-box[data-page="${a.page}"]`);
    if (!el || !a || !box) return;
    const r = box.getBoundingClientRect();
    el.scrollLeft += r.left + a.fx * r.width - a.x;
    el.scrollTop += r.top + a.fy * r.height - a.y;
  }, [zoom]);

  // a new document: back to the same page, the same distance into it (before the paint)
  useLayoutEffect(() => {
    const el = host.current, a = anchor.current;
    if (!el || !a || !pages.length || !width) return;
    anchor.current = null;
    const page = Math.min(a.page, pages.length - 1);
    let y = PAD;
    for (let i = 0; i < page; i++) y += pages[i].height * scaleFor(pages[i]) + GAP;
    const top = Math.round(y + a.frac * (pages[page].height * scaleFor(pages[page]) + GAP));
    if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
  }, [pages]);

  // render the pages that are (nearly) visible, at the current scale — off-screen, then copied in one step
  useEffect(() => {
    const el = host.current;
    if (!el || !doc || !pages.length || !width) return;
    // the documents this one replaced can go now (their renders were cancelled with the previous run)
    for (const t of retired.current.splice(0)) void t.destroy();
    let disposed = false;
    const renderVisible = () => {
      if (disposed) return;
      const top = el.scrollTop - el.clientHeight, bottom = el.scrollTop + 2 * el.clientHeight;
      let y = PAD, cur = 1, best = Infinity;
      pages.forEach((p, i) => {
        const scale = scaleFor(p);
        const h = p.height * scale + GAP;
        const mid = y + h / 2;
        if (Math.abs(mid - (el.scrollTop + el.clientHeight / 3)) < best) { best = Math.abs(mid - (el.scrollTop + el.clientHeight / 3)); cur = i + 1; }
        if (y + h >= top && y <= bottom) void renderPage(i + 1, scale);
        y += h;
      });
      setCurrent(cur);
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
        canvas.width = off.width; canvas.height = off.height;
        // placed in fractions of the page box, so that a pinch stretches it with the page
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
        rendered.current.get(n)!.task = null;
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
      for (const s of rendered.current.values()) { s.task?.cancel(); s.detail?.task?.cancel(); }
      rendered.current.clear();
    };
  }, [doc, pages, width, zoom, darkKey]);

  // forward search: scroll the target box into view and flash it
  useEffect(() => {
    const el = host.current;
    if (!el || !target || !pages.length || target.page < 1 || target.page > pages.length) return;
    let y = PAD;
    for (let i = 0; i < target.page - 1; i++) y += pages[i].height * scaleFor(pages[i]) + GAP;
    const scale = scaleFor(pages[target.page - 1]);
    const boxY = y + target.y * scale;
    el.scrollTo({ top: Math.max(0, boxY - el.clientHeight / 3), behavior: 'smooth' });
    setFlash({ page: target.page, x: target.x, y: target.y, w: target.w ?? 200, h: target.h ?? 12 });
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [target?.seq, pages, width, zoom]);

  const zoomStep = (dir: 1 | -1) => {
    setZoom(z => {
      const cur = z === 'width' && pages.length ? scaleFor(pages[0]) / (96 / 72) : z === 'width' ? 1 : z;
      const next = dir > 0 ? ZOOMS.find(v => v > cur + 0.01) ?? ZOOMS[ZOOMS.length - 1] : [...ZOOMS].reverse().find(v => v < cur - 0.01) ?? ZOOMS[0];
      return next;
    });
  };
  const gotoPage = (n: number) => {
    const el = host.current;
    if (!el || !pages.length) return;
    n = Math.max(1, Math.min(pages.length, n));
    let y = PAD;
    for (let i = 0; i < n - 1; i++) y += pages[i].height * scaleFor(pages[i]) + GAP;
    el.scrollTo({ top: y - PAD });
  };

  return (
    <div class={'pdf-viewer' + (dark ? ' dark-pages' : '')}>
      <div class="pdf-toolbar">
        <button class="small-btn" title="Previous page" onClick={() => gotoPage(current - 1)}>‹</button>
        <input class="pdf-page" type="number" min={1} max={pages.length || 1} value={current} onChange={e => gotoPage(Number((e.target as HTMLInputElement).value))} title="Page" />
        <span class="pdf-count">/ {pages.length || '–'}</span>
        <button class="small-btn" title="Next page" onClick={() => gotoPage(current + 1)}>›</button>
        <span class="pdf-sep" />
        <button class="small-btn" title="Zoom out" onClick={() => zoomStep(-1)}>−</button>
        <button class={'small-btn' + (zoom === 'width' ? ' active' : '')} title="Fit the page width" onClick={() => setZoom('width')}>{zoom === 'width' ? 'Fit width' : `${Math.round(zoom * 100)}%`}</button>
        <button class="small-btn" title="Zoom in" onClick={() => zoomStep(1)}>+</button>
        {themeDark && <button class={'small-btn pdf-dark-toggle' + (dark ? ' active' : '')} data-pdf-dark aria-pressed={dark} onClick={() => setPref('darkPdf', !dark)}
          title={dark ? 'Dark pages: the PDF light on dark, photographs in their colours — click for the PDF’s own colours' : 'The PDF’s own colours — click for dark pages'}>◐</button>}
        {toolbar && <span class="pdf-sep" />}
        {toolbar}
        {hint && <span class="pdf-hint">{hint}</span>}
      </div>
      <div class="pdf-stage">
        {busy && <div class="pdf-busy-line" aria-hidden="true" />}
        {overlay}
        <div class="pdf-pages" ref={host}>
          {error && <div class="pdf-error">Could not open the PDF: {error}</div>}
          {pages.map((p, i) => {
            const scale = scaleFor(p);
            const n = i + 1;
            return (
              <div key={n} class="pdf-page-box" style={{ width: `${p.width * scale}px`, height: `${p.height * scale}px` }} data-page={n}
                onDblClick={e => { if (!onSync) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onSync(n, (e.clientX - r.left) / scale, (e.clientY - r.top) / scale); }}>
                <canvas ref={c => { if (c) canvases.current.set(n, c); else canvases.current.delete(n); }} />
                <canvas class="pdf-detail" ref={c => { if (c) details.current.set(n, c); else details.current.delete(n); }} />
                {flash && flash.page === n && <div class="pdf-flash" style={{ left: `${flash.x * scale - 4}px`, top: `${flash.y * scale - 3}px`, width: `${Math.max(24, flash.w * scale + 8)}px`, height: `${flash.h * scale + 6}px` }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
