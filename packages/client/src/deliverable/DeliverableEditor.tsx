/**
 * The editor of HTML deliverables — slide decks, posters, web pages (core html/): the page itself,
 * rendered in a sandboxed frame by the runtime (runtime/), is the canvas; this component owns the
 * text, through its host (host.ts — in the web app a Y.Text synced like any document, server docs.ts
 * HtmlDoc; in VS Code the file's TextDocument), so people, agents (the file tools) and the code view
 * all edit the same characters live. What people do on the canvas arrives as operations on the
 * version the frame showed, is rebased onto the text as it is now (sourceops.ts) and applied as
 * splices — nothing else of the file changes.
 *
 * Around the canvas: the slide rail (a second frame, small), the toolbar (insert objects, format the
 * selection, arrange), speaker notes, the code (a textarea on the same text), presenting (a third
 * frame, full screen), and the host's downloads.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { type User } from '../api';
import { showContextMenu, closeContextMenu, type MenuItem } from '../editor/contextmenu';
import { Toolbar } from '../app/Toolbar';
import { ColorGrid } from '../app/ColorGrid';
import type { DeliverableHost } from './host';
import { webHost } from './webHost';
import type { FromRuntime, ToRuntime, SelItem, SlideBox, Tool, Path, HtmlOp, DeliverableKind, Rect, ArrangeHow, Paint, CanvasView } from './protocol';
import { isFromRuntime } from './protocol';
import { rebasedSplices, objectHtml, imageHtml, insertPlace, newSlideHtml, slidePaths, slideNotes, notesOp, sourceRange, inlineSvgHtml } from './sourceops';
import { deckToolbar, type DeckTextActions } from './decktoolbar';
import { BgRemoveDialog } from './BgRemoveDialog';
import { parseSource, opSplices, elementAt, elementChildren, attr } from '@overlyx/core/html/source.ts';

const PAD = 48;
const CHECKER = 'repeating-conic-gradient(#e3e5e8 0 25%, #ffffff 0 50%) 0 0 / 16px 16px';
const NO_VIEW: CanvasView = { desk: null, deskChecker: false, pageChecker: false };

/** how this browser shows what is around a document's pages (view only, never in the file) */
function loadView(path: string): CanvasView {
  try { const v = JSON.parse(localStorage.getItem('ol.canvas:' + path) ?? 'null'); return v && typeof v === 'object' ? { ...NO_VIEW, ...v } : NO_VIEW; } catch { return NO_VIEW; }
}
function saveView(path: string, v: CanvasView): void {
  try { if (v.desk === null && !v.deskChecker && !v.pageChecker) localStorage.removeItem('ol.canvas:' + path); else localStorage.setItem('ol.canvas:' + path, JSON.stringify(v)); } catch { /* private window */ }
}

/** the natural size of a picture file (null when the browser cannot decode it) */
async function naturalSize(data: Blob): Promise<{ w: number; h: number } | null> {
  try { const b = await createImageBitmap(data); const r = { w: b.width, h: b.height }; b.close?.(); return r; } catch { return null; }
}

type Notify = (text: string, kind?: 'info' | 'error') => void;

interface Link { base: string; entry: string; expires: number }

/** The deliverable editor of the web app: its host keeps the text in a Y.Text synced with the server (webHost.ts). */
export function DeliverableEditor({ id, user, notify }: { id: string; user: User; notify: Notify }) {
  const host = useMemo(() => webHost(id, user), [id]);
  useEffect(() => () => host.destroy(), [host]);
  return <DeliverableCanvas key={id} host={host} notify={notify} />;
}

/** The editor around the page, wherever it runs (`host`: the web app's, the VS Code extension's). */
export function DeliverableCanvas({ host, notify }: { host: DeliverableHost; notify: Notify }) {
  const path = host.path;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const [, bump] = useState(0);
  const rerender = () => bump(t => t + 1);
  const text = { toString: () => host.text() };

  const [synced, setSynced] = useState(host.ready());
  const [online, setOnline] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const readOnlyRef = useRef(false); readOnlyRef.current = readOnly;

  /** every version of the text sent to the frames, kept a little while for rebasing their operations */
  const versions = useRef(new Map<number, string>());
  const version = useRef(0);

  /* ------------------------------------------------------------- the frames */

  const [link, setLink] = useState<Link | null>(null);
  const canvasBox = useRef<HTMLDivElement>(null);
  const canvasFrame = useRef<HTMLIFrameElement>(null);
  const railBox = useRef<HTMLDivElement>(null);
  const railFrame = useRef<HTMLIFrameElement>(null);
  const presentFrame = useRef<HTMLIFrameElement>(null);
  const [kind, setKind] = useState<DeliverableKind>('deck');
  const [slides, setSlides] = useState<SlideBox[]>([]);
  const [pageW, setPageW] = useState(1280);
  const [box, setBox] = useState({ w: 800, h: 600 });
  const [railH, setRailH] = useState(600);
  const [zoom, setZoom] = useState(1);
  /** the frame's left edge when it is wider than the canvas (zoomed in): panned sideways */
  const [panX, setPanX] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const scrollRef = useRef(0);
  const [view, setViewState] = useState<CanvasView>(() => loadView(host.path));
  const [colors, setColors] = useState<{ desk: string; page: string } | null>(null);
  const [floatPop, setFloatPop] = useState<{ x: number; y: number; title: string; render: (close: () => void) => ComponentChildren } | null>(null);
  const [cropping, setCropping] = useState<Path | null>(null);
  const [bgFor, setBgFor] = useState<{ url: string; name: string; imgPath: Path; src: string } | null>(null);
  /** where the next scale is anchored (a pinch: the point under the fingers stays put) */
  const anchorRef = useRef<{ docY: number; screenY: number } | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [current, setCurrent] = useState(0);
  const [sel, setSel] = useState<SelItem[]>([]);
  const [editingText, setEditingText] = useState<Path | null>(null);
  const [tool, setToolState] = useState<Tool>('select');
  const [codeOpen, setCodeOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const canvasReady = useRef(false);
  const railReady = useRef(false);
  const pending = useRef<{ select?: Path[]; editText?: Path } | null>(null);

  const frameW = kind === 'page' ? (device === 'mobile' ? 390 : 1280) : pageW + PAD * 2;
  const fit = Math.max(0.05, Math.min(kind === 'page' ? 1 : 2, (box.w - 24) / frameW));
  const scale = fit * zoom;
  const showRail = kind === 'deck';
  const railScale = Math.max(0.05, 150 / frameW);

  const toFrame = (f: HTMLIFrameElement | null, msg: ToRuntime) => { try { f?.contentWindow?.postMessage(msg, '*'); } catch { /* gone */ } };
  const toCanvas = (msg: ToRuntime) => toFrame(canvasFrame.current, msg);
  const toRail = (msg: ToRuntime) => toFrame(railFrame.current, msg);

  /** the address of the folder; renewed before it expires */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const get = () => host.link().then(l => {
      if (cancelled) return;
      setLink(prev => prev ?? { expires: 0, ...l });
      if (l.expires) timer = setTimeout(get, Math.max(60000, l.expires - Date.now() - 10 * 60000));
    }).catch(e => { if (!cancelled) notify('Could not open the page: ' + (e as Error).message, 'error'); });
    void get();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [host]);

  /* ------------------------------------------------------------- versions to the frames */

  const sendTimer = useRef<{ canvas: ReturnType<typeof setTimeout> | null; rail: ReturnType<typeof setTimeout> | null }>({ canvas: null, rail: null });
  const sendSource = (now = false) => {
    const html = text.toString();
    const v = ++version.current;
    versions.current.set(v, html);
    for (const k of versions.current.keys()) if (k < v - 40) versions.current.delete(k);
    const t = sendTimer.current;
    if (t.canvas) clearTimeout(t.canvas);
    const toC = () => { t.canvas = null; if (canvasReady.current) toCanvas({ ol: 'source', version: v, html }); };
    if (now) toC(); else t.canvas = setTimeout(toC, 40);
    if (t.rail) clearTimeout(t.rail);
    t.rail = setTimeout(() => { t.rail = null; if (railReady.current) toRail({ ol: 'source', version: v, html: text.toString() }); }, 350);
  };

  useEffect(() => {
    const offs = [
      host.onChange(origin => { sendSource(origin === 'canvas'); codeSync(origin); rerender(); }),
      host.onStatus(() => setOnline(host.online())),
      host.onReady(() => { setSynced(true); sendSource(true); }),
      host.onPeers(peers => toCanvas({ ol: 'peers', peers })),
      host.onAsset((p, v) => { toCanvas({ ol: 'asset', path: p, v }); toRail({ ol: 'asset', path: p, v }); }),
    ];
    if (host.ready()) { setSynced(true); sendSource(true); }
    const ro = setInterval(() => { if (host.readOnly() !== readOnlyRef.current) setReadOnly(host.readOnly()); }, 1000);
    setReadOnly(host.readOnly());
    return () => { for (const off of offs) off(); clearInterval(ro); };
  }, [host]);

  /* ------------------------------------------------------------- changes of the text */

  /** splices of the text, as one undo step */
  const applySplices = (splices: { from: number; to: number; insert: string }[], origin: 'canvas' | 'code' = 'canvas') => {
    if (readOnlyRef.current || !splices.length) return;
    host.apply(splices, origin);
  };

  /** operations on the current text (from this side: the toolbar, the rail's menu) */
  const applyOps = (ops: HtmlOp[]): boolean => {
    const cur = text.toString();
    const src = parseSource(cur);
    try {
      const sp = ops.flatMap(op => opSplices(src, op));
      applySplices(sp);
      return true;
    } catch (e) { notify(String((e as Error).message ?? e), 'error'); return false; }
  };

  /** operations the canvas made on version `v` */
  const applyRuntimeOps = (v: number, ops: HtmlOp[]): boolean => {
    const base = versions.current.get(v);
    const cur = text.toString();
    if (base === undefined) { notify('The page changed meanwhile — try again.', 'error'); return false; }
    const sp = rebasedSplices(base, cur, ops);
    if (!sp) { notify('Somebody changed that object meanwhile — try again.', 'error'); sendSource(true); return false; }
    applySplices(sp);
    return true;
  };

  /* ------------------------------------------------------------- the runtime's messages */

  const selRef = useRef(sel); selRef.current = sel;
  const kindRef = useRef(kind); kindRef.current = kind;
  const currentRef = useRef(current); currentRef.current = current;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const fromCanvas = e.source === canvasFrame.current?.contentWindow;
      const fromRail = e.source === railFrame.current?.contentWindow;
      const fromPresent = e.source === presentFrame.current?.contentWindow;
      if (!fromCanvas && !fromRail && !fromPresent) return;
      if (!isFromRuntime(e.data)) return;
      const m = e.data as FromRuntime;
      if (fromPresent) {
        if (m.ol === 'presentZoom') presentZoomed.current = m.zoomed;
        if (m.ol === 'exit') stopPresenting();
        if (m.ol === 'visible') setCurrent(m.slide);
        return;
      }
      switch (m.ol) {
        case 'ready':
          if (fromCanvas) {
            canvasReady.current = true;
            setKind(m.kind);
            if (m.width) setPageW(m.width);
            toCanvas({ ol: 'scale', scale });
            toCanvas({ ol: 'tool', tool });
            toCanvas({ ol: 'view', view: viewRef.current });
            if (host.ready()) toCanvas({ ol: 'source', version: version.current, html: versions.current.get(version.current) ?? text.toString() });
          } else {
            railReady.current = true;
            toRail({ ol: 'scale', scale: railScale });
            if (host.ready()) toRail({ ol: 'source', version: version.current, html: text.toString() });
            toRail({ ol: 'current', slide: currentRef.current });
          }
          break;
        case 'layout':
          if (fromCanvas) {
            setKind(m.kind);
            setSlides(m.slides);
            if (m.width) setPageW(m.width);
            const p = pending.current;
            if (p) {
              pending.current = null;
              if (p.select) toCanvas({ ol: 'select', paths: p.select });
              if (p.editText) toCanvas({ ol: 'editText', path: p.editText, selectAll: true });
            }
          }
          break;
        case 'selection': if (fromCanvas) { setSel(m.items); host.setSelection(m.items.map(i => i.path)); } break;
        case 'editing': if (fromCanvas) setEditingText(m.path); break;
        case 'visible': if (fromCanvas && m.slide >= 0) { setCurrent(m.slide); toRail({ ol: 'current', slide: m.slide }); } break;
        case 'goto': setCurrent(m.slide); toCanvas({ ol: 'scrollTo', slide: m.slide, smooth: false }); toRail({ ol: 'current', slide: m.slide }); break;
        case 'ops': {
          if (readOnlyRef.current) { notify('You can only view this page.', 'error'); sendSource(true); break; }
          const before = text.toString();
          const ok = applyRuntimeOps(m.version, m.ops);
          if (ok && Array.isArray(m.select)) pending.current = { select: m.select };
          else if (ok && m.select === 'inserted') {
            // the inserted elements: after the last element child of their parent
            const ins = m.ops.filter((o): o is Extract<HtmlOp, { t: 'insert' }> => o.t === 'insert');
            if (ins.length) {
              const { doc } = parseSource(before);
              const parent = elementAt(doc, ins[0].parent);
              const n = parent ? elementChildren(parent).length : 0;
              pending.current = { select: ins.map((o, k) => [...o.parent, Math.min(o.index, n) + k]) };
            }
          }
          break;
        }
        case 'draw': onDraw(m.version, m.tool, m.slide, m.rect, m.after ?? null, m.pts); break;
        case 'key': onRuntimeKey(m); break;
        case 'contextmenu': {
          const f = (fromRail ? railFrame : canvasFrame).current;
          if (!f) break;
          const r = f.getBoundingClientRect();
          const s = fromRail ? railScale : scale;
          const x = r.left + m.x * s, y = r.top + m.y * s;
          if (fromRail) slideMenu(x, y, m.slide ?? currentRef.current);
          else if (m.on === 'canvas') canvasMenu(x, y);
          else if (m.on === 'slide' && !selRef.current.length) emptySlideMenu(x, y, m.slide ?? currentRef.current);
          else objectMenu(x, y);
          break;
        }
        case 'pasteFiles': void placeFiles(m.files, m.slide, m.at); break;
        case 'zoom': if (fromCanvas) zoomAbout(m.factor, m.clientX, m.clientY, m.pageY); break;
        case 'pan': if (fromCanvas) setPanX(p => p + m.dx * scaleRef.current); break;
        case 'colors': if (fromCanvas) setColors({ desk: m.desk, page: m.page }); break;
        case 'cropping': if (fromCanvas) setCropping(m.path); break;
        case 'scroll': if (fromCanvas) { scrollRef.current = m.y; setScrollY(m.y); } break;
        case 'reload': canvasReady.current = canvasReady.current && !fromCanvas; if (fromRail) railReady.current = false; break;
      }
    };
    addEventListener('message', onMessage);
    const onBlur = () => setTimeout(() => { if (document.activeElement?.tagName === 'IFRAME') closeContextMenu(); }, 0);
    addEventListener('blur', onBlur);
    return () => { removeEventListener('message', onMessage); removeEventListener('blur', onBlur); };
  });

  /* ------------------------------------------------------------- sizes, zoom and panning */

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const b = canvasBox.current;
      if (b) setBox({ w: b.clientWidth, h: b.clientHeight });
      const rb = railBox.current;
      if (rb) setRailH(rb.clientHeight);
    });
    if (canvasBox.current) ro.observe(canvasBox.current);
    if (railBox.current) ro.observe(railBox.current);
    return () => ro.disconnect();
  }, [canvasBox.current, railBox.current]);
  const scaleRef = useRef(scale); scaleRef.current = scale;
  useEffect(() => { const anchor = anchorRef.current ?? undefined; anchorRef.current = null; toCanvas({ ol: 'scale', scale, anchor }); }, [scale]);
  useEffect(() => { toRail({ ol: 'scale', scale: railScale }); }, [railScale]);
  useEffect(() => { toCanvas({ ol: 'tool', tool }); }, [tool]);

  const MAX_ZOOM = 8;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const fitRef = useRef(fit); fitRef.current = fit;
  const boxRef = useRef(box); boxRef.current = box;
  const frameWRef = useRef(frameW); frameWRef.current = frameW;
  const panRef = useRef(panX); panRef.current = panX;
  /** the frame's left edge in the canvas: centred when it fits, else where it was panned to (clamped) */
  const leftFor = (sc: number, pan: number) => {
    const w = frameWRef.current * sc, bw = boxRef.current.w;
    return w <= bw ? (bw - w) / 2 : Math.min(0, Math.max(bw - w, pan));
  };
  /** zoom by `factor` about a point of the frame (its client px; its document y) — a pinch, Ctrl+wheel, the buttons */
  const zoomAbout = (factor: number, clientX: number, clientY: number, pageY: number) => {
    const z0 = zoomRef.current, f = fitRef.current;
    const z1 = Math.max(0.1 / f, Math.min(MAX_ZOOM / f, z0 * factor));
    if (Math.abs(z1 - z0) < 1e-4) return;
    const s0 = f * z0, s1 = f * z1;
    const left0 = leftFor(s0, panRef.current);
    const screenX = left0 + clientX * s0;
    setPanX(screenX - clientX * s1);
    anchorRef.current = { docY: pageY, screenY: clientY * s0 };
    setZoom(z1);
  };
  const zoomStep = (factor: number) => {
    const sc = scaleRef.current, b = boxRef.current;
    const left = leftFor(sc, panRef.current);
    const cx = (b.w / 2 - left) / sc, cy = b.h / 2 / sc;
    zoomAbout(factor, cx, cy, scrollRef.current + cy);
  };
  const fitSlide = () => {
    setZoom(1);
    setPanX(0);
    setTimeout(() => toCanvas({ ol: 'scrollTo', slide: currentRef.current, smooth: true }), 30);
  };

  /* ------------------------------------------------------------- the canvas around the pages */

  const viewRef = useRef(view); viewRef.current = view;
  const setView = (patch: Partial<CanvasView>) => {
    const v = { ...viewRef.current, ...patch };
    setViewState(v);
    saveView(host.path, v);
    toCanvas({ ol: 'view', view: v });
  };
  const deskCss = view.deskChecker ? CHECKER : (view.desk ?? colors?.desk ?? undefined);

  /* ------------------------------------------------------------- tools and objects */

  const setTool = (t: Tool) => { setToolState(t); };

  const onDraw = (v: number, t: Tool, slide: Path | null, rect: Rect, after: Path | null, pts?: [number, number][]) => {
    setToolState('select');
    if (readOnlyRef.current) return;
    if (versions.current.get(v) === undefined) return;
    const cur = text.toString();
    const k = kindRef.current;
    const place = insertPlace(cur, slide, after, k);
    if (!place) return;
    const html = objectHtml(t, rect, k, pageW / 1280, pts);
    if (!html) return;
    if (!applyOps([{ t: 'insert', parent: place.parent, index: place.index, html }])) return;
    pending.current = (t === 'text' || t === 'formula') ? { editText: place.path } : { select: [place.path] };
  };

  const insertObject = (t: Tool) => {
    if (t === 'select') return;
    // a click on the canvas places it; the button alone puts it in the middle of the slide in view
    setTool(t);
  };

  const fileInput = useRef<HTMLInputElement>(null);
  /** where a file goes: an upload into the folder's images/, a free name */
  const uploadFile = async (f: { name: string; type: string; data: Blob | ArrayBuffer }, sub = 'images'): Promise<string | null> => {
    const ext = (f.name.split('.').pop() || f.type.split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const base = (f.name.replace(/\.[^.]+$/, '') || 'image').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    let name = `${base}.${ext}`;
    for (let i = 1; i < 50; i++) {
      const rel = (dir ? dir + '/' : '') + sub + '/' + name;
      try { await host.upload(rel, f.data instanceof Blob ? f.data : new Blob([f.data], { type: f.type })); return sub + '/' + name; }
      catch { name = `${base}-${i}.${ext}`; }
    }
    return null;
  };
  /**
   * Files put on the page (the picture button, a paste, a drop — `at`: the drop point, slide px): a
   * picture is uploaded and placed (centred on the drop point, at most 60 % of the slide wide), an SVG
   * becomes a drawing whose shapes can be edited (inlineSvgHtml) — a big one goes in as a picture.
   */
  const placeFiles = async (files: { name: string; type: string; data: Blob | ArrayBuffer }[], slide: Path | null, at: { x: number; y: number } | null) => {
    if (readOnlyRef.current) { notify('You can only view this page.', 'error'); return; }
    const k = kindRef.current;
    const pictures = files.filter(f => /^image\//.test(f.type) || /\.(svg|png|jpe?g|gif|webp|avif)$/i.test(f.name));
    if (!pictures.length) { if (files.length) notify('Only pictures and SVG drawings can be placed on the page.', 'error'); return; }
    const inserted: Path[] = [];
    let n = 0;
    for (const f of pictures) {
      const blob = f.data instanceof Blob ? f.data : new Blob([f.data], { type: f.type });
      const slidePath = slide ?? (k !== 'page' ? slides[currentRef.current]?.path ?? null : null);
      const cur = text.toString();
      const place = insertPlace(cur, slidePath, selRef.current[0]?.path ?? null, k);
      if (!place) continue;
      const w = pageW, h = slides[0]?.rect.h ?? pageW * 9 / 16;
      const cx = (at?.x ?? w / 2) + n * 24, cy = (at?.y ?? h / 2) + n * 24;
      let html: string | null = null;
      if (/svg/i.test(f.type) || /\.svg$/i.test(f.name)) {
        const svgText = await blob.text();
        html = inlineSvgHtml(svgText, k === 'page' ? null : { x: cx, y: cy, maxW: w * 0.6 }, `s${Date.now().toString(36)}${n}`);
        if (html === null && !/<svg[\s>]/i.test(svgText)) { notify(`${f.name} is not an SVG drawing.`, 'error'); continue; }
      }
      if (html === null) {
        const rel = await uploadFile({ name: f.name, type: f.type || 'image/svg+xml', data: blob });
        if (!rel) { notify(`Could not upload ${f.name}.`, 'error'); continue; }
        const nat = await naturalSize(blob);
        const iw = Math.min(nat?.w ?? 480, w * 0.6), ih = nat ? iw * nat.h / nat.w : iw * 0.75;
        html = imageHtml(rel, k === 'page' ? null : { x: cx - iw / 2, y: cy - ih / 2, w: iw, h: 0 }, k, nat ?? undefined);
      }
      if (!applyOps([{ t: 'insert', parent: place.parent, index: place.index, html }])) continue;
      inserted.push(place.path);
      n++;
    }
    if (inserted.length) pending.current = { select: [inserted[inserted.length - 1]] };
  };
  const uploadImages = (files: { name: string; type: string; data: Blob | ArrayBuffer }[], slide: Path | null) => placeFiles(files, slide, null);

  /* ------------------------------------------------------------- the selection's formatting */

  const styleSel = (set: Record<string, string | null>) => {
    if (!sel.length) return;
    applyOps(sel.map(s => ({ t: 'style', path: s.path, set })));
  };
  const fontSize = (delta: number) => {
    if (!sel.length) return;
    applyOps(sel.map(s => {
      const px = parseFloat(s.style.fontSize) || 16;
      const next = Math.max(6, Math.round(delta > 0 ? px * 1.15 + 0.5 : px / 1.15 - 0.5));
      return { t: 'style', path: s.path, set: { 'font-size': `${next}px` } };
    }));
  };
  const exec = (command: string, value?: string) => toCanvas({ ol: 'exec', command, value });
  /** a web font used for the first time: its stylesheet linked in the page's head */
  const ensureFont = (google?: string) => {
    if (!google) return;
    const cur = text.toString();
    const fam = google.replace(/ /g, '+');
    if (cur.includes(`family=${fam}`)) return;
    const head = elementAt(parseSource(cur).doc, [0]);
    if (!head || head.tagName !== 'head') return;
    applyOps([{ t: 'insert', parent: [0], index: 1e6, html: `<link href="https://fonts.googleapis.com/css2?family=${fam}:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">` }]);
  };
  const toggle = (prop: string, on: string, off: string, test: (s: SelItem) => boolean) => {
    const all = sel.every(test);
    styleSel({ [prop]: all ? off : on });
  };
  const textActions: DeckTextActions = {
    family: (css, google) => { ensureFont(google); if (editingText) exec('fontName', css ?? 'inherit'); else styleSel({ 'font-family': css }); },
    size: px => { if (editingText) exec('fontSizePx', `${px}px`); else styleSel({ 'font-size': `${px}px` }); },
    bold: () => { if (editingText) exec('bold'); else toggle('font-weight', '700', '400', s => Number(s.style.fontWeight) >= 600); },
    italic: () => { if (editingText) exec('italic'); else toggle('font-style', 'italic', 'normal', s => s.style.fontStyle === 'italic'); },
    underline: () => { if (editingText) exec('underline'); else toggle('text-decoration', 'underline', 'none', s => s.style.textDecoration.includes('underline')); },
    strike: () => { if (editingText) exec('strikeThrough'); else toggle('text-decoration', 'line-through', 'none', s => s.style.textDecoration.includes('line-through')); },
    color: c => { if (editingText) exec('foreColor', c ?? 'inherit'); else styleSel({ color: c }); },
    highlight: c => exec('hiliteColor', c ?? 'transparent'),
    align: a => { if (editingText) exec(a === 'left' ? 'justifyLeft' : a === 'center' ? 'justifyCenter' : a === 'right' ? 'justifyRight' : 'justifyFull'); else styleSel({ 'text-align': a }); },
    valign: v => styleSel({ display: 'flex', 'align-items': v }),
    list: kind => {
      const cmd = kind === 'ul' ? 'insertUnorderedList' : 'insertOrderedList';
      if (editingText) { exec(cmd); return; }
      const one = sel.length === 1 ? sel[0] : null;
      if (!one || !one.canText) return;
      toCanvas({ ol: 'editText', path: one.path, selectAll: true });
      setTimeout(() => exec(cmd), 60);
    },
    lineHeight: v => { if (editingText) exec('lineHeight', v); else styleSel({ 'line-height': v }); },
    clear: () => { if (editingText) exec('removeFormat'); else styleSel({ 'font-weight': null, 'font-style': null, 'text-decoration': null, color: null, 'font-family': null }); },
  };
  const paint = (p: Paint) => toCanvas({ ol: 'paint', paint: p });
  const arrangeSel = (how: ArrangeHow) => toCanvas({ ol: 'arrange', how });

  const removeSel = () => { const free = sel.filter(s => !s.locked); if (free.length) applyOps([{ t: 'remove', paths: free.map(s => s.path) }]); };
  const duplicateSel = () => { if (sel.length) applyOps([{ t: 'duplicate', paths: sel.map(s => s.path) }]); };

  /* ------------------------------------------------------------- pictures */

  const replaceInput = useRef<HTMLInputElement>(null);
  const imagePath = () => { const one = sel.length === 1 && sel[0].kind === 'image' ? sel[0] : null; return one; };
  const replacePicture = async (files: File[]) => {
    const one = imagePath();
    const f = files[0];
    if (!one || !f) return;
    const rel = await uploadFile({ name: f.name, type: f.type, data: f });
    if (!rel) { notify('Could not upload the picture.', 'error'); return; }
    // the <img> itself, or the one inside a crop frame
    const p = one.cropped ? [...one.path, 0] : one.path;
    applyOps([{ t: 'attr', path: p, name: 'src', value: rel }]);
  };
  const imageTools = {
    cropping: !!cropping,
    crop: () => { const one = imagePath(); if (one) toCanvas({ ol: 'crop', path: one.path }); },
    shape: (aspect: number | null, shape?: 'rect' | 'circle') => {
      if (cropping) { toCanvas({ ol: 'cropAspect', aspect, shape }); return; }
      const one = imagePath(); if (one) toCanvas({ ol: 'cropPreset', path: one.path, aspect, shape });
    },
    resetCrop: () => { const one = imagePath(); if (one) toCanvas({ ol: 'cropPreset', path: one.path, aspect: null, reset: true }); },
    done: (commit: boolean) => toCanvas({ ol: 'endCrop', commit }),
    removeBackground: () => { const one = imagePath(); if (one) removeBackground(one); },
    replace: () => replaceInput.current?.click(),
  };
  /** a project path of a src written relative to the page's folder (./ and ../ resolved), null when it leaves the project */
  const resolveRel = (src: string): string | null => {
    const parts = (dir ? dir.split('/') : []);
    for (const seg of src.split('?')[0].split('#')[0].split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(decodeURIComponent(seg));
    }
    return parts.join('/');
  };
  /** Remove background (BgRemoveDialog): the picture fetched where the frames get it (CORS *), the result saved next to it */
  const removeBackground = (it: SelItem) => {
    const { doc } = parseSource(text.toString());
    let el = elementAt(doc, it.path);
    let imgPath = it.path;
    if (el && el.tagName !== 'img') {
      const kids = elementChildren(el);
      const i = kids.findIndex(k => k.tagName === 'img');
      if (i < 0) return;
      el = kids[i];
      imgPath = [...it.path, i];
    }
    const s = el ? attr(el, 'src') : null;
    if (!s || !link) return;
    if (/^(https?:)?\/\//i.test(s) || s.startsWith('/')) { notify('Only pictures in the project can be changed — upload this one first.', 'error'); return; }
    let url = s;
    if (!s.startsWith('data:')) {
      const rel = resolveRel(s);
      if (rel === null) { notify('This picture is outside the project.', 'error'); return; }
      url = link.base + rel.split('/').map(encodeURIComponent).join('/');
    }
    setBgFor({ url, name: s.startsWith('data:') ? 'picture' : s.split('/').pop() || 'picture', imgPath, src: s });
  };
  const saveNoBg = async (blob: Blob) => {
    const b = bgFor;
    setBgFor(null);
    if (!b) return;
    const rel = b.src.startsWith('data:') ? (dir ? dir + '/' : '') + 'images/picture.png' : resolveRel(b.src);
    if (!rel) return;
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    const base = rel.slice(folder.length).replace(/\.[^.]+$/, '').replace(/-nobg(-\d+)?$/, '');
    for (let i = 0; i < 50; i++) {
      const name = `${base}-nobg${i ? '-' + (i + 1) : ''}.png`;
      try { await host.upload(folder + name, blob); } catch { continue; }
      const newSrc = b.src.startsWith('data:') ? 'images/' + name : b.src.replace(/[^/]*$/, name);
      applyOps([{ t: 'attr', path: b.imgPath, name: 'src', value: newSrc }]);
      return;
    }
    notify('Could not save the picture.', 'error');
  };

  /* ------------------------------------------------------------- menus */

  const showCode = (p?: Path) => {
    setCodeOpen(true);
    const target = p ?? sel[0]?.path;
    if (!target) return;
    setTimeout(() => {
      const ta = codeRef.current;
      const r = sourceRange(text.toString(), target);
      if (!ta || !r) return;
      ta.focus();
      ta.setSelectionRange(r.from, r.to);
      const before = ta.value.slice(0, r.from).split('\n').length;
      ta.scrollTop = Math.max(0, (before - 3) * 18);
    }, 50);
  };

  const arrangeItems = (): MenuItem[] => [
    { label: 'Order', sub: [
      { label: 'Bring to front', shortcut: 'Ctrl+Shift+↑', action: () => arrangeSel('front') },
      { label: 'Bring forward', shortcut: 'Ctrl+↑', action: () => arrangeSel('forward') },
      { label: 'Send backward', shortcut: 'Ctrl+↓', action: () => arrangeSel('backward') },
      { label: 'Send to back', shortcut: 'Ctrl+Shift+↓', action: () => arrangeSel('back') },
    ] },
    { label: 'Align', sub: [
      { label: 'Left', action: () => arrangeSel('align-left') }, { label: 'Centre', action: () => arrangeSel('align-center') }, { label: 'Right', action: () => arrangeSel('align-right') },
      { sep: true },
      { label: 'Top', action: () => arrangeSel('align-top') }, { label: 'Middle', action: () => arrangeSel('align-middle') }, { label: 'Bottom', action: () => arrangeSel('align-bottom') },
      { sep: true },
      { label: 'Centre on the slide horizontally', action: () => arrangeSel('center-h') },
      { label: 'Centre on the slide vertically', action: () => arrangeSel('center-v') },
      { sep: true },
      { label: 'Distribute horizontally', disabled: sel.length < 3, action: () => arrangeSel('distribute-h') },
      { label: 'Distribute vertically', disabled: sel.length < 3, action: () => arrangeSel('distribute-v') },
    ] },
    { label: 'Rotate and flip', sub: [
      { label: 'Rotate 90° clockwise', action: () => arrangeSel('rotate-cw') },
      { label: 'Rotate 90° counter-clockwise', action: () => arrangeSel('rotate-ccw') },
      { label: 'Reset rotation', disabled: !sel.some(s => s.style.rotate), action: () => arrangeSel('rotate-reset') },
      { sep: true },
      { label: 'Flip horizontally', action: () => arrangeSel('flip-h') },
      { label: 'Flip vertically', action: () => arrangeSel('flip-v') },
    ] },
    ...(sel.length > 1 ? [{ label: 'Group', shortcut: 'Ctrl+G', action: () => arrangeSel('group') }] : []),
    ...(sel.some(s => s.kind === 'group') ? [{ label: 'Ungroup', shortcut: 'Ctrl+Shift+G', action: () => arrangeSel('ungroup') }] : []),
    sel.every(s => s.locked) ? { label: 'Unlock', action: () => arrangeSel('unlock') } : { label: 'Lock', action: () => arrangeSel('lock') },
  ];

  const objectMenu = (x: number, y: number) => {
    if (!sel.length) { emptySlideMenu(x, y, currentRef.current); return; }
    const one = sel.length === 1 ? sel[0] : null;
    const items: MenuItem[] = [
      ...(one && one.canText ? [{ label: 'Edit text', shortcut: 'Enter', action: () => toCanvas({ ol: 'editText', path: one.path }) }] : []),
      ...(one && one.kind === 'image' ? [
        { label: 'Crop', action: imageTools.crop },
        { label: 'Remove background', action: imageTools.removeBackground },
        { label: 'Replace picture…', action: imageTools.replace },
      ] : []),
      { label: 'Edit code', action: () => showCode() },
      { sep: true },
      { label: 'Duplicate', shortcut: 'Ctrl+D', action: duplicateSel },
      { label: 'Delete', shortcut: 'Del', disabled: sel.every(s => s.locked), action: removeSel },
      { sep: true },
      ...arrangeItems(),
    ];
    showContextMenu(x, y, items);
  };

  const pickAt = (x: number, y: number, title: string, render: (close: () => void) => ComponentChildren) => { closeContextMenu(); setFloatPop({ x, y, title, render }); };
  const canvasItems = (x: number, y: number): MenuItem[] => {
    const v = viewRef.current;
    return [
      { label: 'Canvas colour', sub: [
        { label: 'Same as the page', checked: v.desk === null && !v.deskChecker, action: () => setView({ desk: null, deskChecker: false }) },
        ...(colors?.page ? [{ label: 'The slides’ colour', action: () => setView({ desk: colors.page, deskChecker: false }) }] : []),
        { label: 'White', checked: v.desk === '#ffffff', action: () => setView({ desk: '#ffffff', deskChecker: false }) },
        { label: 'Light grey', checked: v.desk === '#e8eaed', action: () => setView({ desk: '#e8eaed', deskChecker: false }) },
        { label: 'Dark grey', checked: v.desk === '#3c4043', action: () => setView({ desk: '#3c4043', deskChecker: false }) },
        { label: 'Black', checked: v.desk === '#000000', action: () => setView({ desk: '#000000', deskChecker: false }) },
        { label: 'Other colour…', action: () => pickAt(x, y, 'Canvas colour', close => <ColorGrid current={v.desk} close={close} none="Same as the page" onPick={c => setView({ desk: c, deskChecker: false })} />) },
      ] },
      { label: 'Checkerboard canvas', checked: v.deskChecker, action: () => setView({ deskChecker: !v.deskChecker }) },
      { label: 'Checkerboard under the slides (shows transparency)', checked: v.pageChecker, action: () => setView({ pageChecker: !v.pageChecker }) },
      { sep: true },
      { label: zoomRef.current > 1.01 ? 'Fit the slide' : 'Back to the slide', action: fitSlide },
    ];
  };
  const canvasMenu = (x: number, y: number) => showContextMenu(x, y, canvasItems(x, y));
  const emptySlideMenu = (x: number, y: number, i: number) => {
    const ps = slidePaths(text.toString());
    const sp = ps[i];
    showContextMenu(x, y, [
      { label: 'Text box', action: () => insertObject('text') },
      { label: 'Picture…', action: () => fileInput.current?.click() },
      ...(kind !== 'page' ? [
        { sep: true },
        { label: 'Slide background colour…', disabled: !sp || readOnlyRef.current, action: () => pickAt(x, y, 'Slide background', close => <ColorGrid current={null} close={close} none="As the design has it" onPick={c => { if (sp) applyOps([{ t: 'style', path: sp, set: { background: c } }]); }} />) },
        { label: 'New slide', shortcut: 'Ctrl+M', action: () => newSlide(i) },
        { label: 'Duplicate slide', action: () => duplicateSlide(i) },
      ] : []),
      { sep: true },
      { label: 'Canvas', sub: canvasItems(x, y) },
    ]);
  };

  /* ------------------------------------------------------------- slides */

  const newSlide = (after: number, blank = false) => {
    const cur = text.toString();
    const ps = slidePaths(cur);
    const html = newSlideHtml(cur, after, blank);
    if (!html || !ps.length) return;
    const p = ps[Math.min(after, ps.length - 1)];
    const parent = p.slice(0, -1);
    if (!applyOps([{ t: 'insert', parent, index: p[p.length - 1] + 1, html }])) return;
    const next = after + 1;
    setTimeout(() => { setCurrent(next); toCanvas({ ol: 'scrollTo', slide: next }); toRail({ ol: 'current', slide: next }); }, 150);
  };
  const duplicateSlide = (i: number) => { const p = slidePaths(text.toString())[i]; if (p) applyOps([{ t: 'duplicate', paths: [p] }]); };
  const deleteSlide = (i: number) => { const ps = slidePaths(text.toString()); if (ps.length > 1 && ps[i]) applyOps([{ t: 'remove', paths: [ps[i]] }]); };
  const moveSlide = (i: number, d: -1 | 1) => {
    const ps = slidePaths(text.toString());
    const p = ps[i], q = ps[i + d];
    if (!p || !q) return;
    const parent = p.slice(0, -1);
    // the index among the siblings without the slide itself
    const qi = q[q.length - 1] - (q[q.length - 1] > p[p.length - 1] ? 1 : 0);
    applyOps([{ t: 'move', path: p, parent, index: d > 0 ? qi + 1 : qi }]);
    setCurrent(i + d);
  };
  const slideMenu = (x: number, y: number, i: number) => {
    const n = slides.length;
    showContextMenu(x, y, [
      { label: 'New slide', action: () => newSlide(i) },
      { label: 'Blank slide', action: () => newSlide(i, true) },
      { label: 'Duplicate slide', action: () => duplicateSlide(i) },
      { sep: true },
      { label: 'Move up', disabled: i <= 0, action: () => moveSlide(i, -1) },
      { label: 'Move down', disabled: i >= n - 1, action: () => moveSlide(i, 1) },
      { sep: true },
      { label: 'Edit code', action: () => { const p = slidePaths(text.toString())[i]; if (p) showCode(p); } },
      { label: 'Delete slide', disabled: n <= 1, action: () => deleteSlide(i) },
    ]);
  };

  /* ------------------------------------------------------------- keys */

  const onRuntimeKey = (m: Extract<FromRuntime, { ol: 'key' }>) => {
    const mod = m.ctrl || m.meta;
    const k = m.key.toLowerCase();
    if (mod && k === 'z') { if (m.shift) host.redo(); else host.undo(); return; }
    if (mod && k === 'y') { host.redo(); return; }
    if (mod && k === 's') { if (host.save) host.save(); else notify('Saved automatically.'); return; }
    if (m.key === 'F5' || (mod && m.key === 'Enter')) { startPresenting(); return; }
    if (mod && k === 'g') { arrangeSel(m.shift ? 'ungroup' : 'group'); return; }
    if (mod && m.key === 'ArrowUp') { arrangeSel(m.shift ? 'front' : 'forward'); return; }
    if (mod && m.key === 'ArrowDown') { arrangeSel(m.shift ? 'back' : 'backward'); return; }
    if (mod && k === 'm' && kindRef.current === 'deck') { newSlide(currentRef.current); return; }
    if (mod && m.shift && (m.key === '>' || m.key === '.')) { fontSize(1); return; }
    if (mod && m.shift && (m.key === '<' || m.key === ',')) { fontSize(-1); return; }
    if (mod && m.shift && k === 'l') { textActions.align('left'); return; }
    if (mod && m.shift && k === 'e') { textActions.align('center'); return; }
    if (mod && m.shift && k === 'r') { textActions.align('right'); return; }
    if (mod && m.shift && k === 'j') { textActions.align('justify'); return; }
    if (mod && m.key === '\\') { textActions.clear(); return; }
    if (mod && k === '0') { fitSlide(); return; }
    if (mod && (m.key === '=' || m.key === '+')) { zoomStep(1.25); return; }
    if (mod && m.key === '-') { zoomStep(1 / 1.25); return; }
    if (m.key === 'Escape') { setToolState('select'); return; }
    if (!mod && !m.alt) {
      const map: Record<string, Tool> = { t: 'text', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', p: 'pen', v: 'select' };
      if (map[k]) { setToolState(map[k]); return; }
    }
    host.key?.(m);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!canvasBox.current?.closest('.dl-editor')?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if ((e.target as HTMLElement)?.closest?.('textarea, input')) return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) host.redo(); else host.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); host.redo(); }
      else if (e.key === 'F5') { e.preventDefault(); startPresenting(); }
      // the focus left the canvas (a toolbar button, a palette): its shortcuts still work on the selection
      else if (mod && ['g', 'm', '0', '=', '+', '-', '\\'].includes(e.key.toLowerCase()) || (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) { e.preventDefault(); onRuntimeKey({ ol: 'key', key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }); }
      else if (mod && e.key.toLowerCase() === 'd' && selRef.current.length) { e.preventDefault(); duplicateSel(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current.length) { e.preventDefault(); removeSel(); }
      else if (!mod && !e.altKey && e.key.length === 1 && !readOnlyRef.current) {
        // the tools' letters also before the canvas has the focus
        const map: Record<string, Tool> = { t: 'text', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', p: 'pen', v: 'select' };
        const t = map[e.key.toLowerCase()];
        if (t) { e.preventDefault(); setToolState(t); }
      }
      else if (e.key === 'Escape') setToolState('select');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  /* ------------------------------------------------------------- presenting */

  const presentBox = useRef<HTMLDivElement>(null);
  /** the presented slide is zoomed in: Escape (which leaves full screen first) only zooms out */
  const presentZoomed = useRef(false);
  const startPresenting = () => {
    presentZoomed.current = false;
    if (link && host.present?.(src('present') + `#${currentRef.current + 1}`)) return;
    setPresenting(true);
    setTimeout(() => {
      void presentBox.current?.requestFullscreen?.().catch(() => undefined);
      presentFrame.current?.focus();
    }, 30);
  };
  const stopPresenting = () => {
    setPresenting(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };
  useEffect(() => {
    const onFs = () => {
      if (document.fullscreenElement || !presenting) return;
      if (presentZoomed.current) { presentZoomed.current = false; toFrame(presentFrame.current, { ol: 'unzoom' }); return; }
      setPresenting(false);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [presenting]);
  useEffect(() => { if (!presenting && slides[current]) { toCanvas({ ol: 'scrollTo', slide: current }); toRail({ ol: 'current', slide: current }); } }, [presenting]);

  /* ------------------------------------------------------------- code view */

  const codeRef = useRef<HTMLTextAreaElement>(null);
  const codeSync = (origin: unknown) => {
    const ta = codeRef.current;
    if (!ta || origin === 'code') return;
    const v = text.toString();
    if (ta.value === v) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const old = ta.value;
    ta.value = v;
    // the caret kept where it was relative to the text around it
    let p = 0;
    while (p < old.length && p < v.length && old[p] === v[p]) p++;
    const shift = v.length - old.length;
    ta.setSelectionRange(s > p ? s + shift : s, e > p ? e + shift : e);
  };
  const onCodeInput = () => {
    const ta = codeRef.current;
    if (!ta || readOnlyRef.current) return;
    const old = text.toString(), v = ta.value;
    let p = 0;
    const max = Math.min(old.length, v.length);
    while (p < max && old[p] === v[p]) p++;
    let s = 0;
    while (s < max - p && old[old.length - 1 - s] === v[v.length - 1 - s]) s++;
    applySplices([{ from: p, to: old.length - s, insert: v.slice(p, v.length - s) }], 'code');
    sendSource();
  };
  useEffect(() => { if (codeOpen && codeRef.current) codeRef.current.value = text.toString(); }, [codeOpen]);

  /* ------------------------------------------------------------- notes */

  const curSlidePath = slides[current]?.path ?? null;
  const notes = curSlidePath && kind === 'deck' ? slideNotes(text.toString(), curSlidePath).text : '';
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const saveNotes = (v: string) => {
    if (!curSlidePath || readOnlyRef.current) return;
    const op = notesOp(text.toString(), curSlidePath, v);
    if (op) applyOps([op]);
  };

  /* ------------------------------------------------------------- render */

  const src = (mode: string) => (link ? `${link.base}${link.entry.split('/').map(encodeURIComponent).join('/')}?ol=${mode}` : 'about:blank');
  const frameH = Math.max(100, box.h / scale);
  const left = leftFor(scale, panX);
  const title = path.split('/').slice(-2).join('/');
  const bars = deckToolbar({
    kind, tool, setTool, readOnly, sel, editingText: !!editingText,
    undo: () => host.undo(), redo: () => host.redo(),
    insertImage: () => fileInput.current?.click(),
    text: textActions, paint, arrange: arrangeSel, image: imageTools, remove: removeSel,
    slideBackground: c => { const sp = slidePaths(text.toString())[currentRef.current]; if (sp) applyOps([{ t: 'style', path: sp, set: { background: c } }]); },
    canvas: { view, set: setView },
    newSlide: () => newSlide(currentRef.current),
  });

  // the slide in view: is enough of it on the screen? (zoomed into a corner, or scrolled away from it)
  const curBox = slides[current]?.rect;
  let lost = false;
  if (curBox && kind !== 'page' && box.w > 0) {
    const vx0 = -left / scale, vx1 = (box.w - left) / scale, vy0 = scrollY, vy1 = scrollY + box.h / scale;
    const ix = Math.max(0, Math.min(vx1, curBox.x + curBox.w) - Math.max(vx0, curBox.x));
    const iy = Math.max(0, Math.min(vy1, curBox.y + curBox.h) - Math.max(vy0, curBox.y));
    const seen = (ix * iy) / Math.max(1, curBox.w * curBox.h);
    const fills = (ix * iy) / Math.max(1, (vx1 - vx0) * (vy1 - vy0));
    lost = seen < 0.35 && fills < 0.6;
  }
  const zoomed = zoom > 1.01;

  return (
    <div class={'dl-editor' + (presenting ? ' presenting' : '')} data-kind={kind}>
      <div class="dl-toolbar" role="toolbar">
        <span class="dl-title" title={path}>{title}</span>
        <Toolbar id="deck-tools" groups={bars.tools} />
        <input ref={fileInput} type="file" accept="image/*,.svg" multiple hidden onChange={e => { const fs = Array.from((e.target as HTMLInputElement).files ?? []); (e.target as HTMLInputElement).value = ''; void uploadImages(fs.map(f => ({ name: f.name, type: f.type, data: f })), null); }} />
        <input ref={replaceInput} type="file" accept="image/*,.svg" hidden onChange={e => { const fs = Array.from((e.target as HTMLInputElement).files ?? []); (e.target as HTMLInputElement).value = ''; void replacePicture(fs); }} />
        <div class="dl-ctx">{bars.context.length > 0 && <Toolbar id="deck-context" groups={bars.context} />}</div>
        {kind === 'page' && <>
          <button class={'dl-btn' + (device === 'desktop' ? ' on' : '')} title="Desktop width" onClick={() => setDevice('desktop')}>🖥</button>
          <button class={'dl-btn' + (device === 'mobile' ? ' on' : '')} title="Phone width" onClick={() => setDevice('mobile')}>📱</button>
        </>}
        <span class="dl-zoomgroup">
          <button class="dl-btn" title="Zoom out (Ctrl+−)" onClick={() => zoomStep(1 / 1.25)}>−</button>
          <button class="dl-btn dl-zoom" title="Fit (Ctrl+0)" onClick={fitSlide}>{Math.round(scale * 100)}%</button>
          <button class="dl-btn" title="Zoom in (Ctrl+=)" onClick={() => zoomStep(1.25)}>+</button>
        </span>
        <button class={'dl-btn' + (codeOpen ? ' on' : '')} title="The page's code" data-dl-code onClick={() => setCodeOpen(o => !o)}>&lt;/&gt;</button>
        {kind !== 'page' && <button class="dl-btn dl-present" title="Present (F5)" data-dl-present onClick={startPresenting}>▶ Present</button>}
        <button class="dl-btn" title="Download" data-dl-download onClick={e => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          showContextMenu(r.left, r.bottom + 4, host.downloads(m => src(m === 'view' && kind === 'deck' ? 'present' : m)));
        }}>⤓</button>
        <span class={'dl-status' + (online ? '' : ' off')}>{!synced ? 'Loading…' : !online ? 'Offline' : readOnly ? 'View only' : ''}</span>
      </div>
      <div class="dl-body">
        {showRail && (
          <div class="dl-rail" ref={railBox}>
            {link && synced && <iframe ref={railFrame} class="dl-railframe" title="Slides" sandbox="allow-scripts" src={src('thumb')}
              style={{ width: `${frameW}px`, height: `${railH / railScale}px`, transform: `scale(${railScale})` }} />}
            <div class="dl-rail-actions">
              <button class="dl-btn" title="New slide after this one (Ctrl+M)" data-dl-newslide disabled={readOnly} onClick={() => newSlide(current)}>+ Slide</button>
            </div>
          </div>
        )}
        <div class="dl-main">
          <div class="dl-canvas" ref={canvasBox} style={deskCss ? { background: deskCss } : undefined} data-desk={view.deskChecker ? 'checker' : view.desk ? 'custom' : 'page'}
            onContextMenu={e => { if (e.target === e.currentTarget) { e.preventDefault(); canvasMenu(e.clientX, e.clientY); } }}
            onWheel={e => { if (e.target !== e.currentTarget) return; if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomStep(Math.exp(-e.deltaY * 0.01)); } else if (e.deltaX || e.shiftKey) setPanX(p => p - (e.deltaX || e.deltaY)); }}
            onDragOver={e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
            onDrop={e => { if (!e.dataTransfer?.files.length) return; e.preventDefault(); const fs = Array.from(e.dataTransfer.files); void placeFiles(fs.map(f => ({ name: f.name, type: f.type, data: f })), null, null); }}>
            {link && synced && <iframe ref={canvasFrame} class="dl-frame" title="Page" sandbox="allow-scripts allow-modals allow-popups allow-forms" src={src('edit')}
              style={{ width: `${frameW}px`, height: `${frameH}px`, transform: `scale(${scale})`, left: `${left}px` }} />}
            {(lost || zoomed) && kind !== 'page' && (
              <button type="button" class={'dl-refocus' + (lost ? ' lost' : '')} data-dl-refocus onClick={fitSlide} title="Show the whole slide again (Ctrl+0)">
                {lost ? `⤢ Back to slide ${current + 1}` : '⤢ Fit slide'}
              </button>
            )}
          </div>
          {kind === 'deck' && (
            <div class="dl-notes">
              <textarea placeholder="Speaker notes" value={notesDraft ?? notes} disabled={readOnly || !curSlidePath} data-dl-notes
                onInput={e => setNotesDraft((e.target as HTMLTextAreaElement).value)}
                onBlur={e => { saveNotes((e.target as HTMLTextAreaElement).value); setNotesDraft(null); }} />
            </div>
          )}
        </div>
        {codeOpen && (
          <div class="dl-code">
            <div class="dl-code-head"><span>{path.split('/').pop()}</span><button class="dl-btn" onClick={() => setCodeOpen(false)} title="Close">×</button></div>
            <textarea ref={codeRef} spellcheck={false} readOnly={readOnly} onInput={onCodeInput} data-dl-codearea
              onKeyDown={e => { if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); } }} />
          </div>
        )}
      </div>
      {floatPop && <FloatPopover {...floatPop} onClose={() => setFloatPop(null)} />}
      {bgFor && <BgRemoveDialog src={bgFor.url} name={bgFor.name} onDone={b => { void saveNoBg(b); }} onClose={() => setBgFor(null)} />}
      {presenting && link && (
        <div class="dl-presenting" ref={presentBox}>
          <iframe ref={presentFrame} title="Presentation" sandbox="allow-scripts allow-popups" src={src('present') + `#${current + 1}`} />
        </div>
      )}
    </div>
  );
}

/** a picker opened from a context menu, where the menu was */
function FloatPopover({ x, y, title, render, onClose }: { x: number; y: number; title: string; render: (close: () => void) => ComponentChildren; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const t = setTimeout(() => { document.addEventListener('mousedown', down); }, 0);
    document.addEventListener('keydown', key);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth - 8) el.style.left = `${Math.max(8, innerWidth - 8 - r.width)}px`;
    if (r.bottom > innerHeight - 8) el.style.top = `${Math.max(8, innerHeight - 8 - r.height)}px`;
  }, []);
  return (
    <div ref={ref} class="tb-popup dl-floatpop" style={{ left: `${x}px`, top: `${y}px` }} role="dialog" aria-label={title}>
      <div class="tb-popup-title">{title}</div>
      {render(onClose)}
    </div>
  );
}

export default DeliverableEditor;
