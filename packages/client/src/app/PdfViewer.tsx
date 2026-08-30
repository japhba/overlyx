/**
 * A PDF viewer (pdf.js): the pages of a document rendered to canvases, lazily as they scroll
 * into view, fitted to the width of the panel or zoomed. Used for the built PDF in the side
 * panel and for PDF files of a project opened in a tab. SyncTeX: `target` scrolls to a box of
 * the page and flashes it (forward search); a double-click on a page reports the point in PDF
 * points from the page's top-left (inverse search) through `onSync`.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

/** A place in the PDF (points from the page's top-left): the box to show, `seq` makes a repeated target scroll again. */
export interface PdfTarget { page: number; x: number; y: number; w?: number; h?: number; seq: number }

interface PageInfo { width: number; height: number }

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function PdfViewer({ url, target, onSync, toolbar, hint }: { url: string; target?: PdfTarget | null; onSync?: (page: number, x: number, y: number) => void; toolbar?: ComponentChildren; hint?: string }) {
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
  const keepScroll = useRef<number | null>(null);

  // load the document (a rebuilt PDF keeps the scroll position)
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (host.current && host.current.scrollHeight > 0) keepScroll.current = host.current.scrollTop / host.current.scrollHeight;
    const task = pdfjs.getDocument({ url, withCredentials: true });
    task.promise.then(async d => {
      if (cancelled) return;
      const infos: PageInfo[] = [];
      for (let i = 1; i <= d.numPages; i++) { const p = await d.getPage(i); const v = p.getViewport({ scale: 1 }); infos.push({ width: v.width, height: v.height }); }
      if (cancelled) return;
      rendered.current.clear();
      setDoc(d);
      setPages(infos);
    }).catch(e => { if (!cancelled) setError(String((e as Error).message ?? e)); });
    // destroying the loading task frees the document (and its worker data) when the URL changes or
    // the viewer goes away; renders still in flight are cancelled first (they would fail on the gone transport)
    return () => { cancelled = true; for (const s of rendered.current.values()) s.task?.cancel(); rendered.current.clear(); void task.destroy(); };
  }, [url]);

  // the panel's width (fit-to-width) and the visible page
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scaleFor = (p: PageInfo) => (zoom === 'width' ? Math.max(0.2, (width - 28) / p.width) : zoom * (96 / 72));

  // render the pages that are (nearly) visible, at the current scale
  useEffect(() => {
    const el = host.current;
    if (!el || !doc || !pages.length || !width) return;
    let disposed = false;
    const renderVisible = () => {
      if (disposed) return;
      const top = el.scrollTop - el.clientHeight, bottom = el.scrollTop + 2 * el.clientHeight;
      let y = 0, cur = 1, best = Infinity;
      pages.forEach((p, i) => {
        const scale = scaleFor(p);
        const h = p.height * scale + 12;
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
        const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
        canvas.width = viewport.width; canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / (window.devicePixelRatio || 1)}px`;
        canvas.style.height = `${viewport.height / (window.devicePixelRatio || 1)}px`;
        const task = page.render({ canvas, viewport });
        rendered.current.set(n, { scale, task });
        task.promise.then(() => { const s = rendered.current.get(n); if (s?.task === task) s.task = null; }, () => { /* cancelled */ });
      } catch {
        rendered.current.delete(n);   // the document was replaced or destroyed meanwhile
      }
    };
    renderVisible();
    if (keepScroll.current !== null) { el.scrollTop = keepScroll.current * el.scrollHeight; keepScroll.current = null; renderVisible(); }
    let raf = 0;
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderVisible); };
    el.addEventListener('scroll', onScroll);
    return () => { disposed = true; el.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); for (const s of rendered.current.values()) s.task?.cancel(); rendered.current.clear(); };
  }, [doc, pages, width, zoom]);

  // forward search: scroll the target box into view and flash it
  useEffect(() => {
    const el = host.current;
    if (!el || !target || !pages.length || target.page < 1 || target.page > pages.length) return;
    let y = 0;
    for (let i = 0; i < target.page - 1; i++) y += pages[i].height * scaleFor(pages[i]) + 12;
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
    let y = 0;
    for (let i = 0; i < n - 1; i++) y += pages[i].height * scaleFor(pages[i]) + 12;
    el.scrollTo({ top: y });
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
  );
}
