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
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

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

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
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
  const rendered = useRef(new Map<number, { scale: number; task: RenderTask | null }>());
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
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
    const task = pdfjs.getDocument({ url, withCredentials: true, worker: worker() });
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
    const renderPage = async (n: number, scale: number) => {
      const canvas = canvases.current.get(n);
      if (!canvas) return;
      const state = rendered.current.get(n);
      if (state && state.scale === scale) return;
      state?.task?.cancel();
      rendered.current.set(n, { scale, task: null });   // claimed: a second pass must not start the same render
      try {
        const page = await doc.getPage(n);
        if (disposed) return;
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });
        const off = document.createElement('canvas');
        off.width = Math.ceil(viewport.width); off.height = Math.ceil(viewport.height);
        const task = page.render({ canvas: off, viewport });
        rendered.current.set(n, { scale, task });
        await task.promise;
        if (disposed || rendered.current.get(n)?.task !== task) return;
        rendered.current.get(n)!.task = null;
        // resizing clears a canvas: size it and draw the finished page in the same task, so the old picture never blanks
        canvas.width = off.width; canvas.height = off.height;
        canvas.getContext('2d')?.drawImage(off, 0, 0);
        canvas.classList.add('ready');
      } catch {
        if (rendered.current.get(n)?.scale === scale) rendered.current.delete(n);   // cancelled, or the document was replaced meanwhile
      }
    };
    renderVisible();
    let raf = 0;
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderVisible); };
    el.addEventListener('scroll', onScroll);
    return () => { disposed = true; el.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); for (const s of rendered.current.values()) s.task?.cancel(); rendered.current.clear(); };
  }, [doc, pages, width, zoom]);

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
    <div class="pdf-viewer">
      <div class="pdf-toolbar">
        <button class="small-btn" title="Previous page" onClick={() => gotoPage(current - 1)}>‹</button>
        <input class="pdf-page" type="number" min={1} max={pages.length || 1} value={current} onChange={e => gotoPage(Number((e.target as HTMLInputElement).value))} title="Page" />
        <span class="pdf-count">/ {pages.length || '–'}</span>
        <button class="small-btn" title="Next page" onClick={() => gotoPage(current + 1)}>›</button>
        <span class="pdf-sep" />
        <button class="small-btn" title="Zoom out" onClick={() => zoomStep(-1)}>−</button>
        <button class={'small-btn' + (zoom === 'width' ? ' active' : '')} title="Fit the page width" onClick={() => setZoom('width')}>{zoom === 'width' ? 'Fit width' : `${Math.round(zoom * 100)}%`}</button>
        <button class="small-btn" title="Zoom in" onClick={() => zoomStep(1)}>+</button>
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
                {flash && flash.page === n && <div class="pdf-flash" style={{ left: `${flash.x * scale - 4}px`, top: `${flash.y * scale - 3}px`, width: `${Math.max(24, flash.w * scale + 8)}px`, height: `${flash.h * scale + 6}px` }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
