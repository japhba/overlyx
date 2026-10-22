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
import { inkOn } from './contrast';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { connectParams } from '@overlyx/core/collab/connect.ts';
import * as decoding from 'lib0/decoding';
import { strokePathD, strokeRuns, laserPathD, polylineHitsPolygon, rectMostlyInPolygon, splitDocId, type InkStroke } from '@overlyx/core';
import { api, fileUrl, type User } from '../api';
import { imageFiles, imageExt, uploadBaseName, uploadUnique, isSvgMarkup, svgFile } from '../editor/imagepaste';
import { HIGHLIGHT_OPACITY, LASER_COLOR, LASER_FADE_MS, subscribeInk } from '../editor/plugins/ink';
import { useUiMode } from './uimode';
import { MODERN_ICONS, iconSvg } from './modernicons';
import { hostedZoomPill } from './zoomhud';
import { Toolbar } from './Toolbar';
import { drawingToolbar } from '../deliverable/drawingToolbar';
import { loadDeckInk, saveDeckInk, patchDeckInk, ERASER_PX } from '../deliverable/deckink';
import { lassoGroups, readHandwriting, chooseReading, readingError, type LassoActions } from '../deliverable/lassobar';
import { LassoBar, pasteGroups } from '../deliverable/InkSelectionBar';
import { lassoTakes, usedColors, makeInkClip, holdInk, heldInk, pastedInk, rotatePts, rotationAngle, thickened, type InkClip } from '../deliverable/inkselect';
import { snapShape, SNAP_HOLD_MS, SNAP_LEAVE_PX } from '@overlyx/core/shapesnap.ts';
import { eraseAlong } from '@overlyx/core/inkerase.ts';
import { freshPoint, type NibOpts } from '@overlyx/core/freehand.ts';
import { pointPressure, pressed, watchForce } from '../deliverable/runtime/pressure';
import { scratchOut, SCRATCH_HOLD_MS, SCRATCH_HOLD_PX } from '@overlyx/core/scratchout.ts';
import type { StrokeWatch } from '@overlyx/core/glitch.ts';
import { strokeWatch, strokeEnded } from '../glitches';
import { shapePoints, INK_SHAPES, type InkShape } from '@overlyx/core';
const isShapeTool = (t: string): t is InkShape => (INK_SHAPES as readonly string[]).includes(t);

export interface BoardObj {
  t: 'stroke' | 'img' | 'note';
  x: number; y: number; w: number; h: number; z?: number;
  /** stroke */
  color?: string; sw?: number; o?: number; nib?: NibOpts; pressure?: boolean; pts?: [number, number, number][];
  /** a line or shape of the Draw row's Lines / Shapes: `pts` is its exact outline (core InkStroke.poly) */
  poly?: true;
  /** image (project-relative path) */
  src?: string;
  /** note */
  text?: string;
}

type Tool = 'select' | 'lasso' | 'pen' | 'highlighter' | 'eraser' | 'note' | 'laser' | InkShape;
interface Camera { tx: number; ty: number; s: number }
/** `raw`: the stroke as drawn, once draw and hold snapped it to a shape (`pts` is the shape then), and where the pen rested (client px) */
interface LiveStroke { color: string; w: number; o?: number; nib?: NibOpts; pressure?: boolean; poly?: true; pts: [number, number, number][]; raw?: [number, number, number][]; restAt?: [number, number] }
/** a laser trace (board coordinates); `fadeAt` set once its owner lifted the pen */
interface LaserTrail { pts: [number, number][]; color: string; name?: string; fadeAt: number | null }

const NOTE_COLORS = ['#fff3bf', '#d3f9d8', '#d0ebff', '#ffe3e3', '#f3f0ff'];
const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Normalise absolute stroke points into an object: bbox at (x, y), points relative. */
function strokeToObj(pts: [number, number, number][], color: string, sw: number, o?: number, nib?: NibOpts, pressure?: boolean, poly?: true): BoardObj {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  return {
    t: 'stroke', ...(poly ? { poly } : { nib, pressure }), x: round1(minX), y: round1(minY), w: round1(w), h: round1(h), color, sw, ...(o !== undefined ? { o } : {}),
    pts: pts.map(([x, y, p]) => [round1(x - minX), round1(y - minY), Math.round(p * 100) / 100] as [number, number, number]),
  };
}

/** a stroke object with new absolute points, its look and its place in the stacking kept */
function restroke(o: BoardObj, pts: [number, number, number][]): BoardObj {
  return { ...strokeToObj(pts, o.color ?? '#000', o.sw ?? 2, o.o, o.nib, o.pressure, o.poly), ...(o.z !== undefined ? { z: o.z } : {}) };
}
/** a stroke object's points on the board */
const absPts = (o: BoardObj): [number, number, number][] => (o.pts ?? []).map(([x, y, p]) => [o.x + x, o.y + y, p] as [number, number, number]);

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
  const { project, path } = splitDocId(id);
  const vpRef = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const rerender = () => bump(t => t + 1);
  const [cam, setCam] = useState<Camera>({ tx: 0, ty: 0, s: 1 });
  // the zoom said over the board while it changes (zoomhud.ts); "Fit" right after Zoom to fit everything
  const pill = useMemo(() => hostedZoomPill(() => vpRef.current, 'data-board-zoomhud'), []);
  const shownS = useRef<number | null>(null);
  const fitS = useRef<number | null>(null);
  useEffect(() => {
    if (shownS.current !== null && shownS.current !== cam.s) pill.show(cam.s, fitS.current === cam.s ? 'Fit' : null);
    shownS.current = cam.s;
  }, [cam.s]);
  useEffect(() => () => pill.dispose(), []);
  const camRef = useRef(cam); camRef.current = cam;
  const [tool, setToolState] = useState<Tool>('select');
  const toolRef = useRef(tool); toolRef.current = tool;
  const setTool = (t: Tool) => {
    setToolState(t);
    if ((t === 'pen' || t === 'highlighter') && loadDeckInk().pen !== t) saveDeckInk(patchDeckInk(loadDeckInk(), { pen: t }));
    if (t !== 'select' && t !== 'lasso') setSelected(new Set());
  };
  // pen and highlighter each keep their own colour, width and presets — the same pens as the
  // margin ink (one Goodnotes pen case per browser); the swatches show the pen in use, or the
  // last one used while another tool is active. A click on the selected preset opens its editor.
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
  /** when the live stroke's last point was given (freehand.ts freshPoint); its pointer kind and first pressure (a trackpad's counts once it changes, pressure.ts) */
  const liveT = useRef(-Infinity);
  const liveFirst = useRef({ kind: '', p: 0.5 });
  // (a force click while drawing: no Look Up)
  useEffect(() => watchForce(() => liveRef.current !== null), []);
  /** the pointer drawing the stroke (another's moves are not its points), and its points as the screen had them (glitches.ts) */
  const drawingRef = useRef<{ id: number; watch: StrokeWatch | null } | null>(null);
  /** scratch-out while the pen draws (core/scratchout.ts): the strokes it would erase now (faded), where and since when the pen rests */
  const scratchRef = useRef<{ hits: Set<string>; rest: { x: number; y: number; t: number; timer: ReturnType<typeof setTimeout> | null }; judged: number } | null>(null);
  const [peerTick, setPeerTick] = useState(0);
  /** draw and hold (core/shapesnap.ts): where the pen came to rest, and the timer that snaps the stroke when it stays there */
  const holdRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** a tap with the lasso on nothing, something copied: the Paste bar there (board coordinates) */
  const [pasteAt, setPasteAt] = useState<[number, number] | null>(null);
  /** where the pointer last was on the board (a paste with the keys goes there) */
  const lastAt = useRef<[number, number] | null>(null);

  /** Yjs document + provider, once per board. */
  const conn0 = useMemo(() => {
    const ydoc = new Y.Doc();
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const provider = new WebsocketProvider(wsUrl, '', ydoc, { params: connectParams(id), disableBc: true });
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
    // the provider connects as it is created (useMemo above), before this effect runs: a fast
    // connection (WebKit, a warm second page) was connected and synced already, and the board said
    // "Connecting…" for good — take the state it is in
    if (provider.synced) onSync(true); else if (provider.wsconnected) onStatus({ status: 'connected' });
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
    fitS.current = s;
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
    kind: 'pan' | 'move' | 'resize' | 'rotate' | 'draw' | 'erase' | 'lasso' | 'laser';
    start: [number, number]; origs?: Map<string, BoardObj>; corner?: string; base?: { x: number; y: number; w: number; h: number };
    /** the eraser's last place (the precise eraser rubs along the way from there); whether the pen's other end erases */
    last?: [number, number]; end?: boolean;
    /** the rotation's centre and the angle the press began at */
    rot?: { cx: number; cy: number; a0: number };
  }
  const dragRef = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, [number, number]>());
  const pinch = useRef<{ dist: number; s: number } | null>(null);
  const awarenessSend = useRef(0);

  /**
   * The eraser at (bx, by), come from `from`, with Draw's eraser settings: its size, whole strokes or the
   * part under it (precise: what is left either side stays, as strokes of the same look), the
   * highlighter's strokes alone.
   */
  const eraseAt = (bx: number, by: number, from?: [number, number]) => {
    const er = loadDeckInk().eraser;
    const r = ERASER_PX[er.size] / camRef.current.s;
    const a = from ?? [bx, by];
    const hit: string[] = [];
    const cut = new Map<string, [number, number, number][][]>();
    objects.forEach((o, key) => {
      if (o.t !== 'stroke' || !o.pts?.length) return;
      if (er.hlOnly && !(o.o !== undefined && o.o < 1)) return;
      const R = r + (o.sw ?? 2) / 2;
      if (Math.max(a[0], bx) < o.x - R || Math.min(a[0], bx) > o.x + o.w + R || Math.max(a[1], by) < o.y - R || Math.min(a[1], by) > o.y + o.h + R) return;
      if (er.precise) {
        const left = eraseAlong([absPts(o)], a, [bx, by], R).get(0);
        if (left) cut.set(key, left);
        return;
      }
      const px = bx - o.x, py = by - o.y, rr = R ** 2;
      for (let i = 1; i < o.pts.length; i++) {
        const [x1, y1] = o.pts[i - 1], [x2, y2] = o.pts[i];
        const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
        if ((x1 + t * dx - px) ** 2 + (y1 + t * dy - py) ** 2 <= rr) { hit.push(key); return; }
      }
      if (o.pts.length === 1) { const [x1, y1] = o.pts[0]; if ((x1 - px) ** 2 + (y1 - py) ** 2 <= rr) hit.push(key); }
    });
    if (!hit.length && !cut.size) return;
    mutate(() => {
      for (const k of hit) objects.delete(k);
      for (const [k, pieces] of cut) {
        const o = objects.get(k);
        if (!o) continue;
        objects.delete(k);
        for (const piece of pieces) objects.set(newId(), restroke(o, piece));
      }
    });
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

  /** The layout pen case also owns the finger-drawing preference. */
  const fingerDrawRef = useRef(loadDeckInk().fingersDraw);
  const [fingerDraw, setFingerDrawState] = useState(fingerDrawRef.current);
  const setFingerDraw = (v: boolean) => { fingerDrawRef.current = v; setFingerDrawState(v); saveDeckInk(patchDeckInk(loadDeckInk(), { fingersDraw: v })); };
  useEffect(() => subscribeInk(() => { const drawing = loadDeckInk(); fingerDrawRef.current = drawing.fingersDraw; setFingerDrawState(drawing.fingersDraw); rerender(); }), []);

  /** the strokes the scribble drawn so far would erase (`hold`: the pen rests at its end) */
  const scratchTargets = (hold: boolean): string[] => {
    const live = liveRef.current;
    if (!live || live.pts.length < 12) return [];
    const keys: string[] = [], lines: [number, number][][] = [];
    objects.forEach((o, key) => { if (o.t === 'stroke' && o.pts?.length) { keys.push(key); lines.push(o.pts.map(([x, y]) => [o.x + x, o.y + y])); } });
    const hits = lines.length ? scratchOut(live.pts.map(([x, y]) => [x, y]), lines, { zoom: camRef.current.s, width: live.w, hold }) : null;
    return hits ? hits.map(i => keys[i]) : [];
  };
  const judgeScratch = (hold: boolean) => {
    const sc = scratchRef.current;
    if (!sc) return;
    sc.judged = performance.now();
    sc.hits = new Set(scratchTargets(hold));
  };
  const endScratch = () => {
    if (scratchRef.current?.rest.timer) clearTimeout(scratchRef.current.rest.timer);
    scratchRef.current = null;
  };
  const endHold = () => {
    if (holdRef.current) clearTimeout(holdRef.current.timer);
    holdRef.current = null;
  };
  /**
   * The pen rested at the end of the stroke: the shape it was meant to be, at once, while the pen is
   * still down (the stroke as drawn kept for the first undo) — unless the scribble's scratch-and-hold
   * would erase something: that wins.
   */
  const snapLive = () => {
    const at = holdRef.current;
    holdRef.current = null;
    const live = liveRef.current;
    if (!live || live.poly || live.raw) return;
    if (scratchRef.current && scratchTargets(true).length) return;
    const shape = snapShape(live.pts, { zoom: camRef.current.s });
    if (!shape) return;
    liveRef.current = { ...live, raw: live.pts, poly: true, pts: shape.pts.map(([x, y]) => [x, y, 0] as [number, number, number]), restAt: at ? [at.x, at.y] : undefined };
    const { raw: _raw, restAt: _at, ...shown } = liveRef.current;
    try { provider.awareness.setLocalStateField('boardInk', shown); } catch { /* closing */ }
    rerender();
  };

  const onPointerDown = (e: PointerEvent) => {
    const vp = vpRef.current!;
    if (e.pointerType === 'pen' && !loadDeckInk().pencil) saveDeckInk(patchDeckInk(loadDeckInk(), { pencil: true }));
    const finger = e.pointerType === 'touch' && fingerDrawRef.current;
    vp.focus({ preventScroll: true });
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    setPasteAt(null);
    if (pointers.current.size === 2) {   // pinch zoom takes over
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), s: camRef.current.s };
      dragRef.current = null;
      liveRef.current = null;
      laserRef.current = null;
      endHold();
      return;
    }
    const [bx, by] = toBoard(e.clientX, e.clientY);
    const target = e.target as HTMLElement;
    const objId = target.closest?.('[data-obj]')?.getAttribute('data-obj') ?? null;
    const corner = target.getAttribute?.('data-corner') ?? undefined;
    // a pen draws the moment it touches the board, with Select in hand (Apple's HIG; the pen's settings can turn it off) —
    // that stroke alone: Select stays in hand (fingers select between strokes) and the Draw row as it was
    const penTakes = e.pointerType === 'pen' && toolRef.current === 'select' && loadDeckInk().penInks && !readOnlyRef.current && !corner && !target.closest?.('.board-selbox');
    // its eraser end erases while it is turned round
    const eraserEnd = e.pointerType === 'pen' && (e.buttons & 32) !== 0;
    const t = eraserEnd ? 'eraser' : penTakes ? loadDeckInk().pen : toolRef.current;
    const drawTool = (t === 'pen' || t === 'highlighter') && (e.pointerType !== 'touch' || finger) && !readOnlyRef.current;
    const origsOf = (ids: ReadonlySet<string>) => { const m = new Map<string, BoardObj>(); for (const id of ids) { const o = objects.get(id); if (o) m.set(id, { ...o, pts: o.pts?.map(p => [...p] as [number, number, number]) }); } return m; };
    const onSelBox = !!target.closest?.('.board-selbox');
    vp.setPointerCapture(e.pointerId);
    if (t === 'laser' && (e.pointerType !== 'touch' || finger)) {
      // the laser pointer: a viewer may use it too — nothing is written
      laserRef.current = [[bx, by]];
      setLaserFade(null);
      dragRef.current = { kind: 'laser', start: [bx, by] };
      try { provider.awareness.setLocalStateField('boardLaser', { pts: [[round1(bx), round1(by)]] }); } catch { /* closing */ }
    } else if (onSelBox && !corner && selectedRef.current.size && !readOnlyRef.current) {
      // dragging inside the selection box moves the whole selection
      dragRef.current = { kind: 'move', start: [bx, by], origs: origsOf(selectedRef.current) };
    } else if (e.button === 1 || ((t === 'select' || t === 'lasso') && !objId && !corner && (t === 'select' || (e.pointerType === 'touch' && !finger)))) {
      if (selectedRef.current.size) setSelected(new Set());
      dragRef.current = { kind: 'pan', start: [e.clientX - camRef.current.tx, e.clientY - camRef.current.ty] };
    } else if (e.pointerType === 'touch' && !objId && t !== 'select' && !corner && !(finger && (t === 'pen' || t === 'highlighter' || t === 'eraser'))) {
      dragRef.current = { kind: 'pan', start: [e.clientX - camRef.current.tx, e.clientY - camRef.current.ty] };
    } else if (corner === 'rot' && selectedRef.current.size && !readOnlyRef.current) {
      // the rotation handle: strokes turned about the selection's middle
      const base = groupBBox(selectedRef.current);
      if (base) {
        const cx = base.x + base.w / 2, cy = base.y + base.h / 2;
        dragRef.current = { kind: 'rotate', start: [bx, by], origs: origsOf(selectedRef.current), rot: { cx, cy, a0: Math.atan2(by - cy, bx - cx) } };
        undo.stopCapturing();
      }
    } else if (corner && selectedRef.current.size && !readOnlyRef.current) {
      const base = groupBBox(selectedRef.current);
      if (base) dragRef.current = { kind: 'resize', corner, start: [bx, by], origs: origsOf(selectedRef.current), base };
    } else if (t === 'lasso' && !readOnlyRef.current && (e.pointerType !== 'touch' || finger || !objId)) {
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
      dragRef.current = { kind: 'erase', start: [bx, by], last: [bx, by], end: eraserEnd };
      undo.stopCapturing();
      eraseAt(bx, by);
    } else if (t === 'note' && !readOnlyRef.current) {
      const nid = newId();
      mutate(() => objects.set(nid, { t: 'note', x: round1(bx), y: round1(by), w: 180, h: 100, color: NOTE_COLORS[objects.size % NOTE_COLORS.length], text: '' }));
      setTool('select');
      setSelected(new Set([nid]));
      setEditing(nid);
    } else if (isShapeTool(t) && (e.pointerType !== 'touch' || finger) && !readOnlyRef.current) {
      // a line or a shape: dragged out from here in the pen's colour and width
      const pen = loadDeckInk().pens.pen;
      liveRef.current = { color: pen.color, w: pen.width, poly: true, pts: [[bx, by, 0]] };
      dragRef.current = { kind: 'draw', start: [bx, by] };
    } else if (drawTool) {
      const hl = t === 'highlighter';
      const drawing = loadDeckInk(), pen = drawing.pens[hl ? 'highlighter' : 'pen'];
      endScratch();
      if (drawing.scribble && !hl) scratchRef.current = { hits: new Set(), rest: { x: e.clientX, y: e.clientY, t: performance.now(), timer: null }, judged: 0 };
      liveRef.current = { color: pen.color, w: pen.width, nib: { ...drawing.nib }, pressure: e.pointerType === 'pen', ...(hl ? { o: HIGHLIGHT_OPACITY } : {}), pts: [[bx, by, pointPressure(e)]] };
      liveT.current = e.timeStamp;
      liveFirst.current = { kind: e.pointerType, p: pointPressure(e) };
      drawingRef.current = { id: e.pointerId, watch: strokeWatch('board', e) };
      dragRef.current = { kind: 'draw', start: [bx, by] };
      endHold();
      if (drawing.snap) holdRef.current = { x: e.clientX, y: e.clientY, timer: setTimeout(snapLive, SNAP_HOLD_MS) };
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
    lastAt.current = toBoard(e.clientX, e.clientY);
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
    } else if (d?.kind === 'rotate' && d.origs && d.rot) {
      const { cx, cy, a0 } = d.rot;
      const a = rotationAngle(Math.atan2(by - cy, bx - cx) - a0, e.shiftKey);
      mutate(() => {
        for (const [id, o0] of d.origs!) if (o0.t === 'stroke' && o0.pts) objects.set(id, restroke(o0, rotatePts(absPts(o0), cx, cy, a)));
      });
    } else if (d?.kind === 'erase') {
      eraseAt(bx, by, d.last);
      d.last = [bx, by];
    } else if (liveRef.current?.poly && d?.kind === 'draw' && isShapeTool(toolRef.current)) {
      liveRef.current.pts = shapePoints(toolRef.current, d.start, [bx, by], liveRef.current.w, e.shiftKey);
      try { provider.awareness.setLocalStateField('boardInk', liveRef.current); } catch { /* closing */ }
      rerender();
    } else if (liveRef.current?.raw && (!liveRef.current.restAt || Math.hypot(e.clientX - liveRef.current.restAt[0], e.clientY - liveRef.current.restAt[1]) <= SNAP_LEAVE_PX)) {
      // snapped to a shape (draw and hold): it stays while the pen rests
    } else if (liveRef.current && (!drawingRef.current || drawingRef.current.id === e.pointerId)) {
      // the pen moved on from where it snapped: it only paused — the stroke as drawn again
      if (liveRef.current.raw) { const { raw, restAt: _at, poly: _poly, ...rest } = liveRef.current; liveRef.current = { ...rest, pts: raw }; }
      const hd = holdRef.current;
      if (!hd || Math.hypot(e.clientX - hd.x, e.clientY - hd.y) > SCRATCH_HOLD_PX) {
        if (hd) clearTimeout(hd.timer);
        holdRef.current = loadDeckInk().snap ? { x: e.clientX, y: e.clientY, timer: setTimeout(snapLive, SNAP_HOLD_MS) } : null;
      }
      const events = (e.getCoalescedEvents?.() ?? [e]);
      for (const ev of events) {
        const [x, y] = toBoard(ev.clientX, ev.clientY);
        const p: [number, number, number] = [x, y, pointPressure(ev)];
        // (each point once: Safari's coalesced events repeat the last move's, freehand.ts freshPoint)
        if (liveRef.current.pts.length >= 4000 || !freshPoint(liveRef.current.pts, liveT.current, ev.timeStamp, p)) continue;
        liveT.current = ev.timeStamp;
        liveRef.current.pts.push(p);
        if (!liveRef.current.pressure && pressed(liveFirst.current.kind, liveFirst.current.p, p[2])) liveRef.current.pressure = true;
        drawingRef.current?.watch?.add(ev.clientX, ev.clientY, ev.timeStamp, ev === e ? 'move' : 'coalesced');
      }
      const sc = scratchRef.current;
      if (sc) {
        // what the scribble would erase fades as it goes (every ~80 ms); resting the pen asks for it (scratch and hold)
        const now = performance.now(), r = sc.rest;
        if (Math.hypot(e.clientX - r.x, e.clientY - r.y) > SCRATCH_HOLD_PX) {
          if (r.timer) clearTimeout(r.timer);
          sc.rest = { x: e.clientX, y: e.clientY, t: now, timer: setTimeout(() => { judgeScratch(true); rerender(); }, SCRATCH_HOLD_MS) };
        }
        if (now - sc.judged > 80) judgeScratch(false);
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
    const drawn = drawingRef.current;
    if (drawn && drawn.id !== e.pointerId && live) return;
    drawingRef.current = null;
    if (live && dragRef.current?.kind === 'draw') {
      endHold();
      if (!live.poly || live.raw) strokeEnded(drawn?.watch ?? null);
      liveRef.current = null;
      try { provider.awareness.setLocalStateField('boardInk', null); } catch { /* closing */ }
      const xs = live.pts.map(p => p[0]), ys = live.pts.map(p => p[1]);
      const tiny = live.poly && Math.max(...xs) - Math.min(...xs) < 3 / camRef.current.s && Math.max(...ys) - Math.min(...ys) < 3 / camRef.current.s;
      // a scribble over strokes erases them (core/scratchout.ts; the pen resting at its end: scratch and hold)
      const sc = scratchRef.current;
      const erased = sc && !live.poly ? scratchTargets(performance.now() - sc.rest.t >= SCRATCH_HOLD_MS) : [];
      endScratch();
      if (live.pts.length && !tiny) {
        const sid = newId();
        // (a scribble's own undo step, and the erasing another: the first undo brings the strokes back with the scribble as ink, in case it was drawing — OneNote)
        if (erased.length || live.raw) undo.stopCapturing();
        if (live.raw) {
          // snapped (draw and hold): the stroke as drawn, then its shape — the first undo brings the stroke back
          mutate(() => objects.set(sid, strokeToObj(live.raw!, live.color, live.w, live.o, live.nib, live.pressure)));
          undo.stopCapturing();
          mutate(() => objects.set(sid, strokeToObj(live.pts, live.color, live.w, live.o, undefined, undefined, true)));
        } else mutate(() => objects.set(sid, strokeToObj(live.pts, live.color, live.w, live.o, live.nib, live.pressure, live.poly)));
        if (erased.length) {
          undo.stopCapturing();
          mutate(() => { for (const key of [...erased, sid]) objects.delete(key); });
          notify(`Scribbled out ${erased.length} stroke${erased.length > 1 ? 's' : ''} — Undo brings ${erased.length > 1 ? 'them' : 'it'} back`);
        }
      }
    }
    if (dragRef.current?.kind === 'erase' && !dragRef.current.end && toolRef.current === 'eraser' && loadDeckInk().eraser.back) setTool(loadDeckInk().pen);
    if (dragRef.current?.kind === 'lasso') {
      const poly = lassoRef.current;
      setLassoPts(null);
      if (poly && poly.length > 4) {
        // Goodnotes semantics: the (auto-closed) lasso selects a stroke it touches — any part inside or
        // crossing the line —, a picture or note most of which it holds; of the kinds and colours its
        // settings let it take (deckink.ts)
        const hit = new Set<string>();
        objects.forEach((o, key) => {
          if (o.t === 'stroke') {
            if (o.pts?.length && lassoTakes(o.poly ? 'shapes' : 'ink', [o.color]) && polylineHitsPolygon(absPts(o), poly)) hit.add(key);
          } else if (lassoTakes(o.t === 'img' ? 'pictures' : 'text', o.t === 'note' ? [o.color] : []) && rectMostlyInPolygon(o.x, o.y, o.w, o.h, poly)) hit.add(key);
        });
        setSelected(e.shiftKey ? new Set([...selectedRef.current, ...hit]) : hit);
      } else {
        if (!e.shiftKey) setSelected(new Set());
        // a tap on nothing with something copied: Paste there (GoodNotes' lasso tap)
        if (heldInk() && !readOnlyRef.current) setPasteAt(dragRef.current.start);
      }
    }
    dragRef.current = null;
    rerender();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    else setCam(c => ({ ...c, tx: c.tx - e.deltaX, ty: c.ty - e.deltaY }));
  };

  /* ------------------------------------------------------------- the lasso's selection */

  const selObjs = () => [...selectedRef.current].map(id => [id, objects.get(id)] as const).filter((x): x is readonly [string, BoardObj] => !!x[1]);
  /** the selection as the ink clipboard has it (deliverable/inkselect.ts) */
  const clipOfSelection = (): InkClip | null => makeInkClip({
    strokes: selObjs().filter(([, o]) => o.t === 'stroke' && o.pts?.length).map(([, o]) => ({
      color: o.color ?? '#000000', w: o.sw ?? 2, ...(o.o !== undefined ? { o: o.o } : {}),
      ...(o.poly ? { poly: true as const } : { ...(o.nib ? { nib: o.nib } : {}), ...(o.pressure !== undefined ? { pressure: o.pressure } : {}) }), pts: absPts(o),
    })),
    imgs: selObjs().filter(([, o]) => o.t === 'img' && o.src).map(([, o]) => ({ project, path: o.src!, x: o.x, y: o.y, w: o.w, h: o.h })),
    notes: selObjs().filter(([, o]) => o.t === 'note').map(([, o]) => ({ text: o.text ?? '', ...(o.color ? { color: o.color } : {}), x: o.x, y: o.y, w: o.w, h: o.h })),
  });
  /** a clip pasted with its middle at `at` (else where the pointer was, else the middle of the view), selected with the lasso in hand */
  const pasteClip = (clip: InkClip, at?: [number, number] | null) => {
    if (readOnlyRef.current) return;
    const vp = vpRef.current!.getBoundingClientRect();
    const c = at ?? lastAt.current ?? toBoard(vp.left + vp.width / 2, vp.top + vp.height / 2);
    const ox = c[0] - clip.w / 2, oy = c[1] - clip.h / 2;
    const ids: string[] = [];
    let skipped = 0;
    undo.stopCapturing();
    mutate(() => {
      for (const st of clip.strokes) { const id = newId(); ids.push(id); objects.set(id, strokeToObj(st.pts.map(([x, y, p]) => [ox + x, oy + y, p] as [number, number, number]), st.color, st.w, st.o, st.nib, st.pressure, st.poly)); }
      // (a picture is a file of its project: one copied from another project is not here)
      for (const im of clip.imgs) { if (im.project !== project) { skipped++; continue; } const id = newId(); ids.push(id); objects.set(id, { t: 'img', x: round1(ox + im.x), y: round1(oy + im.y), w: round1(im.w), h: round1(im.h), src: im.path }); }
      for (const n of clip.notes) { const id = newId(); ids.push(id); objects.set(id, { t: 'note', x: round1(ox + n.x), y: round1(oy + n.y), w: round1(n.w), h: round1(n.h), color: n.color ?? NOTE_COLORS[0], text: n.text }); }
    });
    undo.stopCapturing();
    if (skipped) notify(`${skipped} picture${skipped > 1 ? 's' : ''} from another project left out`);
    if (toolRef.current !== 'select' && toolRef.current !== 'lasso') setTool('lasso');
    setSelected(new Set(ids));
  };
  /** one undo step of its own */
  const change = (fn: () => void) => { undo.stopCapturing(); mutate(fn); undo.stopCapturing(); rerender(); };
  const removeSelection = () => { change(() => { for (const id of selectedRef.current) objects.delete(id); }); setSelected(new Set()); };
  const copySelection = (e?: ClipboardEvent): boolean => { const clip = clipOfSelection(); if (clip) holdInk(clip, e); return !!clip; };
  const duplicateSelection = () => {
    const clip = clipOfSelection(), bb = groupBBox(selectedRef.current);
    if (!clip || !bb) return;
    const d = 24 / camRef.current.s;
    pasteClip(clip, [bb.x + bb.w / 2 + d, bb.y + bb.h / 2 + d]);
  };
  /** the selection's box in client px (its bar's place) */
  const clientBox = (b: { x: number; y: number; w: number; h: number }) => {
    const r = vpRef.current!.getBoundingClientRect(), c = camRef.current;
    return { x: r.left + c.tx + b.x * c.s, y: r.top + c.ty + b.y * c.s, w: b.w * c.s, h: b.h * c.s };
  };
  /** what the lasso bar does to the selection (deliverable/lassobar.tsx) */
  const lassoActions = (): LassoActions => {
    const strokes = selObjs().filter(([, o]) => o.t === 'stroke' && !!o.pts?.length);
    const freehand = strokes.filter(([, o]) => !o.poly);
    const colors = new Set(strokes.map(([, o]) => (o.color ?? '').toLowerCase()));
    return {
      color: colors.size === 1 ? [...colors][0] : null,
      ...(strokes.length ? {
        recolor: (c: string) => change(() => { for (const [id, o] of strokes) objects.set(id, { ...o, color: c }); }),
        thicken: (k: number) => change(() => { for (const [id, o] of strokes) objects.set(id, { ...o, sw: thickened(o.sw ?? 2, k) }); }),
      } : {}),
      duplicate: duplicateSelection,
      copy: () => { if (copySelection()) notify('Copied — Ctrl+V, or a tap with the lasso on the board, pastes it'); },
      cut: () => { if (copySelection()) removeSelection(); },
      remove: removeSelection,
      ...(freehand.length ? {
        straighten: () => {
          let n = 0;
          change(() => {
            for (const [id, o] of freehand) {
              const shape = snapShape(absPts(o), { zoom: camRef.current.s });
              if (!shape) continue;
              n++;
              objects.set(id, { ...strokeToObj(shape.pts.map(([x, y]) => [x, y, 0] as [number, number, number]), o.color ?? '#000', o.sw ?? 2, o.o, undefined, undefined, true), ...(o.z !== undefined ? { z: o.z } : {}) });
            }
          });
          notify(n ? `${n} stroke${n > 1 ? 's' : ''} made ${n > 1 ? 'shapes' : 'a shape'} — Undo brings ${n > 1 ? 'them' : 'it'} back as drawn` : 'None of these strokes looks like a line, an arrow or a shape');
        },
        toText: () => void typeNotes(freehand.map(([id]) => id)),
      } : {}),
    };
  };
  /** the handwriting typed: read by the server, then a sticky note in its place (the first undo brings the handwriting back) */
  const typeNotes = async (ids: string[]) => {
    const strokes = ids.map(id => objects.get(id)).filter((o): o is BoardObj => !!o?.pts?.length);
    const bb = groupBBox(new Set(ids));
    if (!strokes.length || !bb) return;
    notify('Reading the handwriting…');
    let readings: string[];
    try { readings = await readHandwriting(strokes.map(absPts), 'notes'); } catch (err) { notify(readingError(err), 'error'); return; }
    if (!readings.length) { notify('No handwriting could be read there'); return; }
    const at = clientBox(bb);
    const text = await chooseReading(readings, at.x, at.y + at.h + 8);
    if (!text) return;
    const nid = newId();
    change(() => {
      for (const id of ids) objects.delete(id);
      objects.set(nid, { t: 'note', x: round1(bb.x), y: round1(bb.y), w: round1(Math.max(160, bb.w)), h: round1(Math.max(80, bb.h)), color: NOTE_COLORS[0], text: text.slice(0, 4000) });
    });
    setSelected(new Set([nid]));
    notify('Typed as a sticky note — Undo brings the handwriting back');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (editing) {
      // a key typed the moment the note was made, before its text box has the focus: the note's
      const ta = vpRef.current?.querySelector<HTMLTextAreaElement>('.board-note-edit');
      if (ta && e.target !== ta && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        ta.focus({ preventScroll: true });
        ta.setRangeText(e.key, ta.selectionStart, ta.selectionEnd, 'end');
      }
      return;
    }
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current.size && !readOnlyRef.current) {
      removeSelection();
      e.preventDefault();
    } else if (mod && (k === 'c' || k === 'x') && selectedRef.current.size) {
      // (the copy event that follows puts it on the system clipboard too, where the browser sends one)
      copySelection();
      if (k === 'x' && !readOnlyRef.current) { removeSelection(); e.preventDefault(); }
    } else if (mod && k === 'd' && selectedRef.current.size && !readOnlyRef.current) { duplicateSelection(); e.preventDefault(); } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.shiftKey ? undo.redo() : undo.undo(); e.preventDefault(); }
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
    // strokes, pictures and notes copied with the lasso, here or in a document's margin
    const clip = !editing && !readOnlyRef.current ? pastedInk(e) : null;
    if (clip) { pasteClip(clip); e.preventDefault(); return; }
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
      // not controlled: a render while typing (a co-author's cursor moving) put the empty text back, and
      // `autofocus` does nothing for an element added later — the keys went to the board, the note
      // stayed empty and the board, still "editing", ignored Ctrl+Z from then on
      defaultValue={o.text ?? ''}
      // (after the click that made the note: its mousedown focuses the board, which would close the note again)
      ref={el => { if (el && !el.dataset.focused) { el.dataset.focused = '1'; setTimeout(() => { if (el.isConnected && document.activeElement !== el) { el.focus({ preventScroll: true }); el.select(); } }, 0); } }}
      onBlur={e => { const v = (e.target as HTMLTextAreaElement).value; mutate(() => { const cur = objects.get(key); if (cur) objects.set(key, { ...cur, text: v }); }); setEditing(null); }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur(); }}
      onPointerDown={e => e.stopPropagation()}
    />
  );

  // the Modern interface draws its line icons where Classic shows the emoji
  const modern = useUiMode() === 'modern';
  const face = (id: string, emoji: string) => (modern && MODERN_ICONS[id] ? <span class="bd-ic" dangerouslySetInnerHTML={{ __html: iconSvg(MODERN_ICONS[id], 17) }} /> : emoji);
  const toolBtn = (t: Tool, label: string, title: string) => (
    <button class={'small-btn' + (tool === t ? ' active' : '')} data-tool={t} title={title} onClick={() => setTool(t)}>{face('bd-' + t, label)}</button>
  );
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
      onCopy={(e: ClipboardEvent) => { if (!editing && selectedRef.current.size) copySelection(e); }}
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
              style={{ left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px', overflow: 'visible', ...(scratchRef.current?.hits.has(key) ? { opacity: 0.3 } : {}) }}
              viewBox={`0 0 ${o.w} ${o.h}`} width={o.w} height={o.h}>
              <BoardStroke stroke={{ color: o.color ?? '#000', w: o.sw ?? 2, pts: o.pts ?? [], nib: o.nib, pressure: o.pressure, o: o.o, poly: o.poly }} legacy={strokeD(o)} />
            </svg>
          );
        })}
        {/* in-progress strokes: mine and the other clients' (awareness) */}
        {[...remoteInks, ...(liveRef.current ? [scratchRef.current?.hits.size ? { ...liveRef.current, color: '#8a9099' } : liveRef.current] : [])].map((s, i) => (
          <svg key={'live' + i} class="board-stroke live" style={{ left: 0, top: 0, overflow: 'visible' }} width={1} height={1}>
            <BoardStroke stroke={s} />
          </svg>
        ))}
        {selBB && (
          <div class="board-selbox" style={{ left: selBB.x + 'px', top: selBB.y + 'px', width: selBB.w + 'px', height: selBB.h + 'px' }}>
            {['nw', 'ne', 'sw', 'se'].map(c => <span key={c} class={'board-handle ' + c} data-corner={c} style={{ transform: `scale(${1 / cam.s})` }} />)}
            {/* strokes alone turn (Shift: in steps of 15°) */}
            {!readOnly && [...selected].every(id => objects.get(id)?.t === 'stroke') && (
              <span class="board-handle rot" data-corner="rot" title="Rotate (Shift: in steps of 15°)" style={{ top: -24 / cam.s + 'px', transform: `scale(${1 / cam.s})` }} />
            )}
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
            <span class="name" style={{ background: p.color, color: inkOn(p.color), transform: `scale(${1 / cam.s})` }}>{p.name}</span>
          </div>
        ))}
      </div>
      {/* the lasso selection's bar (recolour, copy, convert …), and Paste after a tap with the lasso */}
      {selBB && !readOnly && !editing && !dragRef.current && !liveRef.current && <LassoBar id="board-lasso-bar" groups={lassoGroups(lassoActions())} rect={clientBox(selBB)} />}
      {pasteAt && !selBB && heldInk() && <LassoBar id="board-paste-bar" groups={pasteGroups(() => { const clip = heldInk(); const at = pasteAt; setPasteAt(null); if (clip) pasteClip(clip, at); })} rect={clientBox({ x: pasteAt[0], y: pasteAt[1], w: 0, h: 0 })} />}
      <div class="board-tools" onPointerDown={e => e.stopPropagation()}>
        {toolBtn('select', '⤢', 'Select / move (drag empty space to pan)')}
        {toolBtn('laser', '🔴', 'Laser pointer — a glowing trace that stays while you hold the pen down and fades when you lift it; not saved, seen live by everyone on the board')}
        {!readOnly && toolBtn('note', '🗒', 'Sticky note')}
        {!readOnly && <button class="small-btn" title="Add images (or paste / drag them in)" onClick={pickImages}>{face('bd-image', '🖼')}</button>}
        <button class={'small-btn' + (fingerDraw ? ' active' : '')} data-finger-draw title={fingerDraw ? 'Drawing with a finger is on — a finger draws, two fingers pan and zoom (click to let a finger pan)' : 'Draw with a finger (otherwise only a pen or the mouse draws; a finger pans)'} onClick={() => setFingerDraw(!fingerDraw)}>{face('bd-finger', '☝')}</button>
        {!readOnly && <span class="board-sep" />}
        {!readOnly && <Toolbar id="board-draw" groups={drawingToolbar({
          tool: tool === 'pen' || tool === 'highlighter' ? 'pen' : tool,
          setTool: next => { if (next === 'pen') setTool(loadDeckInk().pen); else if (next === 'eraser' || next === 'lasso') setTool(next); },
          lasso: { kinds: ['ink', 'shapes', 'pictures', 'text'], textLabel: 'Notes', colors: () => usedColors([...objects.values()].map(o => o.color)) },
          ink: { presets: loadDeckInk(), set: patch => saveDeckInk(patchDeckInk(loadDeckInk(), patch)), draw: on => setTool(on ? loadDeckInk().pen : 'select') },
          done: false,
          shapes: { tool: isShapeTool(tool) ? tool : null, set: kind => setTool(kind) },
        })} />}

      </div>
      <div class="board-zoom" onPointerDown={e => e.stopPropagation()}>
        <button class="small-btn" title="Zoom out" onClick={() => zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.25)}>−</button>
        <button class="small-btn" title="Reset zoom" onClick={() => setCam(c => ({ ...c, s: 1 }))}>{Math.round(cam.s * 100)}%</button>
        <button class="small-btn" title="Zoom in" onClick={() => zoomAt(innerWidth / 2, innerHeight / 2, 1.25)}>+</button>
        <button class="small-btn" title="Zoom to fit everything" onClick={fit}>{face('bd-fit', '⤢')}</button>
        <span class={'board-conn ' + conn} title={conn === 'online' ? 'Connected — changes sync live and save automatically' : conn === 'offline' ? 'No connection — reconnecting' : 'Connecting…'}>
          {conn === 'online' ? (readOnly ? '👁 view only' : '✓ live') : conn === 'offline' ? 'offline' : '…'}
        </span>
      </div>
    </div>
  );
}

function BoardStroke({ stroke, legacy }: { stroke: LiveStroke; legacy?: string }) {
  const runs = strokeRuns(stroke);
  return runs ? <g fill="none" stroke={stroke.color} opacity={stroke.o ?? 1} stroke-linecap="round" stroke-linejoin="round">{runs.map(run => <path d={run.d} stroke-width={run.w} />)}</g>
    : <path d={legacy ?? strokePathD(stroke)} fill={stroke.color} fill-opacity={stroke.o ?? 1} />;
}
