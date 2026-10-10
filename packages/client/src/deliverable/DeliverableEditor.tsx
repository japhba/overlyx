/**
 * The editor of HTML deliverables — slide decks, posters, web pages (core html/): the page itself,
 * rendered in a sandboxed frame by the runtime (runtime/), is the canvas; this component owns the
 * text. The text is a Y.Text synced like any document (server docs.ts HtmlDoc), so people, agents
 * (the MCP file tools) and the code view all edit the same characters live. What people do on the
 * canvas arrives as operations on the version the frame showed, is rebased onto the text as it is
 * now (sourceops.ts) and applied as splices — nothing else of the file changes.
 *
 * Around the canvas: the slide rail (a second frame, small), the toolbar (insert objects, format the
 * selection, arrange), speaker notes, the code (a textarea on the same Y.Text), presenting (a third
 * frame, full screen), and downloads (PDF, a self-contained .zip).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as decoding from 'lib0/decoding';
import { splitDocId } from '@overlyx/core';
import { api, type User } from '../api';
import { showContextMenu, closeContextMenu, type MenuItem } from '../editor/contextmenu';
import type { FromRuntime, ToRuntime, SelItem, SlideBox, Tool, Path, HtmlOp, DeliverableKind, Rect } from './protocol';
import { isFromRuntime } from './protocol';
import { rebasedSplices, objectHtml, imageHtml, insertPlace, newSlideHtml, slidePaths, slideNotes, notesOp, sourceRange } from './sourceops';
import { parseSource, opSplices, elementAt, elementChildren } from '@overlyx/core/html/source.ts';
import { subscribeProjectEvents } from '../projectevents';

const LOCAL = 'local';
const PAD = 48;

type Notify = (text: string, kind?: 'info' | 'error') => void;

interface Link { base: string; entry: string; expires: number }

export function DeliverableEditor({ id, user, notify }: { id: string; user: User; notify: Notify }) {
  const { project, path } = splitDocId(id);
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const [, bump] = useState(0);
  const rerender = () => bump(t => t + 1);

  /* ------------------------------------------------------------- the text, synced */

  const conn = useMemo(() => {
    const ydoc = new Y.Doc();
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const provider = new WebsocketProvider(wsUrl, '', ydoc, { params: { doc: id }, disableBc: true });
    const handlers = (provider as unknown as { messageHandlers: ((enc: unknown, dec: decoding.Decoder) => void)[] }).messageHandlers;
    handlers[2] = (_e, dec) => { decoding.readVarString(dec); };
    handlers[3] = (_e, dec) => { decoding.readVarUint(dec); decoding.readVarUint8Array(dec); };
    handlers[4] = () => {};
    handlers[5] = (_e, dec) => { Y.applyUpdate(ydoc, decoding.readVarUint8Array(dec), 'agent'); };
    provider.awareness.setLocalStateField('user', { name: user.name, color: user.color, username: user.username, avatar: user.avatar ?? null });
    const text = ydoc.getText('html');
    const undo = new Y.UndoManager(text, { trackedOrigins: new Set([LOCAL, 'agent']), captureTimeout: 600 });
    return { ydoc, provider, text, undo };
  }, [id]);
  const { ydoc, provider, text, undo } = conn;

  const [synced, setSynced] = useState(false);
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

  /** the address of the folder for this account; renewed before it expires */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const get = () => api.deliverableLink(project, path).then(l => {
      if (cancelled) return;
      setLink(prev => prev ?? l);
      timer = setTimeout(get, Math.max(60000, l.expires - Date.now() - 10 * 60000));
    }).catch(e => { if (!cancelled) notify('Could not open the page: ' + (e as Error).message, 'error'); });
    void get();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [project, path]);

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
    const onText = (_e: Y.YTextEvent, tr: Y.Transaction) => { sendSource(tr.origin === LOCAL); codeSync(tr.origin); rerender(); };
    text.observe(onText);
    const onStatus = ({ status }: { status: string }) => setOnline(status === 'connected');
    const onSync = (s: boolean) => { if (s) { setSynced(true); sendSource(true); } };
    provider.on('status', onStatus);
    provider.on('sync', onSync);
    if (provider.synced) onSync(true);
    void api.readText(project, path).then(r => setReadOnly(r.role === 'view')).catch(() => {});
    const onAwareness = () => sendPeers();
    provider.awareness.on('change', onAwareness);
    const onDisconnect = (e: { code?: number; reason?: string } | CloseEvent) => { if ((e as CloseEvent).code === 4001) notify('This page was removed or renamed on disk.', 'error'); };
    provider.on('connection-close', onDisconnect as never);
    return () => {
      text.unobserve(onText);
      provider.off('status', onStatus);
      provider.off('sync', onSync);
      provider.awareness.off('change', onAwareness);
      provider.awareness.setLocalState(null);
      provider.destroy();
      ydoc.destroy();
    };
  }, [conn]);

  /* ------------------------------------------------------------- changes of the text */

  /** splices into the Y.Text, as one undo step */
  const applySplices = (splices: { from: number; to: number; insert: string }[], origin = LOCAL) => {
    if (readOnlyRef.current || !splices.length) return;
    ydoc.transact(() => {
      for (const s of [...splices].sort((a, b) => b.from - a.from || b.to - a.to)) {
        if (s.to > s.from) text.delete(s.from, s.to - s.from);
        if (s.insert) text.insert(s.from, s.insert);
      }
    }, origin);
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
            if (synced || provider.synced) toCanvas({ ol: 'source', version: version.current, html: versions.current.get(version.current) ?? text.toString() });
          } else {
            railReady.current = true;
            toRail({ ol: 'scale', scale: railScale });
            if (synced || provider.synced) toRail({ ol: 'source', version: version.current, html: text.toString() });
            toRail({ ol: 'current', slide: currentRef.current });
          }
          break;
        case 'layout':
          if (fromCanvas) {
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
        case 'selection': if (fromCanvas) { setSel(m.items); sendAwareness(m.items.map(i => i.path)); } break;
        case 'editing': if (fromCanvas) setEditingText(m.path); break;
        case 'visible': if (fromCanvas && m.slide >= 0) { setCurrent(m.slide); toRail({ ol: 'current', slide: m.slide }); } break;
        case 'goto': setCurrent(m.slide); toCanvas({ ol: 'scrollTo', slide: m.slide, smooth: false }); toRail({ ol: 'current', slide: m.slide }); break;
        case 'ops': {
          if (readOnlyRef.current) { notify('You can only view this page.', 'error'); sendSource(true); break; }
          const before = text.toString();
          const ok = applyRuntimeOps(m.version, m.ops);
          if (ok && m.select === 'inserted') {
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
        case 'draw': onDraw(m.version, m.tool, m.slide, m.rect, m.after ?? null); break;
        case 'key': onRuntimeKey(m); break;
        case 'contextmenu': {
          const f = (fromRail ? railFrame : canvasFrame).current;
          if (!f) break;
          const r = f.getBoundingClientRect();
          const s = fromRail ? railScale : scale;
          const x = r.left + m.x * s, y = r.top + m.y * s;
          if (fromRail) slideMenu(x, y, m.slide ?? currentRef.current);
          else objectMenu(x, y);
          break;
        }
        case 'pasteFiles': void pasteFiles(m.files, m.slide); break;
        case 'reload': canvasReady.current = canvasReady.current && !fromCanvas; if (fromRail) railReady.current = false; break;
      }
    };
    addEventListener('message', onMessage);
    const onBlur = () => setTimeout(() => { if (document.activeElement?.tagName === 'IFRAME') closeContextMenu(); }, 0);
    addEventListener('blur', onBlur);
    return () => { removeEventListener('message', onMessage); removeEventListener('blur', onBlur); };
  });

  /* ------------------------------------------------------------- files of the page changed on disk */

  useEffect(() => subscribeProjectEvents(project, ev => {
    if (ev.kind !== 'graphics') return;
    toCanvas({ ol: 'asset', path: ev.path, v: ev.v });
    toRail({ ol: 'asset', path: ev.path, v: ev.v });
  }), [project]);

  /* ------------------------------------------------------------- sizes */

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
  useEffect(() => { toCanvas({ ol: 'scale', scale }); }, [scale]);
  useEffect(() => { toRail({ ol: 'scale', scale: railScale }); }, [railScale]);
  useEffect(() => { toCanvas({ ol: 'tool', tool }); }, [tool]);

  /* ------------------------------------------------------------- presence */

  const sendAwareness = (paths: Path[]) => { try { provider.awareness.setLocalStateField('htmlSel', { paths, v: version.current }); } catch { /* closing */ } };
  const sendPeers = () => {
    const peers: { paths: Path[]; color: string; name: string }[] = [];
    provider.awareness.getStates().forEach((st, client) => {
      if (client === ydoc.clientID) return;
      const s = st as { user?: { name?: string; color?: string }; htmlSel?: { paths?: Path[] } };
      if (s.htmlSel?.paths?.length) peers.push({ paths: s.htmlSel.paths, color: s.user?.color ?? '#888', name: s.user?.name ?? '' });
    });
    toCanvas({ ol: 'peers', peers });
  };

  /* ------------------------------------------------------------- tools and objects */

  const setTool = (t: Tool) => { setToolState(t); };

  const onDraw = (v: number, t: Tool, slide: Path | null, rect: Rect, after: Path | null) => {
    setToolState('select');
    if (readOnlyRef.current) return;
    if (versions.current.get(v) === undefined) return;
    const cur = text.toString();
    const k = kindRef.current;
    const place = insertPlace(cur, slide, after, k);
    if (!place) return;
    const html = objectHtml(t, rect, k, pageW / 1280);
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
  const uploadImages = async (files: { name: string; type: string; data: Blob | ArrayBuffer }[], slide: Path | null) => {
    if (readOnlyRef.current) return;
    const k = kindRef.current;
    let k2 = 0;
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue;
      const ext = (f.name.split('.').pop() || f.type.split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      const base = (f.name.replace(/\.[^.]+$/, '') || 'image').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'image';
      let name = `${base}.${ext}`, rel = '';
      for (let i = 1; i < 50; i++) {
        rel = (dir ? dir + '/' : '') + 'images/' + name;
        try { await api.upload(project, rel, f.data instanceof Blob ? f.data : new Blob([f.data], { type: f.type }), { overwrite: false }); break; }
        catch { name = `${base}-${i}.${ext}`; rel = ''; }
      }
      if (!rel) continue;
      const cur = text.toString();
      const slidePath = slide ?? (k !== 'page' ? slides[currentRef.current]?.path ?? null : null);
      const place = insertPlace(cur, slidePath, selRef.current[0]?.path ?? null, k);
      if (!place) continue;
      const w = pageW;
      const html = imageHtml('images/' + name, k === 'page' ? null : { x: w * 0.25 + k2 * 24, y: 120 + k2 * 24, w: w * 0.4, h: 0 }, k);
      applyOps([{ t: 'insert', parent: place.parent, index: place.index, html }]);
      pending.current = { select: [place.path] };
      k2++;
    }
  };
  const pasteFiles = (files: { name: string; type: string; data: ArrayBuffer }[], slide: Path | null) => uploadImages(files, slide);

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
  const toggleBold = () => {
    if (editingText) { toCanvas({ ol: 'exec', command: 'bold' }); return; }
    const bold = sel.every(s => Number(s.style.fontWeight) >= 600);
    styleSel({ 'font-weight': bold ? '400' : '700' });
  };
  const toggleItalic = () => {
    if (editingText) { toCanvas({ ol: 'exec', command: 'italic' }); return; }
    const it = sel.every(s => s.style.fontStyle === 'italic');
    styleSel({ 'font-style': it ? 'normal' : 'italic' });
  };
  const align = (a: string) => styleSel({ 'text-align': a });
  const color = (c: string) => { if (editingText) toCanvas({ ol: 'exec', command: 'foreColor', value: c }); else styleSel({ color: c }); };
  const fill = (c: string) => styleSel({ background: c === 'transparent' ? null : c });

  const removeSel = () => { if (sel.length) applyOps([{ t: 'remove', paths: sel.map(s => s.path) }]); };
  const duplicateSel = () => { if (sel.length) applyOps([{ t: 'duplicate', paths: sel.map(s => s.path) }]); };
  /** to the front: last among its siblings (painted last); to the back: first */
  const arrange = (where: 'front' | 'back') => {
    if (sel.length !== 1) return;
    const p = sel[0].path;
    const parent = p.slice(0, -1);
    const { doc } = parseSource(text.toString());
    const par = elementAt(doc, parent);
    if (!par) return;
    const n = elementChildren(par).length;
    applyOps([{ t: 'move', path: p, parent, index: where === 'front' ? n - 1 : 0 }]);
  };

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

  const objectMenu = (x: number, y: number) => {
    const items: MenuItem[] = sel.length ? [
      ...(sel.length === 1 && sel[0].text ? [{ label: 'Edit text', shortcut: 'Enter', action: () => toCanvas({ ol: 'editText', path: sel[0].path }) }] : []),
      { label: 'Edit code', action: () => showCode() },
      { sep: true },
      { label: 'Duplicate', shortcut: 'Ctrl+D', action: duplicateSel },
      { label: 'Delete', shortcut: 'Del', action: removeSel },
      { sep: true },
      { label: 'Bring to front', disabled: sel.length !== 1, action: () => arrange('front') },
      { label: 'Send to back', disabled: sel.length !== 1, action: () => arrange('back') },
    ] : [
      { label: 'Text box', action: () => insertObject('text') },
      { label: 'Picture…', action: () => fileInput.current?.click() },
      ...(kind !== 'page' ? [{ sep: true }, { label: 'New slide', action: () => newSlide(currentRef.current) }] : []),
    ];
    showContextMenu(x, y, items);
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
    if (mod && k === 'z') { if (m.shift) undo.redo(); else undo.undo(); return; }
    if (mod && k === 'y') { undo.redo(); return; }
    if (mod && k === 's') { notify('Saved automatically.'); return; }
    if (m.key === 'F5' || (mod && m.key === 'Enter')) { startPresenting(); return; }
    if (m.key === 'Escape') { setToolState('select'); return; }
    if (!mod && !m.alt) {
      const map: Record<string, Tool> = { t: 'text', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', v: 'select' };
      if (map[k]) setToolState(map[k]);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!canvasBox.current?.closest('.dl-editor')?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if ((e.target as HTMLElement)?.closest?.('textarea, input')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) undo.redo(); else undo.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); undo.redo(); }
      else if (e.key === 'F5') { e.preventDefault(); startPresenting(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  /* ------------------------------------------------------------- presenting */

  const presentBox = useRef<HTMLDivElement>(null);
  const startPresenting = () => {
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
    const onFs = () => { if (!document.fullscreenElement && presenting) setPresenting(false); };
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
    ydoc.transact(() => {
      if (old.length - s > p) text.delete(p, old.length - s - p);
      if (v.length - s > p) text.insert(p, v.slice(p, v.length - s));
    }, 'code');
    sendSource();
  };
  useEffect(() => { if (codeOpen && codeRef.current) codeRef.current.value = text.toString(); }, [codeOpen]);
  // the code view's own edits are undone with the rest
  useEffect(() => { undo.addTrackedOrigin('code'); }, [undo]);

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
  const left = Math.max(0, (box.w - frameW * scale) / 2);
  const one = sel.length === 1 ? sel[0] : null;
  const fsPx = one ? Math.round(parseFloat(one.style.fontSize) || 0) : 0;
  const title = path.split('/').slice(-2).join('/');

  return (
    <div class={'dl-editor' + (presenting ? ' presenting' : '')} data-kind={kind}>
      <div class="dl-toolbar" role="toolbar">
        <span class="dl-title" title={path}>{title}</span>
        <span class="dl-sep" />
        <button class={'dl-btn' + (tool === 'select' ? ' on' : '')} title="Select (V)" data-dl-tool="select" onClick={() => setTool('select')}>⌖</button>
        <button class={'dl-btn' + (tool === 'text' ? ' on' : '')} title="Text box (T) — click or drag on the page" data-dl-tool="text" disabled={readOnly} onClick={() => insertObject('text')}>T</button>
        <button class={'dl-btn' + (tool === 'rect' ? ' on' : '')} title="Rectangle (R)" data-dl-tool="rect" disabled={readOnly} onClick={() => insertObject('rect')}>▭</button>
        <button class={'dl-btn' + (tool === 'ellipse' ? ' on' : '')} title="Ellipse (O)" data-dl-tool="ellipse" disabled={readOnly} onClick={() => insertObject('ellipse')}>◯</button>
        <button class={'dl-btn' + (tool === 'arrow' ? ' on' : '')} title="Arrow (A)" data-dl-tool="arrow" disabled={readOnly} onClick={() => insertObject('arrow')}>↗</button>
        <button class={'dl-btn' + (tool === 'formula' ? ' on' : '')} title="Formula (TeX)" data-dl-tool="formula" disabled={readOnly} onClick={() => insertObject('formula')}>∑</button>
        <button class="dl-btn" title="Picture…" data-dl-image disabled={readOnly} onClick={() => fileInput.current?.click()}>🖼</button>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={e => { const fs = Array.from((e.target as HTMLInputElement).files ?? []); (e.target as HTMLInputElement).value = ''; void uploadImages(fs.map(f => ({ name: f.name, type: f.type, data: f })), null); }} />
        <span class="dl-sep" />
        <button class="dl-btn" title="Smaller text" disabled={!sel.length || readOnly} onClick={() => fontSize(-1)} data-dl-smaller>A−</button>
        <span class="dl-fs" title="Font size of the selection">{fsPx ? `${fsPx}px` : ''}</span>
        <button class="dl-btn" title="Larger text" disabled={!sel.length || readOnly} onClick={() => fontSize(1)} data-dl-larger>A+</button>
        <button class="dl-btn" title="Bold (Ctrl+B)" disabled={(!sel.length && !editingText) || readOnly} onClick={toggleBold} style={{ fontWeight: 700 }}>B</button>
        <button class="dl-btn" title="Italic (Ctrl+I)" disabled={(!sel.length && !editingText) || readOnly} onClick={toggleItalic} style={{ fontStyle: 'italic' }}>I</button>
        <label class="dl-color" title="Text colour"><span style={{ borderBottomColor: one?.style.color ?? '#000' }}>A</span><input type="color" disabled={(!sel.length && !editingText) || readOnly} onInput={e => color((e.target as HTMLInputElement).value)} /></label>
        <label class="dl-color" title="Fill"><span class="dl-fill" style={{ background: one && one.style.background !== 'rgba(0, 0, 0, 0)' ? one.style.background : 'transparent' }} /><input type="color" disabled={!sel.length || readOnly} onInput={e => fill((e.target as HTMLInputElement).value)} /></label>
        <button class="dl-btn" title="Align left" disabled={!sel.length || readOnly} onClick={() => align('left')}>⯇</button>
        <button class="dl-btn" title="Centre" disabled={!sel.length || readOnly} onClick={() => align('center')}>≡</button>
        <button class="dl-btn" title="Align right" disabled={!sel.length || readOnly} onClick={() => align('right')}>⯈</button>
        <span class="dl-sep" />
        <button class="dl-btn" title="Bring to front" disabled={sel.length !== 1 || readOnly} onClick={() => arrange('front')}>⤒</button>
        <button class="dl-btn" title="Send to back" disabled={sel.length !== 1 || readOnly} onClick={() => arrange('back')}>⤓</button>
        <button class="dl-btn" title="Delete" disabled={!sel.length || readOnly} onClick={removeSel}>🗑</button>
        <span class="dl-grow" />
        {kind === 'page' && <>
          <button class={'dl-btn' + (device === 'desktop' ? ' on' : '')} title="Desktop width" onClick={() => setDevice('desktop')}>🖥</button>
          <button class={'dl-btn' + (device === 'mobile' ? ' on' : '')} title="Phone width" onClick={() => setDevice('mobile')}>📱</button>
        </>}
        <button class="dl-btn" title="Zoom out" onClick={() => setZoom(z => Math.max(0.25, z / 1.25))}>−</button>
        <button class="dl-btn dl-zoom" title="Fit" onClick={() => setZoom(1)}>{Math.round(scale * 100)}%</button>
        <button class="dl-btn" title="Zoom in" onClick={() => setZoom(z => Math.min(4, z * 1.25))}>+</button>
        <button class={'dl-btn' + (codeOpen ? ' on' : '')} title="The page's code" data-dl-code onClick={() => setCodeOpen(o => !o)}>&lt;/&gt;</button>
        {kind !== 'page' && <button class="dl-btn dl-present" title="Present (F5)" data-dl-present onClick={startPresenting}>▶ Present</button>}
        <button class="dl-btn" title="Download" data-dl-download onClick={e => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const q = `?path=${encodeURIComponent(path)}&download=1`;
          showContextMenu(r.left, r.bottom + 4, [
            { label: 'PDF', action: () => window.open(`/api/projects/${encodeURIComponent(project)}/deliverable-pdf${q}`, '_blank') },
            { label: 'Web page (.zip, works offline)', action: () => window.open(`/api/projects/${encodeURIComponent(project)}/deliverable-zip${q}`, '_blank') },
            { label: 'Open in a new tab', action: () => window.open(src(kind === 'deck' ? 'present' : 'view'), '_blank', 'noopener') },
          ]);
        }}>⤓ Download</button>
        <span class={'dl-status' + (online ? '' : ' off')}>{!synced ? 'Loading…' : !online ? 'Offline' : readOnly ? 'View only' : ''}</span>
      </div>
      <div class="dl-body">
        {showRail && (
          <div class="dl-rail" ref={railBox}>
            {link && synced && <iframe ref={railFrame} class="dl-railframe" title="Slides" sandbox="allow-scripts" src={src('thumb')}
              style={{ width: `${frameW}px`, height: `${railH / railScale}px`, transform: `scale(${railScale})` }} />}
            <div class="dl-rail-actions">
              <button class="dl-btn" title="New slide after this one" data-dl-newslide disabled={readOnly} onClick={() => newSlide(current)}>+ Slide</button>
            </div>
          </div>
        )}
        <div class="dl-main">
          <div class="dl-canvas" ref={canvasBox}>
            {link && synced && <iframe ref={canvasFrame} class="dl-frame" title="Page" sandbox="allow-scripts allow-modals allow-popups allow-forms" src={src('edit')}
              style={{ width: `${frameW}px`, height: `${frameH}px`, transform: `scale(${scale})`, left: `${left}px` }} />}
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
      {presenting && link && (
        <div class="dl-presenting" ref={presentBox}>
          <iframe ref={presentFrame} title="Presentation" sandbox="allow-scripts allow-popups" src={src('present') + `#${current + 1}`} />
        </div>
      )}
    </div>
  );
}

export default DeliverableEditor;
