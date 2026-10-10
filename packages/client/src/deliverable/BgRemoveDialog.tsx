/**
 * Picture ▸ Remove background (PowerPoint's): the picture shown without its background on a
 * transparency checkerboard; a tolerance slider; brushes to mark areas to keep (green) and to remove
 * (red) and to erase marks; "Keep changes" hands the new picture (a PNG) to the caller, which saves
 * it next to the original — the original file stays untouched. The work is bgremove.ts, in a worker
 * (bgremove.worker.ts) where one can be started, else on this thread between frames.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Dialog } from '../app/Dialogs';
import { analyse, backgroundMask, composite, scaleOptions, DEFAULT_TOLERANCE, type BgAnalysis, type BgOptions, type MaskCache, type RGBAImage, type Stroke } from './bgremove';
import type { BgRequest, BgResponse } from './bgremove.worker';
import './imagetools.css';

/** browsers draw nothing on canvases much larger than this (Safari: 16.7 M pixels) */
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;

type Mode = 'keep' | 'remove' | 'erase';
interface Mark extends Stroke { mode: 'keep' | 'remove' }

/* ------------------------------------------------------------------ the work, in a worker or here */

interface Remover {
  load(img: RGBAImage): Promise<{ width: number; height: number }>;
  run(type: 'preview' | 'final', opts: BgOptions): Promise<{ image: RGBAImage; allBackground: boolean }>;
  dispose(): void;
}

function workerRemover(): Remover {
  const w = new Worker(new URL('./bgremove.worker.ts', import.meta.url), { type: 'module' });
  let next = 1;
  const waiting = new Map<number, { ok: (r: BgResponse) => void; fail: (e: Error) => void }>();
  w.onmessage = (e: MessageEvent<BgResponse>) => {
    const p = waiting.get(e.data.id);
    if (!p) return;
    waiting.delete(e.data.id);
    if (e.data.type === 'error') p.fail(new Error(e.data.message)); else p.ok(e.data);
  };
  w.onerror = (e) => { for (const p of waiting.values()) p.fail(new Error(e.message || 'the worker failed')); waiting.clear(); };
  const ask = (m: { type: 'load'; image: RGBAImage } | { type: 'preview' | 'final'; opts: BgOptions }, transfer: Transferable[] = []) => new Promise<BgResponse>((ok, fail) => {
    const id = next++;
    waiting.set(id, { ok, fail });
    w.postMessage({ ...m, id } as BgRequest, transfer);
  });
  return {
    load: async img => { const r = await ask({ type: 'load', image: img }, [img.data.buffer]); if (r.type !== 'loaded') throw new Error('load failed'); return r; },
    run: async (type, opts) => { const r = await ask({ type, opts }); if (r.type !== 'image') throw new Error('failed'); return r; },
    dispose: () => w.terminate(),
  };
}

function localRemover(): Remover {
  let full: RGBAImage | null = null, an: BgAnalysis | null = null, cache: MaskCache = {};
  const frame = () => new Promise(r => setTimeout(r, 0));
  return {
    load: async img => { full = img; await frame(); an = analyse(img); cache = {}; return { width: an.width, height: an.height }; },
    run: async (type, opts) => {
      if (!full || !an) throw new Error('no picture loaded');
      await frame();
      const mask = backgroundMask(an, opts, cache);
      await frame();
      const r = type === 'preview' ? composite(an.image, an, mask, scaleOptions(opts, an.scale)) : composite(full, an, mask, opts);
      return { image: r.image, allBackground: r.allBackground };
    },
    dispose: () => { full = null; an = null; },
  };
}

/** the picture's pixels (at most MAX_PIXELS; an SVG drawn at its size, or 1024 px wide) */
async function loadPixels(src: string): Promise<{ img: RGBAImage; bitmap: CanvasImageSource; scaledDown: boolean }> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`could not load the picture (${res.status})`);
  const blob = await res.blob();
  let source: CanvasImageSource, w: number, h: number;
  const isSvg = blob.type.includes('svg') || /\.svgz?(\?|$)/i.test(src);
  if (!isSvg && typeof createImageBitmap === 'function') {
    const b = await createImageBitmap(blob);
    source = b; w = b.width; h = b.height;
  } else {
    const url = URL.createObjectURL(isSvg && !blob.type.includes('svg') ? new Blob([blob], { type: 'image/svg+xml' }) : blob);
    try {
      const im = new Image();
      im.decoding = 'async';
      im.src = url;
      await im.decode();
      w = im.naturalWidth || 1024; h = im.naturalHeight || Math.round(w * 0.75);
      source = im;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  if (!w || !h) throw new Error('the picture is empty');
  const s = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('this browser cannot read pictures');
  g.drawImage(source, 0, 0, cw, ch);
  const d = g.getImageData(0, 0, cw, ch);
  return { img: { data: d.data, width: cw, height: ch }, bitmap: c, scaledDown: s < 1 };
}

async function toPng(img: RGBAImage): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return new Promise((ok, fail) => c.toBlob(b => (b ? ok(b) : fail(new Error('could not encode the picture'))), 'image/png'));
}

/* ------------------------------------------------------------------ the dialog */

export function BgRemoveDialog({ src, name, onDone, onClose }: { src: string; name: string; onDone(blob: Blob): void; onClose(): void }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE);
  const [mode, setMode] = useState<Mode>('keep');
  const [brush, setBrush] = useState(18);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [original, setOriginal] = useState(false);
  const originalRef = useRef(false); originalRef.current = original;
  const [busy, setBusy] = useState(false);
  const [noSubject, setNoSubject] = useState(false);
  const [scaledDown, setScaledDown] = useState(false);
  const view = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const remover = useRef<Remover | null>(null);
  const full = useRef({ w: 1, h: 1 });
  const preview = useRef<ImageData | null>(null);
  const originalPic = useRef<CanvasImageSource | null>(null);
  const reqId = useRef(0);
  const drawing = useRef<Mark | null>(null);

  const opts = (m = marks, t = tolerance): BgOptions => ({
    tolerance: t,
    keep: m.filter(x => x.mode === 'keep').map(({ points, radius }) => ({ points, radius })),
    remove: m.filter(x => x.mode === 'remove').map(({ points, radius }) => ({ points, radius })),
  });

  /* the picture: loaded, analysed, a first preview */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { img, bitmap, scaledDown: sd } = await loadPixels(src);
        if (cancelled) return;
        originalPic.current = bitmap;
        full.current = { w: img.width, h: img.height };
        setScaledDown(sd);
        let r: Remover;
        let dims: { width: number; height: number };
        try { r = workerRemover(); dims = await r.load({ data: new Uint8ClampedArray(img.data), width: img.width, height: img.height }); }
        catch { r = localRemover(); dims = await r.load(img); }
        if (cancelled) { r.dispose(); return; }
        remover.current = r;
        for (const c of [view.current, overlay.current]) if (c) { c.width = dims.width; c.height = dims.height; }
        setPhase('ready');
        void refresh(opts([], DEFAULT_TOLERANCE));
      } catch (e) {
        if (!cancelled) { setError((e as Error).message || String(e)); setPhase('error'); }
      }
    })();
    return () => { cancelled = true; remover.current?.dispose(); remover.current = null; };
  }, [src]);

  /** a new preview for the current settings (answers to older requests are dropped) */
  const refresh = async (o: BgOptions) => {
    const r = remover.current;
    if (!r) return;
    const id = ++reqId.current;
    setBusy(true);
    try {
      const res = await r.run('preview', o);
      if (id !== reqId.current) return;
      preview.current = new ImageData(new Uint8ClampedArray(res.image.data), res.image.width, res.image.height);
      setNoSubject(res.allBackground);
      paint();
    } catch (e) {
      if (id === reqId.current) { setError((e as Error).message); setPhase('error'); }
    } finally { if (id === reqId.current) setBusy(false); }
  };

  /* the tolerance: a preview a moment after the slider stops */
  const firstTol = useRef(true);
  useEffect(() => {
    if (firstTol.current) { firstTol.current = false; return; }
    const t = setTimeout(() => void refresh(opts()), 120);
    return () => clearTimeout(t);
  }, [tolerance]);

  const paint = () => {
    const c = view.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    if (originalRef.current && originalPic.current) g.drawImage(originalPic.current, 0, 0, c.width, c.height);
    else if (preview.current) g.putImageData(preview.current, 0, 0);
  };
  useEffect(paint, [original]);

  /* the marks, drawn over the picture */
  const paintMarks = (list: Mark[]) => {
    const c = overlay.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    const k = c.width / full.current.w;
    for (const m of list) {
      g.strokeStyle = g.fillStyle = m.mode === 'keep' ? 'rgba(30, 160, 80, 0.6)' : 'rgba(225, 50, 40, 0.6)';
      g.lineWidth = m.radius * 2 * k;
      g.lineCap = g.lineJoin = 'round';
      g.beginPath();
      m.points.forEach(([x, y], i) => (i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k)));
      if (m.points.length === 1) { g.arc(m.points[0][0] * k, m.points[0][1] * k, m.radius * k, 0, Math.PI * 2); g.fill(); }
      else g.stroke();
    }
  };
  useEffect(() => paintMarks(marks), [marks]);

  /** a pointer position → the picture's own pixels; the brush radius in them */
  const at = (e: PointerEvent): [number, number] => {
    const c = overlay.current!;
    const r = c.getBoundingClientRect();
    return [Math.max(0, Math.min(full.current.w, (e.clientX - r.left) / r.width * full.current.w)), Math.max(0, Math.min(full.current.h, (e.clientY - r.top) / r.height * full.current.h))];
  };
  const radius = () => { const r = overlay.current!.getBoundingClientRect(); return (brush / 2) * full.current.w / Math.max(1, r.width); };

  const eraseAt = (p: [number, number], list: Mark[]) => {
    const rr = radius();
    return list.filter(m => !m.points.some(([x, y]) => Math.hypot(x - p[0], y - p[1]) <= rr + m.radius));
  };

  const onDown = (e: PointerEvent) => {
    if (phase !== 'ready' || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = at(e);
    if (mode === 'erase') { const next = eraseAt(p, marks); if (next.length !== marks.length) setMarks(next); drawing.current = { mode: 'keep', points: [], radius: 0 }; return; }
    drawing.current = { mode, points: [p], radius: radius() };
    paintMarks([...marks, drawing.current]);
  };
  const onMove = (e: PointerEvent) => {
    const d = drawing.current;
    if (!d) return;
    const p = at(e);
    if (mode === 'erase') { setMarks(m => { const next = eraseAt(p, m); return next.length !== m.length ? next : m; }); return; }
    const last = d.points[d.points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < d.radius * 0.25) return;
    d.points.push(p);
    paintMarks([...marks, d]);
  };
  const onUp = () => {
    const d = drawing.current;
    drawing.current = null;
    if (!d) return;
    if (mode === 'erase') { void refresh(opts()); return; }
    const next = [...marks, d];
    setMarks(next);
    void refresh(opts(next));
  };

  const undoMark = () => { if (!marks.length) return; const next = marks.slice(0, -1); setMarks(next); void refresh(opts(next)); };
  const reset = () => { setMarks([]); setOriginal(false); if (tolerance !== DEFAULT_TOLERANCE) setTolerance(DEFAULT_TOLERANCE); else void refresh(opts([], DEFAULT_TOLERANCE)); };

  const keep = async () => {
    const r = remover.current;
    if (!r || phase !== 'ready') return;
    setPhase('saving');
    try {
      const res = await r.run('final', opts());
      onDone(await toPng(res.image));
    } catch (e) { setError((e as Error).message); setPhase('error'); }
  };

  /* Enter keeps, ⌘Z / Ctrl+Z takes back the last mark (Escape is the dialog's: it cancels) */
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.key === 'Enter' && !(t && t.closest('button, select, textarea'))) { e.preventDefault(); void keep(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undoMark(); }
  };
  useEffect(() => { const k = (e: KeyboardEvent) => keyRef.current(e); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);

  const modeBtn = (m: Mode, label: string, title: string) => (
    <button type="button" class={'bgr-mode bgr-' + m + (mode === m ? ' on' : '')} aria-pressed={mode === m} title={title} onClick={() => setMode(m)} data-bgr-mode={m}>
      <span class="bgr-swatch" aria-hidden="true" />{label}
    </button>
  );

  return (
    <Dialog title={`Remove background — ${name}`} wide onClose={onClose} buttons={<>
      <button type="button" class="btn" onClick={reset} disabled={phase !== 'ready'} data-bgr-reset>Reset</button>
      <button type="button" class="btn primary" onClick={() => void keep()} disabled={phase !== 'ready'} data-bgr-keep>{phase === 'saving' ? 'Saving…' : 'Keep changes'}</button>
    </>}>
      <div class="bgr" data-bgr>
        <div class="bgr-tools" role="toolbar" aria-label="Background removal tools">
          {modeBtn('keep', 'Mark areas to keep', 'Paint over what should stay')}
          {modeBtn('remove', 'Mark areas to remove', 'Paint over what should go')}
          {modeBtn('erase', 'Erase marks', 'Paint over marks to remove them')}
          <button type="button" class="bgr-mode" onClick={undoMark} disabled={!marks.length} title="Take back the last mark (Ctrl+Z)">Undo mark</button>
        </div>
        <div class="bgr-tools">
          <label class="bgr-slider">Tolerance
            <input type="range" min={0} max={100} value={tolerance} aria-label="Tolerance: how far a colour may be from the background's and still be removed"
              onInput={e => setTolerance(Number((e.target as HTMLInputElement).value))} data-bgr-tolerance />
            <span class="bgr-num">{tolerance}</span>
          </label>
          <label class="bgr-slider">Brush
            <input type="range" min={4} max={80} value={brush} aria-label="Brush size" onInput={e => setBrush(Number((e.target as HTMLInputElement).value))} />
            <span class="bgr-num">{brush}</span>
          </label>
          <label class="bgr-check"><input type="checkbox" checked={original} onChange={e => setOriginal((e.target as HTMLInputElement).checked)} data-bgr-original /> Show original</label>
        </div>
        <div class={'bgr-stage' + (busy ? ' busy' : '')}>
          <div class="bgr-pic" style={{ aspectRatio: `${full.current.w} / ${full.current.h}` }}>
            <canvas ref={view} class="bgr-view" role="img" aria-label={original ? 'The original picture' : 'The picture without its background'} />
            <canvas ref={overlay} class={'bgr-overlay mode-' + mode} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-hidden="true" />
          </div>
          {phase === 'loading' && <div class="bgr-status">Finding the background…</div>}
          {phase === 'saving' && <div class="bgr-status">Making the picture…</div>}
          {phase === 'error' && <div class="bgr-status err" role="alert">{error || 'Something went wrong.'}</div>}
        </div>
        <div class="hint" aria-live="polite">
          {noSubject ? 'Everything looks like background — paint over what should stay with “Mark areas to keep”, or lower the tolerance.'
            : 'Green marks keep, red marks remove; similar colours next to a mark follow it. The original file is kept.'}
          {scaledDown && ' (A very large picture: the result is saved at a reduced size.)'}
        </div>
      </div>
    </Dialog>
  );
}

export default BgRemoveDialog;
