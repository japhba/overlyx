/**
 * Whiteboard editor for .board documents: an infinite pan/zoom canvas with freehand ink
 * (pen/highlighter, pressure-sensitive), images (paste, drop or upload — move/resize like Miro)
 * and sticky notes. State is a Yjs map synced through the same websocket layer as the text
 * editor (docs.ts BoardDoc on the server), so everything is live-collaborative: finished objects
 * flow through the CRDT, in-progress strokes and cursors through the awareness channel.
 *
 * Objects live in Y.Map('objects'): id → { t, x, y, w, h, ... } (whole-object last-writer-wins;
 * strokes store their points relative to (x, y), normalised so the bounding box is (0,0,w,h) —
 * resizing scales the points). The server serialises the map to the .board JSON file on disk.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as decoding from 'lib0/decoding';
import { strokePathD, type InkStroke } from '@overlyx/core';
import { api, fileUrl, type User } from '../api';
import { imageFiles, imageExt, uploadBaseName, uploadUnique, isSvgMarkup, svgFile } from '../editor/imagepaste';
import { HIGHLIGHT_OPACITY } from '../editor/plugins/ink';

export interface BoardObj {
  t: 'stroke' | 'img' | 'note';
  x: number; y: number; w: number; h: number; z?: number;
  /** stroke */
  color?: string; sw?: number; o?: number; pts?: [number, number, number][];
  /** image (project-relative path) */
  src?: string;
  /** note */
  text?: string;
}

type Tool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'note';
interface Camera { tx: number; ty: number; s: number }
interface LiveStroke { color: string; w: number; o?: number; pts: [number, number, number][] }

const COLORS: [string, string][] = [['#202124', 'Black'], ['#1a73e8', 'Blue'], ['#d93025', 'Red'], ['#188038', 'Green'], ['#f29900', 'Orange'], ['#a142f4', 'Purple']];
const NOTE_COLORS = ['#fff3bf', '#d3f9d8', '#d0ebff', '#ffe3e3', '#f3f0ff'];
const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Normalise absolute stroke points into an object: bbox at (x, y), points relative. */
function strokeToObj(pts: [number, number, number][], color: string, sw: number, o?: number): BoardObj {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  return {
    t: 'stroke', x: round1(minX), y: round1(minY), w: round1(w), h: round1(h), color, sw, ...(o !== undefined ? { o } : {}),
    pts: pts.map(([x, y, p]) => [round1(x - minX), round1(y - minY), Math.round(p * 100) / 100] as [number, number, number]),
  };
}

const pathDCache = new WeakMap<object, string>();
function strokeD(obj: BoardObj): string {
  let d = pathDCache.get(obj as object);
  if (d === undefined) {
    d = strokePathD({ color: obj.color ?? '#000', w: obj.sw ?? 2, pts: obj.pts ?? [] } as InkStroke);
    pathDCache.set(obj as object, d);
  }
  return d;
}

export function BoardEditor({ id, user, notify }: { id: string; user: User; notify: (text: string, kind?: 'info' | 'error') => void }) {
  const project = id.split('/')[0];
  const path = id.slice(project.length + 1);
  const vpRef = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const rerender = () => bump(t => t + 1);
  const [cam, setCam] = useState<Camera>({ tx: 0, ty: 0, s: 1 });
  const camRef = useRef(cam); camRef.current = cam;
  const [tool, setToolState] = useState<Tool>('select');
  const toolRef = useRef(tool); toolRef.current = tool;
  const setTool = (t: Tool) => { setToolState(t); if (t !== 'select') setSelected(null); };
  const [color, setColor] = useState('#1a73e8');
  const colorRef = useRef(color); colorRef.current = color;
  const [width, setWidth] = useState(2.5);
  const widthRef = useRef(width); widthRef.current = width;
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [editing, setEditing] = useState<string | null>(null);
  const [conn, setConn] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [readOnly, setReadOnly] = useState(false);
  const readOnlyRef = useRef(readOnly); readOnlyRef.current = readOnly;
  const liveRef = useRef<LiveStroke | null>(null);
  const [peerTick, setPeerTick] = useState(0);

  /** Yjs document + provider, once per board. */
  const conn0 = useMemo(() => {
    const ydoc = new Y.Doc();
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const provider = new WebsocketProvider(wsUrl, '', ydoc, { params: { doc: id }, disableBc: true });
    const handlers = (provider as unknown as { messageHandlers: ((enc: unknown, dec: decoding.Decoder) => void)[] }).messageHandlers;
    handlers[2] = (_e, dec) => { decoding.readVarString(dec); };            // epoch (no local copy: nothing to compare)
    handlers[3] = (_e, dec) => { decoding.readVarUint(dec); decoding.readVarUint8Array(dec); };  // saved
    handlers[4] = () => {};                                                 // heartbeat
    handlers[5] = (_e, dec) => { Y.applyUpdate(ydoc, decoding.readVarUint8Array(dec), 'agent'); };
    provider.awareness.setLocalStateField('user', { name: user.name, color: user.color, username: user.username, avatar: user.avatar ?? null });
    const objects = ydoc.getMap<BoardObj>('objects');
    const undo = new Y.UndoManager(objects, { trackedOrigins: new Set(['local']) });
    return { ydoc, provider, objects, undo };
  }, [id]);
  const { ydoc, provider, objects, undo } = conn0;

  useEffect(() => {
    const onObjects = () => rerender();
    objects.observe(onObjects);
    const onStatus = ({ status }: { status: string }) => setConn(status === 'connected' ? 'online' : 'offline');
    provider.on('status', onStatus);
    const onSync = (s: boolean) => { if (s) { setConn('online'); fit(); } };
    provider.on('sync', onSync);
    const onAwareness = () => setPeerTick(t => t + 1);
    provider.awareness.on('change', onAwareness);
    void api.readText(project, path).then(r => setReadOnly(r.role === 'view')).catch(() => {});
    return () => {
      objects.unobserve(onObjects);
      provider.awareness.off('change', onAwareness);
      provider.awareness.setLocalState(null);
      provider.destroy();
      ydoc.destroy();
    };
  }, [conn0]);

  const mutate = (fn: () => void) => { if (!readOnlyRef.current) ydoc.transact(fn, 'local'); };

  /* ------------------------------------------------------------- camera */

  const toBoard = (clientX: number, clientY: number): [number, number] => {
    const r = vpRef.current!.getBoundingClientRect();
    const c = camRef.current;
    return [(clientX - r.left - c.tx) / c.s, (clientY - r.top - c.ty) / c.s];
  };

  /** Zoom-to-fit all objects (on first sync and the ⤢ button). */
  const fit = () => {
    const vp = vpRef.current;
    if (!vp || objects.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    objects.forEach(o => { minX = Math.min(minX, o.x); minY = Math.min(minY, o.y); maxX = Math.max(maxX, o.x + o.w); maxY = Math.max(maxY, o.y + o.h); });
    if (minX > maxX) return;
    const pad = 60;
    const s = Math.min(2, Math.max(0.1, Math.min((vp.clientWidth - pad * 2) / Math.max(50, maxX - minX), (vp.clientHeight - pad * 2) / Math.max(50, maxY - minY))));
    setCam({ s, tx: (vp.clientWidth - (maxX + minX) * s) / 2, ty: (vp.clientHeight - (maxY + minY) * s) / 2 });
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const r = vpRef.current!.getBoundingClientRect();
    setCam(c => {
      const s = Math.min(4, Math.max(0.08, c.s * factor));
      const k = s / c.s;
      return { s, tx: (c.tx - (clientX - r.left)) * k + (clientX - r.left), ty: (c.ty - (clientY - r.top)) * k + (clientY - r.top) };
    });
  };

  /* ------------------------------------------------------------- input */

  interface Drag {
    kind: 'pan' | 'move' | 'resize' | 'draw' | 'erase';
    id?: string; start: [number, number]; orig?: BoardObj; corner?: string;
  }
  const dragRef = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, [number, number]>());
  const pinch = useRef<{ dist: number; s: number } | null>(null);
  const awarenessSend = useRef(0);

  const eraseAt = (bx: number, by: number) => {
    const r = 8 / camRef.current.s;
    const hit: string[] = [];
    objects.forEach((o, key) => {
      if (o.t === 'stroke') {
        if (bx < o.x - r || bx > o.x + o.w + r || by < o.y - r || by > o.y + o.h + r) return;
        const px = bx - o.x, py = by - o.y, rr = (r + (o.sw ?? 2)) ** 2;
        for (let i = 1; i < (o.pts?.length ?? 0); i++) {
          const [x1, y1] = o.pts![i - 1], [x2, y2] = o.pts![i];
          const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
          const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
          if ((x1 + t * dx - px) ** 2 + (y1 + t * dy - py) ** 2 <= rr) { hit.push(key); return; }
        }
        if ((o.pts?.length ?? 0) === 1) { const [x1, y1] = o.pts![0]; if ((x1 - px) ** 2 + (y1 - py) ** 2 <= rr) hit.push(key); }
      }
    });
    if (hit.length) mutate(() => { for (const k of hit) objects.delete(k); });
  };

  const onPointerDown = (e: PointerEvent) => {
    const vp = vpRef.current!;
    vp.focus({ preventScroll: true });
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.current.size === 2) {   // pinch zoom takes over
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), s: camRef.current.s };
      dragRef.current = null;
      liveRef.current = null;
      return;
    }
    const [bx, by] = toBoard(e.clientX, e.clientY);
    const target = e.target as HTMLElement;
    const objId = target.closest?.('[data-obj]')?.getAttribute('data-obj') ?? null;
    const corner = target.getAttribute?.('data-corner') ?? undefined;
    const t = toolRef.current;
    const drawTool = (t === 'pen' || t === 'highlighter') && e.pointerType !== 'touch' && !readOnlyRef.current;
    vp.setPointerCapture(e.pointerId);
    if (e.button === 1 || (t === 'select' && !objId && !corner) || e.pointerType === 'touch' && !objId && t !== 'select' && !corner) {
      dragRef.current = { kind: 'pan', start: [e.clientX - camRef.current.tx, e.clientY - camRef.current.ty] };
    } else if (corner && selectedRef.current && !readOnlyRef.current) {
      dragRef.current = { kind: 'resize', id: selectedRef.current, corner, start: [bx, by], orig: { ...objects.get(selectedRef.current)! } };
    } else if (t === 'select' && objId) {
      setSelected(objId);
      if (!readOnlyRef.current) dragRef.current = { kind: 'move', id: objId, start: [bx, by], orig: { ...objects.get(objId)! } };
    } else if (t === 'eraser' && !readOnlyRef.current) {
      dragRef.current = { kind: 'erase', start: [bx, by] };
      eraseAt(bx, by);
    } else if (t === 'note' && !readOnlyRef.current) {
      const nid = newId();
      mutate(() => objects.set(nid, { t: 'note', x: round1(bx), y: round1(by), w: 180, h: 100, color: NOTE_COLORS[objects.size % NOTE_COLORS.length], text: '' }));
      setTool('select');
      setSelected(nid);
      setEditing(nid);
    } else if (drawTool) {
      const hl = t === 'highlighter';
      liveRef.current = { color: colorRef.current, w: hl ? widthRef.current * 4 : widthRef.current, ...(hl ? { o: HIGHLIGHT_OPACITY } : {}), pts: [[bx, by, e.pointerType === 'pen' ? e.pressure : 0]] };
      dragRef.current = { kind: 'draw', start: [bx, by] };
    }
    if (dragRef.current || liveRef.current) e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (pinch.current.s * (dist / pinch.current.dist)) / camRef.current.s);
      return;
    }
    // broadcast the cursor (board coordinates) for presence
    const now = performance.now();
    if (now - awarenessSend.current > 50) {
      awarenessSend.current = now;
      const [bx, by] = toBoard(e.clientX, e.clientY);
      try { provider.awareness.setLocalStateField('boardCursor', { x: round1(bx), y: round1(by) }); } catch { /* closing */ }
    }
    const d = dragRef.current;
    if (!d && !liveRef.current) return;
    const [bx, by] = toBoard(e.clientX, e.clientY);
    if (d?.kind === 'pan') {
      setCam(c => ({ ...c, tx: e.clientX - d.start[0], ty: e.clientY - d.start[1] }));
    } else if (d?.kind === 'move' && d.id && d.orig) {
      const o = objects.get(d.id);
      if (o) mutate(() => objects.set(d.id!, { ...o, x: round1(d.orig!.x + bx - d.start[0]), y: round1(d.orig!.y + by - d.start[1]) }));
    } else if (d?.kind === 'resize' && d.id && d.orig) {
      const o0 = d.orig;
      let { x, y, w, h } = o0;
      const dx = bx - d.start[0], dy = by - d.start[1];
      if (d.corner!.includes('e')) w = o0.w + dx;
      if (d.corner!.includes('s')) h = o0.h + dy;
      if (d.corner!.includes('w')) { x = o0.x + dx; w = o0.w - dx; }
      if (d.corner!.includes('n')) { y = o0.y + dy; h = o0.h - dy; }
      if (o0.t === 'img' && !e.shiftKey) {   // images keep their aspect unless Shift is held
        const f = Math.max(w / o0.w, h / o0.h);
        w = o0.w * f; h = o0.h * f;
        if (d.corner!.includes('w')) x = o0.x + o0.w - w;
        if (d.corner!.includes('n')) y = o0.y + o0.h - h;
      }
      if (w < 8 || h < 8) return;
      const next: BoardObj = { ...o0, x: round1(x), y: round1(y), w: round1(w), h: round1(h) };
      if (o0.t === 'stroke' && o0.pts) {
        const fx = w / o0.w, fy = h / o0.h;
        next.pts = o0.pts.map(([px, py, p]) => [round1(px * fx), round1(py * fy), p] as [number, number, number]);
      }
      mutate(() => objects.set(d.id!, next));
    } else if (d?.kind === 'erase') {
      eraseAt(bx, by);
    } else if (liveRef.current) {
      const events = (e.getCoalescedEvents?.() ?? [e]);
      for (const ev of events) {
        const [x, y] = toBoard(ev.clientX, ev.clientY);
        if (liveRef.current.pts.length < 4000) liveRef.current.pts.push([x, y, ev.pointerType === 'pen' ? ev.pressure : 0]);
      }
      try { provider.awareness.setLocalStateField('boardInk', { ...liveRef.current, pts: liveRef.current.pts.map(([x, y, p]) => [round1(x), round1(y), Math.round(p * 100) / 100]) }); } catch { /* closing */ }
      rerender();
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const live = liveRef.current;
    if (live && dragRef.current?.kind === 'draw') {
      liveRef.current = null;
      try { provider.awareness.setLocalStateField('boardInk', null); } catch { /* closing */ }
      if (live.pts.length) mutate(() => objects.set(newId(), strokeToObj(live.pts, live.color, live.w, live.o)));
    }
    dragRef.current = null;
    rerender();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    else setCam(c => ({ ...c, tx: c.tx - e.deltaX, ty: c.ty - e.deltaY }));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (editing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current && !readOnlyRef.current) {
      mutate(() => objects.delete(selectedRef.current!));
      setSelected(null);
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.shiftKey ? undo.redo() : undo.undo(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { undo.redo(); e.preventDefault(); }
    else if (e.key === 'Escape') { setSelected(null); setTool('select'); }
  };

  /* ------------------------------------------------------------- images */

  const addImageFiles = async (files: File[], at?: [number, number]) => {
    if (readOnlyRef.current || !files.length) return;
    const vp = vpRef.current!;
    let [bx, by] = at ?? toBoard(vp.getBoundingClientRect().left + vp.clientWidth / 2, vp.getBoundingClientRect().top + vp.clientHeight / 2);
    for (const file of files) {
      const ext = imageExt(file);
      if (!ext) continue;
      try {
        const rel = await uploadUnique(project, uploadBaseName(file), ext, file);
        const dims = await new Promise<[number, number]>((resolve) => {
          const img = new Image();
          img.onload = () => resolve([img.naturalWidth || 300, img.naturalHeight || 200]);
          img.onerror = () => resolve([300, 200]);
          img.src = fileUrl(project, rel);
        });
        const f = Math.min(1, 480 / dims[0], 480 / dims[1]);
        mutate(() => objects.set(newId(), { t: 'img', x: round1(bx), y: round1(by), w: round1(dims[0] * f), h: round1(dims[1] * f), src: rel }));
        bx += 24; by += 24;
      } catch (err) { notify('Could not upload ' + file.name + ': ' + (err as Error).message, 'error'); }
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = imageFiles(e.clipboardData);
    const text = e.clipboardData?.getData('text/plain');
    if (!files.length && text && isSvgMarkup(text)) files.push(svgFile(text));
    if (files.length) { void addImageFiles(files); e.preventDefault(); }
    else if (text && !editing && !readOnlyRef.current) {
      // pasted text becomes a sticky note in the middle of the view
      const vp = vpRef.current!.getBoundingClientRect();
      const [bx, by] = toBoard(vp.left + vp.width / 2, vp.top + vp.height / 2);
      mutate(() => objects.set(newId(), { t: 'note', x: round1(bx), y: round1(by), w: 220, h: 120, color: NOTE_COLORS[0], text: text.slice(0, 4000) }));
      e.preventDefault();
    }
  };
  const onDrop = (e: DragEvent) => {
    const files = imageFiles(e.dataTransfer);
    if (files.length) { void addImageFiles(files, toBoard(e.clientX, e.clientY)); e.preventDefault(); }
  };

  const pickImages = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*,.pdf'; input.multiple = true;
    input.onchange = () => void addImageFiles(Array.from(input.files ?? []));
    input.click();
  };

  /* ------------------------------------------------------------- render */

  const entries = [...objects.entries()].sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0) || (a[0] < b[0] ? -1 : 1));
  const sel = selected ? objects.get(selected) : null;
  const peers: { clientId: number; name: string; color: string; x: number; y: number }[] = [];
  const remoteInks: LiveStroke[] = [];
  provider.awareness.getStates().forEach((state, clientId) => {
    if (clientId === ydoc.clientID) return;
    const s = state as { user?: { name: string; color: string }; boardCursor?: { x: number; y: number }; boardInk?: LiveStroke };
    if (s.user && s.boardCursor) peers.push({ clientId, name: s.user.name, color: s.user.color, x: s.boardCursor.x, y: s.boardCursor.y });
    if (s.boardInk?.pts?.length) remoteInks.push(s.boardInk);
  });
  void peerTick;

  const noteEdit = (key: string, o: BoardObj) => (
    <textarea
      class="board-note-edit"
      autofocus
      value={o.text ?? ''}
      onBlur={e => { const v = (e.target as HTMLTextAreaElement).value; mutate(() => { const cur = objects.get(key); if (cur) objects.set(key, { ...cur, text: v }); }); setEditing(null); }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur(); }}
      onPointerDown={e => e.stopPropagation()}
    />
  );

  const toolBtn = (t: Tool, label: string, title: string) => (
    <button class={'small-btn' + (tool === t ? ' active' : '')} data-tool={t} title={title} onClick={() => setTool(t)}>{label}</button>
  );

  return (
    <div class="board" ref={vpRef} tabIndex={0}
      onPointerDown={onPointerDown as never} onPointerMove={onPointerMove as never} onPointerUp={onPointerUp as never} onPointerCancel={onPointerUp as never}
      onWheel={onWheel as never} onKeyDown={onKeyDown as never} onPaste={onPaste as never}
      onDragOver={e => e.preventDefault()} onDrop={onDrop as never}
      data-tool={tool}>
      <div class="board-content" style={{ transform: `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.s})` }}>
        {entries.map(([key, o]) => {
          if (o.t === 'img') {
            return <img key={key} data-obj={key} class={'board-img' + (selected === key ? ' selected' : '')} src={fileUrl(project, o.src ?? '')} draggable={false}
              style={{ left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px' }} />;
          }
          if (o.t === 'note') {
            return (
              <div key={key} data-obj={key} class={'board-note' + (selected === key ? ' selected' : '')}
                style={{ left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', minHeight: o.h + 'px', background: o.color ?? NOTE_COLORS[0] }}
                onDblClick={() => { if (!readOnly) { setSelected(key); setEditing(key); } }}>
                {editing === key ? noteEdit(key, o) : (o.text || <span class="board-note-hint">double-click to write</span>)}
              </div>
            );
          }
          return (
            <svg key={key} data-obj={key} class={'board-stroke' + (selected === key ? ' selected' : '')}
              style={{ left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px', overflow: 'visible' }}
              viewBox={`0 0 ${o.w} ${o.h}`} width={o.w} height={o.h}>
              <path d={strokeD(o)} fill={o.color ?? '#000'} fill-opacity={o.o ?? 1} />
            </svg>
          );
        })}
        {/* in-progress strokes: mine and the other clients' (awareness) */}
        {[...remoteInks, ...(liveRef.current ? [liveRef.current] : [])].map((s, i) => (
          <svg key={'live' + i} class="board-stroke live" style={{ left: 0, top: 0, overflow: 'visible' }} width={1} height={1}>
            <path d={strokePathD({ color: s.color, w: s.w, pts: s.pts } as InkStroke)} fill={s.color} fill-opacity={s.o ?? 1} />
          </svg>
        ))}
        {sel && selected && (
          <div class="board-selbox" style={{ left: sel.x + 'px', top: sel.y + 'px', width: sel.w + 'px', height: sel.h + 'px' }}>
            {['nw', 'ne', 'sw', 'se'].map(c => <span key={c} class={'board-handle ' + c} data-corner={c} style={{ transform: `scale(${1 / cam.s})` }} />)}
          </div>
        )}
        {peers.map(p => (
          <div key={p.clientId} class="board-peer" style={{ left: p.x + 'px', top: p.y + 'px' }}>
            <span class="dot" style={{ background: p.color, transform: `scale(${1 / cam.s})` }} />
            <span class="name" style={{ background: p.color, transform: `scale(${1 / cam.s})` }}>{p.name}</span>
          </div>
        ))}
      </div>
      <div class="board-tools" onPointerDown={e => e.stopPropagation()}>
        {toolBtn('select', '⤢', 'Select / move (drag empty space to pan)')}
        {!readOnly && toolBtn('pen', '✏️', 'Pen')}
        {!readOnly && toolBtn('highlighter', '🖍', 'Highlighter')}
        {!readOnly && toolBtn('eraser', '⌫', 'Eraser (removes strokes)')}
        {!readOnly && toolBtn('note', '🗒', 'Sticky note')}
        {!readOnly && <button class="small-btn" title="Add images (or paste / drag them in)" onClick={pickImages}>🖼</button>}
        {!readOnly && <span class="board-sep" />}
        {!readOnly && COLORS.map(([c, name]) => (
          <button key={c} class={'board-color' + (color === c && tool !== 'eraser' ? ' active' : '')} title={name} style={{ background: c }}
            onClick={() => { setColor(c); if (tool === 'eraser' || tool === 'select' || tool === 'note') setTool('pen'); }} />
        ))}
        {!readOnly && [1.5, 2.5, 4].map((w, i) => (
          <button key={w} class={'small-btn board-width' + (width === w ? ' active' : '')} title={`Stroke width ${w} px`} onClick={() => setWidth(w)}>
            <span style={{ width: 4 + i * 3 + 'px', height: 4 + i * 3 + 'px' }} />
          </button>
        ))}
      </div>
      <div class="board-zoom" onPointerDown={e => e.stopPropagation()}>
        <button class="small-btn" title="Zoom out" onClick={() => zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.25)}>−</button>
        <button class="small-btn" title="Reset zoom" onClick={() => setCam(c => ({ ...c, s: 1 }))}>{Math.round(cam.s * 100)}%</button>
        <button class="small-btn" title="Zoom in" onClick={() => zoomAt(innerWidth / 2, innerHeight / 2, 1.25)}>+</button>
        <button class="small-btn" title="Zoom to fit everything" onClick={fit}>⤢</button>
        <span class={'board-conn ' + conn} title={conn === 'online' ? 'Connected — changes sync live and save automatically' : conn === 'offline' ? 'No connection — reconnecting' : 'Connecting…'}>
          {conn === 'online' ? (readOnly ? '👁 view only' : '✓ live') : conn === 'offline' ? 'offline' : '…'}
        </span>
      </div>
    </div>
  );
}
