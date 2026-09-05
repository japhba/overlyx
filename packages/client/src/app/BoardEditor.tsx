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
import { strokePathD, laserPathD, polylineHitsPolygon, rectHitsPolygon, type InkStroke } from '@overlyx/core';
import { api, fileUrl, type User } from '../api';
import { imageFiles, imageExt, uploadBaseName, uploadUnique, isSvgMarkup, svgFile } from '../editor/imagepaste';
import { HIGHLIGHT_OPACITY, LASER_COLOR, LASER_FADE_MS, getInk, setInk, subscribeInk, inkColorName, formatMm, mmToPx, type InkPen } from '../editor/plugins/ink';
import { InkColorPicker, InkWidthPicker, widthDotPx } from './InkPickers';

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

type Tool = 'select' | 'lasso' | 'pen' | 'highlighter' | 'eraser' | 'note' | 'laser';
interface Camera { tx: number; ty: number; s: number }
interface LiveStroke { color: string; w: number; o?: number; pts: [number, number, number][] }
/** a laser trace (board coordinates); `fadeAt` set once its owner lifted the pen */
interface LaserTrail { pts: [number, number][]; color: string; name?: string; fadeAt: number | null }

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
  const setTool = (t: Tool) => { setToolState(t); if (t === 'pen' || t === 'highlighter') setLastPen(t); if (t !== 'select' && t !== 'lasso') setSelected(new Set()); setPick(null); };
  // pen and highlighter each keep their own colour, width and presets — the same pens as the
  // margin ink (one Goodnotes pen case per browser); the swatches show the pen in use, or the
  // last one used while another tool is active. A click on the selected preset opens its editor.
  const pens = getInk().pens;
  useEffect(() => subscribeInk(rerender), []);
  const [lastPen, setLastPen] = useState<InkPen>('pen');
  const curPen: InkPen = tool === 'highlighter' ? 'highlighter' : tool === 'pen' ? 'pen' : lastPen;
  const [pick, setPick] = useState<{ kind: 'color' | 'width'; idx: number } | null>(null);
  const setPenSetting = (patch: { color?: string; width?: number }) => {
    setInk({ pen: curPen, ...patch });
    setPick(null);
    if (tool !== 'pen' && tool !== 'highlighter') setTool(curPen);   // picking a colour takes the pen up again
  };
  // the laser: my trace while held, then fading; the others' from awareness, kept to fade too
  const laserRef = useRef<[number, number][] | null>(null);
  const [laserFade, setLaserFade] = useState<{ pts: [number, number][]; key: number } | null>(null);
  const remoteLasers = useRef(new Map<number, LaserTrail>());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [lassoPts, setLassoPts] = useState<[number, number][] | null>(null);
  const lassoRef = useRef(lassoPts); lassoRef.current = lassoPts;
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
    const onAwareness = () => {
      // laser trails: take the live ones, start fading the ones whose field vanished
      const seen = new Set<number>();
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === ydoc.clientID) return;
        const s = state as { user?: { name?: string; color?: string }; boardLaser?: { pts: [number, number][] } | null };
        if (!s.boardLaser?.pts?.length) return;
        seen.add(clientId);
        remoteLasers.current.set(clientId, { pts: s.boardLaser.pts, color: s.user?.color ?? LASER_COLOR, name: s.user?.name, fadeAt: null });
      });
      const now = performance.now();
      for (const [clientId, t] of remoteLasers.current) {
        if (!seen.has(clientId) && t.fadeAt === null) { t.fadeAt = now; setTimeout(() => { remoteLasers.current.delete(clientId); setPeerTick(k => k + 1); }, LASER_FADE_MS + 50); }
      }
      setPeerTick(t => t + 1);
    };
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
    kind: 'pan' | 'move' | 'resize' | 'draw' | 'erase' | 'lasso' | 'laser';
    start: [number, number]; origs?: Map<string, BoardObj>; corner?: string; base?: { x: number; y: number; w: number; h: number };
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

  const groupBBox = (ids: ReadonlySet<string>): { x: number; y: number; w: number; h: number } | null => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const o = objects.get(id);
      if (!o) continue;
      minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x + o.w); maxY = Math.max(maxY, o.y + o.h);
    }
    return minX > maxX ? null : { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
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
      laserRef.current = null;
      return;
    }
    const [bx, by] = toBoard(e.clientX, e.clientY);
    const target = e.target as HTMLElement;
    const objId = target.closest?.('[data-obj]')?.getAttribute('data-obj') ?? null;
    const corner = target.getAttribute?.('data-corner') ?? undefined;
    const t = toolRef.current;
    const drawTool = (t === 'pen' || t === 'highlighter') && e.pointerType !== 'touch' && !readOnlyRef.current;
    const origsOf = (ids: ReadonlySet<string>) => { const m = new Map<string, BoardObj>(); for (const id of ids) { const o = objects.get(id); if (o) m.set(id, { ...o, pts: o.pts?.map(p => [...p] as [number, number, number]) }); } return m; };
    const onSelBox = !!target.closest?.('.board-selbox');
    vp.setPointerCapture(e.pointerId);
    setPick(null);
    if (t === 'laser' && e.pointerType !== 'touch') {
      // the laser pointer: a viewer may use it too — nothing is written
      laserRef.current = [[bx, by]];
      setLaserFade(null);
      dragRef.current = { kind: 'laser', start: [bx, by] };
      try { provider.awareness.setLocalStateField('boardLaser', { pts: [[round1(bx), round1(by)]] }); } catch { /* closing */ }
    } else if (onSelBox && !corner && selectedRef.current.size && !readOnlyRef.current) {
      // dragging inside the selection box moves the whole selection
      dragRef.current = { kind: 'move', start: [bx, by], origs: origsOf(selectedRef.current) };
    } else if (e.button === 1 || ((t === 'select' || t === 'lasso') && !objId && !corner && (t === 'select' || e.pointerType === 'touch'))) {
      if (selectedRef.current.size) setSelected(new Set());
      dragRef.current = { kind: 'pan', start: [e.clientX - camRef.current.tx, e.clientY - camRef.current.ty] };
    } else if (e.pointerType === 'touch' && !objId && t !== 'select' && !corner) {
      dragRef.current = { kind: 'pan', start: [e.clientX - camRef.current.tx, e.clientY - camRef.current.ty] };
    } else if (corner && selectedRef.current.size && !readOnlyRef.current) {
      const base = groupBBox(selectedRef.current);
      if (base) dragRef.current = { kind: 'resize', corner, start: [bx, by], origs: origsOf(selectedRef.current), base };
    } else if (t === 'lasso' && !readOnlyRef.current) {
      dragRef.current = { kind: 'lasso', start: [bx, by] };
      setLassoPts([[bx, by]]);
    } else if ((t === 'select' || t === 'lasso') && objId) {
      const cur = selectedRef.current;
      const next = e.shiftKey
        ? new Set(cur.has(objId) ? [...cur].filter(id => id !== objId) : [...cur, objId])
        : cur.has(objId) ? cur : new Set([objId]);
      setSelected(next);
      if (!readOnlyRef.current && next.has(objId)) dragRef.current = { kind: 'move', start: [bx, by], origs: origsOf(next) };
    } else if (t === 'eraser' && !readOnlyRef.current) {
      dragRef.current = { kind: 'erase', start: [bx, by] };
      eraseAt(bx, by);
    } else if (t === 'note' && !readOnlyRef.current) {
      const nid = newId();
      mutate(() => objects.set(nid, { t: 'note', x: round1(bx), y: round1(by), w: 180, h: 100, color: NOTE_COLORS[objects.size % NOTE_COLORS.length], text: '' }));
      setTool('select');
      setSelected(new Set([nid]));
      setEditing(nid);
    } else if (drawTool) {
      const hl = t === 'highlighter';
      const pen = getInk().pens[hl ? 'highlighter' : 'pen'];
      liveRef.current = { color: pen.color, w: mmToPx(pen.width), ...(hl ? { o: HIGHLIGHT_OPACITY } : {}), pts: [[bx, by, e.pointerType === 'pen' ? e.pressure : 0]] };
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
    if (d?.kind === 'laser' && laserRef.current) {
      const pts = laserRef.current;
      for (const ev of e.getCoalescedEvents?.() ?? [e]) {
        const [x, y] = toBoard(ev.clientX, ev.clientY);
        const last = pts[pts.length - 1];
        if ((last[0] - x) ** 2 + (last[1] - y) ** 2 < 1 / (camRef.current.s * camRef.current.s)) continue;
        pts.push([x, y]);
        if (pts.length > 1500) pts.shift();
      }
      if (now - awarenessSend.current > 40 || pts.length < 4) {
        awarenessSend.current = now;
        try { provider.awareness.setLocalStateField('boardLaser', { pts: pts.map(([x, y]) => [round1(x), round1(y)]) }); } catch { /* closing */ }
      }
      rerender();
    } else if (d?.kind === 'pan') {
      setCam(c => ({ ...c, tx: e.clientX - d.start[0], ty: e.clientY - d.start[1] }));
    } else if (d?.kind === 'lasso') {
      setLassoPts(pts => {
        if (!pts) return pts;
        const last = pts[pts.length - 1];
        return (last[0] - bx) ** 2 + (last[1] - by) ** 2 > 4 / camRef.current.s ? [...pts, [bx, by]] : pts;
      });
    } else if (d?.kind === 'move' && d.origs) {
      const dx = bx - d.start[0], dy = by - d.start[1];
      mutate(() => {
        for (const [id, o0] of d.origs!) {
          const cur = objects.get(id);
          if (cur) objects.set(id, { ...cur, x: round1(o0.x + dx), y: round1(o0.y + dy) });
        }
      });
    } else if (d?.kind === 'resize' && d.origs && d.base) {
      // scale the whole selection about the corner opposite the dragged one
      const b = d.base;
      const ox = d.corner!.includes('w') ? b.x + b.w : b.x;
      const oy = d.corner!.includes('n') ? b.y + b.h : b.y;
      const clamp = (v: number) => Math.max(0.05, Math.min(20, v));
      let sx = clamp((bx - ox) / ((d.start[0] - ox) || 1));
      let sy = clamp((by - oy) / ((d.start[1] - oy) || 1));
      const onlyImgs = [...d.origs.values()].every(o => o.t === 'img');
      if (e.shiftKey || onlyImgs) sx = sy = Math.max(sx, sy);   // images keep their aspect unless mixed with ink
      mutate(() => {
        for (const [id, o0] of d.origs!) {
          const w = o0.w * sx, h = o0.h * sy;
          if (w < 4 || h < 4) continue;
          const next: BoardObj = { ...o0, x: round1(ox + (o0.x - ox) * sx), y: round1(oy + (o0.y - oy) * sy), w: round1(w), h: round1(h) };
          if (o0.t === 'stroke' && o0.pts) {
            next.pts = o0.pts.map(([px, py, p]) => [round1(px * sx), round1(py * sy), p] as [number, number, number]);
            next.sw = round1(Math.max(0.5, (o0.sw ?? 2) * Math.sqrt(sx * sy)));
          }
          objects.set(id, next);
        }
      });
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
    if (dragRef.current?.kind === 'laser' && laserRef.current) {
      // lifted: the trace lingers and fades (CSS); the others fade theirs when the field vanishes
      const pts = laserRef.current;
      laserRef.current = null;
      const key = Date.now();
      setLaserFade({ pts, key });
      setTimeout(() => setLaserFade(f => (f && f.key === key ? null : f)), LASER_FADE_MS + 50);
      try { provider.awareness.setLocalStateField('boardLaser', null); } catch { /* closing */ }
    }
    const live = liveRef.current;
    if (live && dragRef.current?.kind === 'draw') {
      liveRef.current = null;
      try { provider.awareness.setLocalStateField('boardInk', null); } catch { /* closing */ }
      if (live.pts.length) mutate(() => objects.set(newId(), strokeToObj(live.pts, live.color, live.w, live.o)));
    }
    if (dragRef.current?.kind === 'lasso') {
      const poly = lassoRef.current;
      setLassoPts(null);
      if (poly && poly.length > 4) {
        // Goodnotes semantics: the (auto-closed) lasso selects whatever it touches — a stroke with
        // any part inside or crossing the line, an image or note it overlaps
        const hit = new Set<string>();
        objects.forEach((o, key) => {
          if (o.t === 'stroke' && o.pts?.length) {
            if (polylineHitsPolygon(o.pts.map(([px, py]) => [o.x + px, o.y + py] as [number, number]), poly)) hit.add(key);
          } else if (rectHitsPolygon(o.x, o.y, o.w, o.h, poly)) hit.add(key);
        });
        setSelected(e.shiftKey ? new Set([...selectedRef.current, ...hit]) : hit);
      } else if (!e.shiftKey) setSelected(new Set());
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current.size && !readOnlyRef.current) {
      mutate(() => { for (const id of selectedRef.current) objects.delete(id); });
      setSelected(new Set());
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.shiftKey ? undo.redo() : undo.undo(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { undo.redo(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { setSelected(new Set([...objects.keys()])); setTool('select'); e.preventDefault(); }
    else if (e.key === 'Escape') { setSelected(new Set()); setTool('select'); }
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
  const selBB = selected.size ? groupBBox(selected) : null;
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
  const drawingTool = tool === 'pen' || tool === 'highlighter';
  const penSet = pens[curPen];
  /** a laser trace as SVG: a wide soft glow under a bright core, a dot at the head — all sized for the screen, not the board */
  const laserSvg = (t: LaserTrail, key: string | number, mine: boolean) => {
    const d = laserPathD(t.pts);
    const [hx, hy] = t.pts[t.pts.length - 1];
    const k = 1 / cam.s;
    return (
      <svg key={key} class={'board-laser' + (t.fadeAt !== null ? ' fade' : '')} style={{ left: 0, top: 0, overflow: 'visible' }} width={1} height={1} data-laser={mine ? 'mine' : 'peer'}>
        <path d={d} fill="none" stroke={t.color} stroke-opacity={0.3} stroke-width={11 * k} stroke-linecap="round" stroke-linejoin="round" />
        <path d={d} fill="none" stroke={t.color} stroke-opacity={0.95} stroke-width={3.2 * k} stroke-linecap="round" stroke-linejoin="round" />
        <circle cx={hx} cy={hy} r={8 * k} fill={t.color} fill-opacity={0.5} />
        <circle cx={hx} cy={hy} r={2.2 * k} fill="#fff" fill-opacity={0.9} />
        {t.name && t.fadeAt === null && <text x={hx + 12 * k} y={hy - 8 * k} font-size={11 * k} fill={t.color} font-family="system-ui, sans-serif">{t.name}</text>}
      </svg>
    );
  };

  return (
    <div class="board" ref={vpRef} tabIndex={0}
      onPointerDown={onPointerDown as never} onPointerMove={onPointerMove as never} onPointerUp={onPointerUp as never} onPointerCancel={onPointerUp as never}
      onWheel={onWheel as never} onKeyDown={onKeyDown as never} onPaste={onPaste as never}
      onDragOver={e => e.preventDefault()} onDrop={onDrop as never}
      data-tool={tool}>
      <div class="board-content" style={{ transform: `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.s})` }}>
        {entries.map(([key, o]) => {
          if (o.t === 'img') {
            return <img key={key} data-obj={key} class={'board-img' + (selected.has(key) ? ' selected' : '')} src={fileUrl(project, o.src ?? '')} draggable={false}
              style={{ left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px' }} />;
          }
          if (o.t === 'note') {
            return (
              <div key={key} data-obj={key} class={'board-note' + (selected.has(key) ? ' selected' : '')}
                style={{ left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', minHeight: o.h + 'px', background: o.color ?? NOTE_COLORS[0] }}
                onDblClick={() => { if (!readOnly) { setSelected(new Set([key])); setEditing(key); } }}>
                {editing === key ? noteEdit(key, o) : (o.text || <span class="board-note-hint">double-click to write</span>)}
              </div>
            );
          }
          return (
            <svg key={key} data-obj={key} class={'board-stroke' + (selected.has(key) ? ' selected' : '')}
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
        {selBB && (
          <div class="board-selbox" style={{ left: selBB.x + 'px', top: selBB.y + 'px', width: selBB.w + 'px', height: selBB.h + 'px' }}>
            {['nw', 'ne', 'sw', 'se'].map(c => <span key={c} class={'board-handle ' + c} data-corner={c} style={{ transform: `scale(${1 / cam.s})` }} />)}
          </div>
        )}
        {lassoPts && lassoPts.length > 1 && (
          <svg class="board-lasso" style={{ left: 0, top: 0, overflow: 'visible' }} width={1} height={1}>
            <polygon points={lassoPts.map(([x, y]) => `${x},${y}`).join(' ')} fill="rgba(59,110,165,0.08)" stroke="rgba(59,110,165,0.9)" stroke-width={1.5 / cam.s} stroke-dasharray={`${5 / cam.s} ${4 / cam.s}`} />
          </svg>
        )}
        {/* laser traces: the others' (fading once lifted), then mine */}
        {[...remoteLasers.current.entries()].map(([clientId, t]) => laserSvg(t, 'laser' + clientId, false))}
        {laserRef.current && laserSvg({ pts: laserRef.current, color: LASER_COLOR, fadeAt: null }, 'mylaser', true)}
        {laserFade && laserSvg({ pts: laserFade.pts, color: LASER_COLOR, fadeAt: laserFade.key }, 'myfade' + laserFade.key, true)}
        {peers.map(p => (
          <div key={p.clientId} class="board-peer" style={{ left: p.x + 'px', top: p.y + 'px' }}>
            <span class="dot" style={{ background: p.color, transform: `scale(${1 / cam.s})` }} />
            <span class="name" style={{ background: p.color, transform: `scale(${1 / cam.s})` }}>{p.name}</span>
          </div>
        ))}
      </div>
      <div class="board-tools" onPointerDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape' && pick) { setPick(null); e.stopPropagation(); } }}>
        {toolBtn('select', '⤢', 'Select / move (drag empty space to pan)')}
        {toolBtn('lasso', '◌', 'Lasso — encircle things to select them together (Shift adds); drag to move, corner handles resize, Delete removes')}
        {!readOnly && toolBtn('pen', '✏️', 'Pen')}
        {!readOnly && toolBtn('highlighter', '🖍', 'Highlighter')}
        {!readOnly && toolBtn('eraser', '⌫', 'Eraser (removes strokes)')}
        {toolBtn('laser', '🔴', 'Laser pointer — a glowing trace that stays while you hold the pen down and fades when you lift it; not saved, seen live by everyone on the board')}
        {!readOnly && toolBtn('note', '🗒', 'Sticky note')}
        {!readOnly && <button class="small-btn" title="Add images (or paste / drag them in)" onClick={pickImages}>🖼</button>}
        {!readOnly && <span class="board-sep" />}
        {/* presets (shared with the margin ink): one click selects, a click on the selected one edits it */}
        {!readOnly && penSet.colors.map((c, i) => {
          const active = penSet.color === c && drawingTool;
          return (
            <button key={curPen + i} class={'board-color' + (active ? ' active' : '') + (curPen === 'highlighter' ? ' hl' : '')} data-color={c} data-slot={'c' + i}
              title={`${inkColorName(c)} (${curPen}) — click the selected colour again to change it`} style={{ background: c }}
              onClick={() => { if (active) setPick(p => (p?.kind === 'color' && p.idx === i ? null : { kind: 'color', idx: i })); else setPenSetting({ color: c }); }} />
          );
        })}
        {!readOnly && penSet.widths.map((w, i) => {
          const active = penSet.width === w && drawingTool;
          const px = widthDotPx(curPen, w);
          return (
            <button key={curPen + 'w' + i} class={'small-btn board-width' + (active ? ' active' : '')} data-width={w} data-slot={'w' + i}
              title={`${curPen === 'pen' ? 'Pen' : 'Highlighter'} ${formatMm(w)} — click the selected width again to change it`}
              onClick={() => { if (active) setPick(p => (p?.kind === 'width' && p.idx === i ? null : { kind: 'width', idx: i })); else setPenSetting({ width: w }); }}>
              <span style={{ width: px + 'px', height: px + 'px' }} />
            </button>
          );
        })}
        {pick && (
          <div class="board-pop">
            {pick.kind === 'color'
              ? <InkColorPicker value={penSet.colors[pick.idx]} pen={curPen} onChange={v => setInk({ pen: curPen, slotColor: { idx: pick.idx, color: v } })} />
              : <InkWidthPicker value={penSet.widths[pick.idx]} color={penSet.color} pen={curPen} onChange={v => setInk({ pen: curPen, slotWidth: { idx: pick.idx, width: v } })} />}
          </div>
        )}
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
