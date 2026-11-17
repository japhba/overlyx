/**
 * Whiteboard editor for .board documents: an infinite pan/zoom canvas with freehand ink
 * (pen/highlighter, pressure-sensitive), images (paste, drop or upload — move/resize like Miro)
 * and sticky notes; a minimap of the whole board in a corner finds the way (BoardMinimap.tsx).
 * State is a Yjs map synced through the same websocket layer as the text editor (docs.ts
 * BoardDoc on the server), so everything is live-collaborative: finished objects
 * flow through the CRDT, in-progress strokes and cursors through the awareness channel.
 *
 * Objects live in Y.Map('objects'): id → { t, x, y, w, h, ... } (whole-object last-writer-wins;
 * strokes store their points relative to (x, y), normalised so the bounding box is (0,0,w,h) —
 * resizing scales the points). The server serialises the map to the .board JSON file on disk.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { inkOn } from './contrast';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { connectParams } from '@overlyx/core/collab/connect.ts';
import * as decoding from 'lib0/decoding';
import { strokePathD, strokeRuns, polylineHitsPolygon, rectMostlyInPolygon, splitDocId, type InkStroke } from '@overlyx/core';
import { api, fileUrl, type User } from '../api';
import { imageFiles, imageExt, uploadBaseName, uploadUnique, isSvgMarkup, svgFile } from '../editor/imagepaste';
import { HIGHLIGHT_OPACITY, subscribeInk } from '../editor/plugins/ink';
import { LaserSession, tracePaths, LASER_COLOR, LASER_FADE_MS, LASER_GLOW_W, LASER_GLOW_OPACITY } from './laser';
import { useUiMode } from './uimode';
import { MODERN_ICONS, iconSvg } from './modernicons';
import { hostedZoomPill } from './zoomhud';
import { BoardMinimap } from './BoardMinimap';
import { Toolbar, ICONS } from './Toolbar';
import { BoardPresence } from './BoardPresence';
import { BoardSettings } from './BoardSettings';
import { gridStyle, snapTo, clampZoom, viewRect, camForPeer, lerpCam, ease, readPeer, type BoardPeer, type Camera } from './boardview';
import { browserFullscreen } from './fullscreen';
import { getPrefs, subscribePrefs } from '../prefs';
import { pinchLock, pinchFactor, triGesture, type PinchLock } from '../deliverable/gestures';
import { touchScreen } from '../deliverable/deckdock';
import './board.css';
import { drawingToolbar } from '../deliverable/drawingToolbar';
import { loadDeckInk, saveDeckInk, patchDeckInk, ERASER_PX } from '../deliverable/deckink';
import { lassoGroups, readHandwriting, chooseReading, readingError, type LassoActions } from '../deliverable/lassobar';
import { LassoBar, pasteGroups } from '../deliverable/InkSelectionBar';
import { lassoTakes, usedColors, makeInkClip, holdInk, heldInk, pastedInk, rotatePts, rotationAngle, thickened, type InkClip } from '../deliverable/inkselect';
import { snapShape, SNAP_HOLD_MS, SNAP_LEAVE_PX } from '@overlyx/core/shapesnap.ts';
import { eraseAlong } from '@overlyx/core/inkerase.ts';
import { FingerHold } from '@overlyx/core/fingerlasso.ts';
import { freshPoint, type NibOpts, type InkCache } from '@overlyx/core/freehand.ts';
import { pointPressure, pressed, watchForce } from '../deliverable/runtime/pressure';
import { scratchOut, scribbleCusps, SCRATCH_HOLD_MS, SCRATCH_HOLD_PX } from '@overlyx/core/scratchout.ts';
import type { StrokeWatch } from '@overlyx/core/glitch.ts';
import { strokeWatch, strokeEnded } from '../glitches';
import { shapePoints, INK_SHAPES, type InkShape } from '@overlyx/core';
import { holdReload } from './update';
const isShapeTool = (t: string): t is InkShape => (INK_SHAPES as readonly string[]).includes(t);

/** the pen in hand as a board has it (the comment pen, a slide's, draws as the pen here) */
const boardPen = (): 'pen' | 'highlighter' => (loadDeckInk().pen === 'highlighter' ? 'highlighter' : 'pen');

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
/** `raw`: the stroke as drawn, once draw and hold snapped it to a shape (`pts` is the shape then), and where the pen rested (client px) */
interface LiveStroke { color: string; w: number; o?: number; nib?: NibOpts; pressure?: boolean; poly?: true; pts: [number, number, number][]; raw?: [number, number, number][]; restAt?: [number, number] }
/**
 * The laser held, as it goes to the others (board coordinates, with the pressure): `n` the trace's
 * number (another: a new trace), `pen` a Pencil's. Clients before them sent [x, y] alone.
 */
interface BoardLaser { pts: [number, number, number?][]; n?: number; pen?: boolean }
/** another's laser traces, kept after its field vanished so they fade here too (`src`: the points they were last taken from) */
interface RemoteLaser { s: LaserSession; color: string; name?: string; src: unknown }

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
/** a stroke object's runs, worked out once (the board renders at every move of a pen drawing: every stroke worked out again each time made the line lag behind the pen) */
const runsCache = new WeakMap<object, { w: number; d: string }[] | null>();
function objRuns(o: BoardObj): { w: number; d: string }[] | null {
  let r = runsCache.get(o);
  if (r === undefined) {
    r = strokeRuns({ color: o.color ?? '#000', w: o.sw ?? 2, pts: o.pts ?? [], nib: o.nib, pressure: o.pressure, o: o.o, poly: o.poly } as InkStroke);
    runsCache.set(o, r);
  }
  return r;
}

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
  // the laser (app/laser.ts): my traces, held and then fading together; the others' from awareness, kept to fade too
  const laser = useRef(new LaserSession()).current;
  const laserGone = useRef<ReturnType<typeof setTimeout>>();
  const remoteLasers = useRef(new Map<number, RemoteLaser>());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [lassoPts, setLassoPts] = useState<[number, number][] | null>(null);
  const lassoRef = useRef(lassoPts); lassoRef.current = lassoPts;
  const [editing, setEditing] = useState<string | null>(null);
  const [conn, setConn] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [readOnly, setReadOnly] = useState(false);
  const readOnlyRef = useRef(readOnly); readOnlyRef.current = readOnly;
  const liveRef = useRef<LiveStroke | null>(null);
  /** what the last frame made of the stroke being drawn (freehand.ts InkCache): only its end is worked out again; when it was last sent to the others */
  const liveCache = useRef<InkCache>({});
  const liveSent = useRef(0);
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
  /** the person's board settings (the ⚙: grid, snapping, the others' pointers — prefs.ts) */
  const [prefs, setPrefsState] = useState(getPrefs);
  useEffect(() => subscribePrefs(p => setPrefsState(p)), []);
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** the board alone on the screen (full), its bars tapped away with a finger there (barsAway), the hint saying so */
  const [full, setFullState] = useState(false);
  const fullRef = useRef(full); fullRef.current = full;
  const [barsAway, setBarsAway] = useState(false);
  const [fullHint, setFullHint] = useState(0);
  /** whose view this one moves with (BoardPresence's Follow), and a flight to someone under way (its number: a newer one, or the person's own pan, ends it) */
  const [following, setFollowingState] = useState<number | null>(null);
  const followingRef = useRef(following); followingRef.current = following;
  const flight = useRef(0);
  const flying = useRef(false);
  /** the view's size (the others' markers at its edges, what it shows of the board to the others) */
  const [vpSize, setVpSize] = useState<[number, number]>([0, 0]);
  /** the others on the board as their awareness states say, as the last render saw them */
  const peersRef = useRef<BoardPeer[]>([]);
  /** the tool bar (the markers for the others stay below it) */
  const toolsRef = useRef<HTMLDivElement>(null);
  /** the board was fitted into the view once it came (not again at every reconnection) */
  const fitted = useRef(false);

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
    // (fitted the first time only: a reconnection — a tablet woken up — leaves the view where it is)
    const onSync = (s: boolean) => { if (s) { setConn('online'); if (!fitted.current) { fitted.current = true; fit(); } } };
    provider.on('sync', onSync);
    // the provider connects as it is created (useMemo above), before this effect runs: a fast
    // connection (WebKit, a warm second page) was connected and synced already, and the board said
    // "Connecting…" for good — take the state it is in
    if (provider.synced) onSync(true); else if (provider.wsconnected) onStatus({ status: 'connected' });
    const onAwareness = () => {
      // lasers: the trace each holds, gathered into its session; a vanished field lets them fade
      const seen = new Set<number>();
      const now = performance.now();
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === ydoc.clientID) return;
        const s = state as { user?: { name?: string; color?: string }; boardLaser?: BoardLaser | null };
        const l = s.boardLaser;
        if (!l || !Array.isArray(l.pts) || !l.pts.length) return;
        seen.add(clientId);
        let r = remoteLasers.current.get(clientId);
        if (!r) remoteLasers.current.set(clientId, r = { s: new LaserSession(), color: LASER_COLOR, src: null });
        r.color = s.user?.color ?? LASER_COLOR;
        r.name = s.user?.name;
        if (r.src === l.pts && r.s.held) return;
        r.src = l.pts;
        const pts = l.pts.slice(0, 4000).filter(q => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]))
          .map(([x, y, p]) => [x, y, typeof p === 'number' && p >= 0 && p <= 1 ? p : 0.5] as [number, number, number]);
        if (pts.length) r.s.hold(pts, l.pen === true, now, typeof l.n === 'number' ? l.n : undefined);
      });
      for (const [clientId, r] of remoteLasers.current) {
        if (seen.has(clientId) || !r.s.held) continue;
        r.s.end(now);
        setTimeout(() => { if (remoteLasers.current.get(clientId) === r && r.s.gone(performance.now())) { remoteLasers.current.delete(clientId); setPeerTick(k => k + 1); } }, LASER_FADE_MS + 50);
      }
      setPeerTick(t => t + 1);
    };
    provider.awareness.on('change', onAwareness);
    void api.readText(project, path).then(r => setReadOnly(r.role === 'view')).catch(() => {});
    // (no local copy: a reload for a newer build waits until the server has the board — update.ts)
    const unhold = holdReload(() => !(provider.wsconnected && provider.synced));
    return () => {
      unhold();
      objects.unobserve(onObjects);
      provider.awareness.off('change', onAwareness);
      provider.awareness.setLocalState(null);
      provider.destroy();
      ydoc.destroy();
    };
  }, [conn0]);

  const mutate = (fn: () => void) => { if (!readOnlyRef.current) ydoc.transact(fn, 'local'); };

  // Undo and Redo show whether there is a step to take
  useEffect(() => {
    const on = () => rerender();
    undo.on('stack-item-added', on); undo.on('stack-item-popped', on); undo.on('stack-cleared', on);
    return () => { undo.off('stack-item-added', on); undo.off('stack-item-popped', on); undo.off('stack-cleared', on); };
  }, [undo]);
  const doUndo = () => { undo.undo(); rerender(); };
  const doRedo = () => { undo.redo(); rerender(); };

  /* ------------------------------------------------------------- what the others see of me */

  // the view's size
  useLayoutEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const read = () => setVpSize(s => (s[0] === vp.clientWidth && s[1] === vp.clientHeight ? s : [vp.clientWidth, vp.clientHeight]));
    read();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
    ro?.observe(vp);
    return () => ro?.disconnect();
  }, []);
  // what my screen shows of the board (Go to and Follow on the others' screens, their minimaps), ten times a second at most
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (viewTimer.current) return;
    viewTimer.current = setTimeout(() => {
      viewTimer.current = null;
      const vp = vpRef.current;
      if (!vp || !vp.clientWidth || !vp.clientHeight) return;
      const r = viewRect(camRef.current, vp.clientWidth, vp.clientHeight);
      try { provider.awareness.setLocalStateField('boardView', { x: round1(r.x), y: round1(r.y), w: round1(r.w), h: round1(r.h) }); } catch { /* closing */ }
    }, 100);
  }, [cam, vpSize]);
  useEffect(() => () => { if (viewTimer.current) clearTimeout(viewTimer.current); }, []);
  // what I selected, and the note I write in: the others see it in my colour (and leave that note to me)
  useEffect(() => { try { provider.awareness.setLocalStateField('boardSel', selected.size ? [...selected].slice(0, 500) : null); } catch { /* closing */ } }, [selected]);
  useEffect(() => { try { provider.awareness.setLocalStateField('boardEdit', editing); } catch { /* closing */ } }, [editing]);

  /* ------------------------------------------------------------- going to the others, following them */

  /** the camera taken from the person (a flight, the following): they pan, zoom, draw or use the minimap */
  const stopCam = () => {
    flight.current++;
    flying.current = false;
    if (followingRef.current !== null) setFollowingState(null);
  };
  /** the camera flown to `to` (~0.4 s; at once where motion is reduced) */
  const flyTo = (to: Camera) => {
    const vp = vpRef.current;
    if (!vp) return;
    const from = camRef.current, W = vp.clientWidth, H = vp.clientHeight, t0 = performance.now(), id = ++flight.current;
    let still = false;
    try { still = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* moves */ }
    if (still) { setCam(to); return; }
    flying.current = true;
    const step = () => {
      if (flight.current !== id) return;
      const t = Math.min(1, (performance.now() - t0) / 420);
      setCam(lerpCam(from, to, ease(t), W, H));
      if (t < 1) requestAnimationFrame(step); else flying.current = false;
    };
    requestAnimationFrame(step);
  };
  /** to the person: what they see, their pointer in it (boardview.ts camForPeer) */
  const goTo = (p: BoardPeer) => {
    const vp = vpRef.current;
    const c = vp && camForPeer(p, camRef.current.s, vp.clientWidth, vp.clientHeight);
    if (!c) { notify(`${p.name} has not looked at the board yet`); return; }
    if (followingRef.current !== null && followingRef.current !== p.clientId) setFollowingState(null);
    flyTo(c);
  };
  const follow = (clientId: number | null) => {
    followingRef.current = clientId;
    setFollowingState(clientId);
    const p = clientId === null ? null : peersRef.current.find(q => q.clientId === clientId);
    if (p) goTo(p);
  };
  // following: my view is theirs whenever theirs changes; they left, the following ends
  const followedName = useRef('');
  useEffect(() => {
    if (following === null) return;
    const p = peersRef.current.find(q => q.clientId === following);
    if (!p) { setFollowingState(null); notify(`${followedName.current || 'They'} left the board — no longer following`); return; }
    followedName.current = p.name;
    const vp = vpRef.current;
    if (!p.view || !vp || flying.current) return;
    const c = camForPeer({ view: p.view, cursor: null }, camRef.current.s, vp.clientWidth, vp.clientHeight);
    if (c) setCam(cur => (Math.abs(cur.s - c.s) < 1e-4 && Math.abs(cur.tx - c.tx) < 0.5 && Math.abs(cur.ty - c.ty) < 0.5 ? cur : c));
  }, [peerTick, following, vpSize]);

  /* ------------------------------------------------------------- full screen */

  /**
   * The board alone on the screen, or back: the app's bars, the files and the panes go (board.css
   * html.ol-board-full), the browser's own full screen too where it has one (app/fullscreen.ts);
   * a finger's tap on the board then takes the board's own bars away and brings them back.
   */
  const setFull = (on: boolean) => {
    setFullState(on);
    setBarsAway(false);
    browserFullscreen(on);
    if (on && touchScreen()) setFullHint(h => h + 1);
  };
  useLayoutEffect(() => { document.documentElement.classList.toggle('ol-board-full', full); }, [full]);
  useEffect(() => {
    // a computer's Esc ends the browser's full screen: the board's with it (a tablet's browser leaves its own as text is typed in: the board's stays)
    const left = () => { if (!document.fullscreenElement && fullRef.current && !touchScreen()) { setFullState(false); setBarsAway(false); } };
    document.addEventListener('fullscreenchange', left);
    return () => {
      document.removeEventListener('fullscreenchange', left);
      document.documentElement.classList.remove('ol-board-full');
      if (fullRef.current) browserFullscreen(false);
    };
  }, []);

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
    stopCam();
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
    stopCam();
    setCam(c => {
      const s = clampZoom(c.s * factor);
      const k = s / c.s;
      return { s, tx: (c.tx - (clientX - r.left)) * k + (clientX - r.left), ty: (c.ty - (clientY - r.top)) * k + (clientY - r.top) };
    });
  };

  /** the minimap's press or drag (BoardMinimap.tsx): the middle of the view at that board point, the zoom kept */
  const centreAt = (x: number, y: number) => {
    const vp = vpRef.current;
    stopCam();
    if (vp) setCam(c => ({ ...c, tx: vp.clientWidth / 2 - x * c.s, ty: vp.clientHeight / 2 - y * c.s }));
  };

  /* ------------------------------------------------------------- input */

  interface Drag {
    kind: 'pan' | 'move' | 'resize' | 'rotate' | 'draw' | 'erase' | 'lasso' | 'laser';
    start: [number, number]; origs?: Map<string, BoardObj>; corner?: string; base?: { x: number; y: number; w: number; h: number };
    /** the eraser's last place (the precise eraser rubs along the way from there), a move's last offset; whether the pen's other end erases */
    last?: [number, number]; end?: boolean;
    /** the rotation's centre and the angle the press began at */
    rot?: { cx: number; cy: number; a0: number };
  }
  const dragRef = useRef<Drag | null>(null);
  /** the pointer the drag belongs to: another's moves (a hand resting on the screen) are not its */
  const dragOwner = useRef<number | null>(null);
  /** the fingers on the board (client and screen px, when each came down) — two or more are a gesture */
  const touches = useRef(new Map<number, { x: number; y: number; sx: number; sy: number; t0: number }>());
  /**
   * Two fingers: they pan and zoom the board about the point between them (gestures.ts: a pan stays a
   * pan until they close or spread enough), and tapped together they undo; three fingers: a tap
   * undoes, a swipe left undoes and right redoes (gestures.ts triGesture, as on slides).
   */
  type Gesture =
    | { kind: 'pinch'; d0: number; mid0: [number, number]; cam0: Camera; lock: PinchLock; tap: { t0: number; at: Map<number, [number, number]>; moved: boolean } | null }
    | { kind: 'tri'; mid0: [number, number]; last: [number, number]; t0: number }
    | { kind: 'many' };
  const gesture = useRef<Gesture | null>(null);
  /** the pen on the board (its pointer): fingers that come down meanwhile are the hand resting, nothing else */
  const penDown = useRef<number | null>(null);
  /** one finger's tap on an empty place in full screen: the bars away or back (where it came down, when; whether something was selected) */
  const tapRef = useRef<{ id: number; sx: number; sy: number; t: number; hadSel: boolean } | null>(null);
  /** the last tap on a sticky note with a finger: a second one soon after on it opens it to write in */
  const lastTap = useRef<{ id: string; t: number } | null>(null);
  /** the fingers on the board: one resting makes the pen's stroke a lasso, not a pinch (core/fingerlasso.ts) */
  const fingers = useRef(new FingerHold());
  const awarenessSend = useRef(0);

  const centroid = (screen: boolean): [number, number] => {
    let x = 0, y = 0;
    const ts = [...touches.current.values()];
    for (const t of ts) { x += screen ? t.sx : t.x; y += screen ? t.sy : t.y; }
    return [x / Math.max(1, ts.length), y / Math.max(1, ts.length)];
  };
  /** two or more fingers came down: what the first one began gives way (a stroke it began is not kept, its pan becomes the pinch) */
  const startGesture = () => {
    if (liveRef.current) {
      liveRef.current = null;
      drawingRef.current = null;
      try { provider.awareness.setLocalStateField('boardInk', null); } catch { /* closing */ }
    }
    endHold();
    endScratch();
    if (laser.held) { laser.drop(performance.now()); fadeLaser(); }
    if (dragRef.current?.kind === 'lasso') setLassoPts(null);
    dragRef.current = null;
    dragOwner.current = null;
    tapRef.current = null;
    const ts = [...touches.current.entries()];
    const now = performance.now();
    if (ts.length === 2) {
      const [[, a], [, b]] = ts;
      gesture.current = {
        kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), mid0: [(a.x + b.x) / 2, (a.y + b.y) / 2], cam0: camRef.current, lock: pinchLock(),
        tap: Math.abs(a.t0 - b.t0) < 150 ? { t0: now, at: new Map(ts.map(([id, p]) => [id, [p.sx, p.sy] as [number, number]])), moved: false } : null,
      };
    } else if (ts.length === 3) {
      const c = centroid(true);
      gesture.current = { kind: 'tri', mid0: c, last: c, t0: now };
    } else gesture.current = { kind: 'many' };
    rerender();
  };
  /** the two fingers moved: the board point that was between them stays between them, at the zoom their spread gives */
  const pinchMove = (g: Extract<Gesture, { kind: 'pinch' }>) => {
    const ts = [...touches.current.values()];
    if (ts.length < 2) return;
    const [a, b] = ts;
    const r = vpRef.current!.getBoundingClientRect();
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const f = pinchFactor(g.lock, g.d0, Math.hypot(a.x - b.x, a.y - b.y), Math.hypot(mx - g.mid0[0], my - g.mid0[1]));
    const s = clampZoom(g.cam0.s * f);
    const bx = (g.mid0[0] - r.left - g.cam0.tx) / g.cam0.s, by = (g.mid0[1] - r.top - g.cam0.ty) / g.cam0.s;
    setCam({ s, tx: mx - r.left - bx * s, ty: my - r.top - by * s });
  };

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
    // (every stroke on the board looked at only once the line is shaped as a scribble)
    const scribble = live.pts.map(([x, y]) => [x, y] as [number, number]);
    if (!scribbleCusps(scribble, { zoom: camRef.current.s, width: live.w, hold })) return [];
    const keys: string[] = [], lines: [number, number][][] = [];
    objects.forEach((o, key) => { if (o.t === 'stroke' && o.pts?.length) { keys.push(key); lines.push(o.pts.map(([x, y]) => [o.x + x, o.y + y])); } });
    const hits = lines.length ? scratchOut(scribble, lines, { zoom: camRef.current.s, width: live.w, hold }) : null;
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

  /** my laser's trace held to the others (board coordinates, with the pressure) */
  const sendLaser = () => {
    const t = laser.held;
    if (!t) return;
    const msg: BoardLaser = { n: t.id, pen: t.pen, pts: t.pts.map(([x, y, p]) => [round1(x), round1(y), Math.round(p * 100) / 100]) };
    try { provider.awareness.setLocalStateField('boardLaser', msg); } catch { /* closing */ }
  };
  /** my laser let go: the others' copies fade, and mine go once faded out (unless the pen came back down) */
  const fadeLaser = () => {
    try { provider.awareness.setLocalStateField('boardLaser', null); } catch { /* closing */ }
    clearTimeout(laserGone.current);
    laserGone.current = setTimeout(() => { if (laser.gone(performance.now())) { laser.clear(); rerender(); } }, LASER_FADE_MS + 50);
    rerender();
  };

  const onPointerDown = (e: PointerEvent) => {
    const vp = vpRef.current!;
    // (a hand resting on the screen while the pen draws: not a pinch, nor anything else)
    if (e.pointerType === 'touch' && penDown.current !== null) return;
    if (e.pointerType === 'pen' && !loadDeckInk().pencil) saveDeckInk(patchDeckInk(loadDeckInk(), { pencil: true }));
    const finger = e.pointerType === 'touch' && fingerDrawRef.current;
    vp.focus({ preventScroll: true });
    // the person moves the board: a flight to someone, the following, end
    stopCam();
    if (settingsOpen) setSettingsOpen(false);
    if (e.pointerType === 'touch' && !finger) fingers.current.down(e.pointerId, e.screenX, e.screenY, performance.now());
    // a finger of the other hand resting on the board + the pen: this stroke draws a lasso, and the finger
    // neither pinches with the pen nor pans; lifted, the pen inks again
    const fingerLasso = e.pointerType === 'pen' && !(e.buttons & 32) && !readOnlyRef.current && toolRef.current !== 'laser' && toolRef.current !== 'note' && fingers.current.penLands(performance.now());
    if (fingerLasso) {
      for (const id of [...touches.current.keys()]) if (fingers.current.isHolding(id)) touches.current.delete(id);
      gesture.current = null;
      dragRef.current = null;
    }
    if (e.pointerType === 'pen') penDown.current = e.pointerId;
    setPasteAt(null);
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, t0: performance.now() });
      if (touches.current.size >= 2 || gesture.current) {
        vp.setPointerCapture(e.pointerId);
        if (touches.current.size >= 2) startGesture();
        e.preventDefault();
        return;
      }
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
    const t = eraserEnd ? 'eraser' : fingerLasso ? 'lasso' : penTakes ? boardPen() : toolRef.current;
    const drawTool = (t === 'pen' || t === 'highlighter') && (e.pointerType !== 'touch' || finger) && !readOnlyRef.current;
    const origsOf = (ids: ReadonlySet<string>) => { const m = new Map<string, BoardObj>(); for (const id of ids) { const o = objects.get(id); if (o) m.set(id, { ...o, pts: o.pts?.map(p => [...p] as [number, number, number]) }); } return m; };
    const onSelBox = !!target.closest?.('.board-selbox');
    // a second tap with a finger on a sticky note (or on the box of the one selected) opens it to write in
    const one = selectedRef.current.size === 1 ? [...selectedRef.current][0] : null;
    const noteId = objId && objects.get(objId)?.t === 'note' ? objId : onSelBox && one && objects.get(one)?.t === 'note' ? one : null;
    if (noteId && e.pointerType === 'touch' && !corner && (t === 'select' || t === 'lasso') && !readOnlyRef.current) {
      const lt = lastTap.current, now = performance.now();
      if (lt && lt.id === noteId && now - lt.t < 400) { lastTap.current = null; openNote(noteId); e.preventDefault(); return; }
      lastTap.current = { id: noteId, t: now };
    }
    vp.setPointerCapture(e.pointerId);
    if (t === 'laser' && (e.pointerType !== 'touch' || finger)) {
      // the laser pointer: a viewer may use it too — nothing is written; its traces still fading come back
      clearTimeout(laserGone.current);
      laser.begin([[bx, by, pointPressure(e)]], e.pointerType === 'pen', performance.now());
      dragRef.current = { kind: 'laser', start: [bx, by] };
      sendLaser();
      rerender();
    } else if (onSelBox && !corner && selectedRef.current.size && !readOnlyRef.current) {
      // dragging inside the selection box moves the whole selection
      dragRef.current = { kind: 'move', start: [bx, by], origs: origsOf(selectedRef.current), base: groupBBox(selectedRef.current) ?? undefined };
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
      if (!readOnlyRef.current && next.has(objId)) dragRef.current = { kind: 'move', start: [bx, by], origs: origsOf(next), base: groupBBox(next) ?? undefined };
    } else if (t === 'eraser' && !readOnlyRef.current) {
      dragRef.current = { kind: 'erase', start: [bx, by], last: [bx, by], end: eraserEnd };
      undo.stopCapturing();
      eraseAt(bx, by);
    } else if (t === 'note' && !readOnlyRef.current) {
      const nid = newId();
      const g = prefsRef.current.boardSnap ? prefsRef.current.boardGridSize : 0;
      mutate(() => objects.set(nid, { t: 'note', x: round1(g ? snapTo(bx, g) : bx), y: round1(g ? snapTo(by, g) : by), w: g ? Math.max(g, Math.round(180 / g) * g) : 180, h: g ? Math.max(g, Math.round(100 / g) * g) : 100, color: NOTE_COLORS[objects.size % NOTE_COLORS.length], text: '' }));
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
      liveRef.current = { color: pen.color, w: pen.width, nib: { ...drawing.nib, ...(e.pointerType === 'pen' ? { lift: true } : {}) }, pressure: e.pointerType === 'pen', ...(hl ? { o: HIGHLIGHT_OPACITY } : {}), pts: [[bx, by, pointPressure(e)]] };
      liveT.current = e.timeStamp;
      liveFirst.current = { kind: e.pointerType, p: pointPressure(e) };
      drawingRef.current = { id: e.pointerId, watch: strokeWatch('board', e) };
      dragRef.current = { kind: 'draw', start: [bx, by] };
      endHold();
      if (drawing.snap) holdRef.current = { x: e.clientX, y: e.clientY, timer: setTimeout(snapLive, SNAP_HOLD_MS) };
    }
    dragOwner.current = dragRef.current || liveRef.current ? e.pointerId : null;
    // one finger on an empty place in full screen, nothing selected: a tap there takes the bars away or brings them back
    tapRef.current = e.pointerType === 'touch' && dragRef.current?.kind === 'pan' ? { id: e.pointerId, sx: e.screenX, sy: e.screenY, t: performance.now(), hadSel: selectedRef.current.size > 0 } : null;
    if (dragRef.current || liveRef.current) e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') fingers.current.move(e.pointerId, e.screenX, e.screenY);
    if (fingers.current.isHolding(e.pointerId)) return;   // the finger holding for the pen's lasso
    const tf = e.pointerType === 'touch' ? touches.current.get(e.pointerId) : undefined;
    if (tf) { tf.x = e.clientX; tf.y = e.clientY; tf.sx = e.screenX; tf.sy = e.screenY; }
    const tap = tapRef.current;
    if (tap && tap.id === e.pointerId && Math.hypot(e.screenX - tap.sx, e.screenY - tap.sy) > 10) tapRef.current = null;
    const g = gesture.current;
    if (g && tf) {
      if (g.kind === 'pinch') {
        if (g.tap && !g.tap.moved) { const o = g.tap.at.get(e.pointerId); if (o && Math.hypot(e.screenX - o[0], e.screenY - o[1]) > 10) g.tap.moved = true; }
        pinchMove(g);
      } else if (g.kind === 'tri' && touches.current.size === 3) g.last = centroid(true);
      return;
    }
    if (g && e.pointerType === 'touch') return;
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
    if (dragOwner.current !== null && e.pointerId !== dragOwner.current) return;
    const [bx, by] = toBoard(e.clientX, e.clientY);
    if (d?.kind === 'laser' && laser.held) {
      const evs = e.getCoalescedEvents?.() ?? [];
      for (const ev of evs.length ? evs : [e]) {
        const [x, y] = toBoard(ev.clientX, ev.clientY);
        const pts = laser.held!.pts, last = pts[pts.length - 1];
        if ((last[0] - x) ** 2 + (last[1] - y) ** 2 < 0.25 / (camRef.current.s * camRef.current.s)) { if (ev.pointerType === 'pen' && ev.pressure > 0) last[2] = ev.pressure; continue; }
        laser.add([x, y, pointPressure(ev)], now);
      }
      if (now - awarenessSend.current > 40 || laser.held!.pts.length < 4) { awarenessSend.current = now; sendLaser(); }
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
      let dx = bx - d.start[0], dy = by - d.start[1];
      // (snapping: the selection's top left corner on the grid)
      const pr = prefsRef.current;
      if (pr.boardSnap && d.base) { dx = snapTo(d.base.x + dx, pr.boardGridSize) - d.base.x; dy = snapTo(d.base.y + dy, pr.boardGridSize) - d.base.y; }
      // (no change: nothing written — a snapped move stays put between grid lines)
      if (d.last && d.last[0] === dx && d.last[1] === dy) return;
      d.last = [dx, dy];
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
      // (to the others ~25 times a second, as the margins do: every point of the stroke at every move was a
      // message as long as the stroke, and a render of the board more)
      const now = performance.now();
      if (now - liveSent.current > 40) {
        liveSent.current = now;
        try { provider.awareness.setLocalStateField('boardInk', { ...liveRef.current, pts: liveRef.current.pts.map(([x, y, p]) => [round1(x), round1(y), Math.round(p * 100) / 100]) }); } catch { /* closing */ }
      }
      rerender();
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (fingers.current.isHolding(e.pointerId)) { fingers.current.up(e.pointerId); return; }   // lifted: the pen inks again
    if (e.pointerType === 'touch') fingers.current.up(e.pointerId);
    if (e.pointerId === penDown.current) penDown.current = null;
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      touches.current.delete(e.pointerId);
      const g = gesture.current;
      if (g) {
        // the gesture's last finger lifted: two fingers tapped together undo; three tapped or swiped, as gestures.ts says
        if (!touches.current.size) {
          gesture.current = null;
          const now = performance.now();
          if (e.type === 'pointerup' && !readOnlyRef.current) {
            if (g.kind === 'pinch' && g.tap && !g.tap.moved && now - g.tap.t0 < 320) doUndo();
            else if (g.kind === 'tri') {
              const act = triGesture(g.last[0] - g.mid0[0], g.last[1] - g.mid0[1], now - g.t0);
              if (act === 'undo') doUndo(); else if (act === 'redo') doRedo();
            }
          }
        }
        return;
      }
    }
    // (another pointer's lift — a resting hand's — ends nothing of the drag)
    if (dragOwner.current !== null && e.pointerId !== dragOwner.current && (dragRef.current || liveRef.current)) return;
    const tap = tapRef.current;
    tapRef.current = null;
    if (tap && tap.id === e.pointerId && e.type === 'pointerup' && performance.now() - tap.t < 350 && !tap.hadSel && fullRef.current) setBarsAway(b => !b);
    if (dragRef.current?.kind === 'laser' && laser.held) {
      // lifted: the traces linger and fade (CSS); the others fade theirs when the field vanishes
      laser.end(performance.now());
      fadeLaser();
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
    if (dragRef.current?.kind === 'erase' && !dragRef.current.end && toolRef.current === 'eraser' && loadDeckInk().eraser.back) setTool(boardPen());
    dragOwner.current = null;
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
    // a note just opened to write in: its text box takes the keys while this is still the tap (a tablet shows its keyboard only then)
    const ta = vpRef.current?.querySelector<HTMLTextAreaElement>('.board-note-edit');
    if (ta && document.activeElement !== ta) { ta.dataset.focused = '1'; ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
    rerender();
  };

  /** a pointer the browser took away without its lift (a system gesture): it is no longer on the board */
  const onLostCapture = (e: PointerEvent) => {
    if (touches.current.delete(e.pointerId) && !touches.current.size) gesture.current = null;
    if (e.pointerId === penDown.current) penDown.current = null;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    stopCam();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    else setCam(c => ({ ...c, tx: c.tx - e.deltaX, ty: c.ty - e.deltaY }));
    // (the board moved under the pointer: the others see it where it now points)
    const { clientX: x, clientY: y } = e;
    requestAnimationFrame(() => {
      const [bx, by] = toBoard(x, y);
      try { provider.awareness.setLocalStateField('boardCursor', { x: round1(bx), y: round1(by) }); } catch { /* closing */ }
    });
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
    else if (e.key === 'Escape') {
      // (nothing more to let go of in full screen: Esc leaves it)
      if (fullRef.current && !selectedRef.current.size && toolRef.current === 'select') setFull(false);
      setSelected(new Set()); setTool('select');
    }
  };

  /* ------------------------------------------------------------- sticky notes */

  /** a screen pointed at with fingers (the notes say double-tap) */
  const coarse = useMemo(touchScreen, []);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>();
  /** a note opened to write in — unless someone else writes in it (their name says so; two writing at once would overwrite each other) */
  const openNote = (key: string) => {
    if (readOnlyRef.current || objects.get(key)?.t !== 'note') return;
    const by = peersRef.current.find(p => p.edit === key);
    if (by) { notify(`${by.name} is writing in this note`); return; }
    setSelected(new Set([key]));
    setEditing(key);
  };
  /**
   * A double click on a note opens it. (The board holds the pointer from the press on — pointer capture —
   * so the click comes to the board, not to the note: the note is the topmost one under the pointer.)
   */
  const onDblClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest?.('.board-tools, .board-zoom, .board-minimap, .board-settings, .board-people, .board-edge, .board-note-edit')) return;
    const hit = document.elementsFromPoint(e.clientX, e.clientY).find(n => n instanceof HTMLElement && n.classList.contains('board-note'));
    let key = hit?.getAttribute('data-obj') ?? null;
    if (!key) {
      // (by its box on the board: the last drawn, the topmost)
      const [bx, by] = toBoard(e.clientX, e.clientY);
      for (const [k, o] of [...objects.entries()].sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0) || (a[0] < b[0] ? -1 : 1))) {
        if (o.t === 'note' && bx >= o.x && by >= o.y && bx <= o.x + o.w && by <= o.y + o.h) key = k;
      }
    }
    if (key && objects.get(key)?.t === 'note') openNote(key);
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
  // the others: who they are, their pointers, views, selections (boardview.ts readPeer); the strokes they are drawing
  const peerList: BoardPeer[] = [];
  const remoteInks: LiveStroke[] = [];
  provider.awareness.getStates().forEach((state, clientId) => {
    if (clientId === ydoc.clientID) return;
    const p = readPeer(clientId, state);
    if (p) peerList.push(p);
    const s = state as { boardInk?: LiveStroke };
    if (s.boardInk?.pts?.length) remoteInks.push(s.boardInk);
  });
  peerList.sort((a, b) => a.clientId - b.clientId);
  peersRef.current = peerList;
  void peerTick;
  /** what each of the others selected, or writes in: the box round it */
  const peerBoxes = peerList.flatMap(p => {
    const ids = new Set(p.sel);
    if (p.edit) ids.add(p.edit);
    const bb = ids.size ? groupBBox(ids) : null;
    return bb ? [{ p, bb }] : [];
  });
  const grid = gridStyle(prefs.boardGrid, prefs.boardGridSize, cam);
  const firstName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim().split(/\s+/)[0] || name;

  /** a note's text into the board (a note deleted meanwhile stays deleted) */
  const writeNote = (key: string, v: string) => mutate(() => { const cur = objects.get(key); if (cur && cur.text !== v) objects.set(key, { ...cur, text: v.slice(0, 4000) }); });
  const noteEdit = (key: string, o: BoardObj) => (
    <textarea
      class="board-note-edit"
      // not controlled: a render while typing (a co-author's cursor moving) put the empty text back, and
      // `autofocus` does nothing for an element added later — the keys went to the board, the note
      // stayed empty and the board, still "editing", ignored Ctrl+Z from then on
      defaultValue={o.text ?? ''}
      // (after the click that made the note: its mousedown focuses the board, which would close the note again)
      // (the caret at the end of what is written: a whole note selected went with the first key typed)
      ref={el => { if (el && !el.dataset.focused) { el.dataset.focused = '1'; setTimeout(() => { if (el.isConnected && document.activeElement !== el) { el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length); } }, 0); } }}
      // (written as it is typed — the others see the note fill — a quarter of a second at most behind)
      onInput={e => { const v = (e.target as HTMLTextAreaElement).value; clearTimeout(noteTimer.current); noteTimer.current = setTimeout(() => writeNote(key, v), 250); }}
      onBlur={e => { clearTimeout(noteTimer.current); writeNote(key, (e.target as HTMLTextAreaElement).value); setEditing(null); }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur(); }}
      onPointerDown={e => e.stopPropagation()}
    />
  );

  // the Modern interface draws its line icons where Classic shows the emoji
  const modern = useUiMode() === 'modern';
  const face = (id: string, emoji: ComponentChildren) => (modern && MODERN_ICONS[id] ? <span class="bd-ic" dangerouslySetInnerHTML={{ __html: iconSvg(MODERN_ICONS[id], 17) }} /> : emoji);
  /** the settings' place: under their button, kept inside the board (300 px wide) */
  const settingsAt = () => {
    const vp = vpRef.current, btn = vp?.querySelector<HTMLElement>('[data-board-settings-btn]');
    if (!vp || !btn) return { left: 12, top: 58 };
    const r = vp.getBoundingClientRect(), b = btn.getBoundingClientRect(), tools = toolsRef.current?.getBoundingClientRect();
    return { left: Math.max(12, Math.min(r.width - 312, b.left + b.width / 2 - r.left - 150)), top: (tools ? tools.bottom : b.bottom) - r.top + 6 };
  };
  /** a line icon of the toolbars' table (Classic's face where no emoji fits) */
  const glyph = (svg: string | undefined, alt: string) => (svg ? <span class="bd-glyph" dangerouslySetInnerHTML={{ __html: svg }} /> : alt);
  const toolBtn = (t: Tool, label: string, title: string) => (
    <button class={'small-btn' + (tool === t ? ' active' : '')} data-tool={t} title={title} onClick={() => setTool(t)}>{face('bd-' + t, label)}</button>
  );
  /**
   * A laser session as SVG (app/laser.ts): its traces drawn as the pen draws, over one soft glow, and
   * a dot where it points while held — sized for the screen, not the board. Lifted, it fades as a whole (CSS).
   */
  const laserSvg = (s: LaserSession, color: string, key: string, mine: boolean, name?: string) => {
    if (s.gone(performance.now())) return null;
    const k = 1 / cam.s;
    const nib = loadDeckInk().nib;
    let glow = '';
    const lines: { w: number; d: string }[] = [];
    for (const t of s.traces) { const p = tracePaths(t, nib, cam.s); glow += p.glow; lines.push(...p.runs); }
    const held = s.held, head = held?.pts[held.pts.length - 1];
    return (
      <svg key={key} class={'board-laser' + (s.liftedAt !== null ? ' fade' : '')} style={{ left: 0, top: 0, overflow: 'visible', animationDuration: LASER_FADE_MS + 'ms' }} width={1} height={1} data-laser={mine ? 'mine' : 'peer'}>
        <g fill="none" stroke={color} stroke-linecap="round" stroke-linejoin="round">
          <path d={glow} stroke-opacity={LASER_GLOW_OPACITY} stroke-width={LASER_GLOW_W * k} />
          {lines.map((r, i) => <path key={i} d={r.d} stroke-width={r.w} />)}
        </g>
        {head && <circle cx={head[0]} cy={head[1]} r={8 * k} fill={color} fill-opacity={0.5} />}
        {head && <circle cx={head[0]} cy={head[1]} r={2.2 * k} fill="#fff" fill-opacity={0.9} />}
        {head && name && <text x={head[0] + 12 * k} y={head[1] - 8 * k} font-size={11 * k} fill={color} font-family="sans-serif">{name}</text>}
      </svg>
    );
  };

  return (
    <div class={'board' + (full ? ' full' : '') + (full && barsAway ? ' bars-away' : '')} ref={vpRef} tabIndex={0} data-grid={prefs.boardGrid}
      style={grid ?? { backgroundImage: 'none' }}
      onPointerDown={onPointerDown as never} onPointerMove={onPointerMove as never} onPointerUp={onPointerUp as never} onPointerCancel={onPointerUp as never}
      onLostPointerCapture={onLostCapture as never}
      onPointerLeave={(e: PointerEvent) => { if (e.pointerType === 'mouse' && !dragRef.current) { try { provider.awareness.setLocalStateField('boardCursor', null); } catch { /* closing */ } } }}
      onDblClick={onDblClick as never}
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
                style={{ left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', minHeight: o.h + 'px', background: o.color ?? NOTE_COLORS[0] }}>
                {editing === key ? noteEdit(key, o) : (o.text || <span class="board-note-hint">{coarse ? 'double-tap' : 'double-click'} to write</span>)}
              </div>
            );
          }
          return (
            <svg key={key} data-obj={key} class={'board-stroke' + (selected.has(key) ? ' selected' : '')}
              style={{ left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px', overflow: 'visible', ...(scratchRef.current?.hits.has(key) ? { opacity: 0.3 } : {}) }}
              viewBox={`0 0 ${o.w} ${o.h}`} width={o.w} height={o.h}>
              <BoardStroke stroke={{ color: o.color ?? '#000', w: o.sw ?? 2, pts: o.pts ?? [], nib: o.nib, pressure: o.pressure, o: o.o, poly: o.poly }} runs={objRuns(o)} legacy={strokeD(o)} />
            </svg>
          );
        })}
        {/* in-progress strokes: mine and the other clients' (awareness) */}
        {[...remoteInks, ...(liveRef.current ? [scratchRef.current?.hits.size ? { ...liveRef.current, color: '#8a9099' } : liveRef.current] : [])].map((s, i) => (
          <svg key={'live' + i} class="board-stroke live" style={{ left: 0, top: 0, overflow: 'visible' }} width={1} height={1}>
            <BoardStroke stroke={s} live={i === remoteInks.length ? liveCache.current : undefined} />
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
        {[...remoteLasers.current.entries()].map(([clientId, r]) => laserSvg(r.s, r.color, 'laser' + clientId, false, r.name))}
        {laserSvg(laser, LASER_COLOR, 'mylaser', true)}
        {/* what the others selected, the note one writes in: their colour round it, their name at its corner */}
        {peerBoxes.map(({ p, bb }) => (
          <div key={'psel' + p.clientId} class="board-peer-sel" data-peer-sel={p.clientId}
            style={{ left: bb.x + 'px', top: bb.y + 'px', width: bb.w + 'px', height: bb.h + 'px', '--peer': p.color, outline: `${2 / cam.s}px solid ${p.color}`, outlineOffset: `${3 / cam.s}px` } as never}>
            <span class="board-peer-tag" style={{ transform: `translate(${-3 / cam.s}px, ${-3 / cam.s}px) scale(${1 / cam.s})`, color: inkOn(p.color) }}>{p.edit ? `${firstName(p.name)} is writing` : firstName(p.name)}</span>
          </div>
        ))}
        {prefs.boardPointers && peerList.map(p => p.cursor && (
          <div key={p.clientId} class="board-peer" data-peer-cursor={p.clientId} style={{ left: p.cursor.x + 'px', top: p.cursor.y + 'px' }}>
            <span class="dot" style={{ background: p.color, transform: `scale(${1 / cam.s})` }} />
            <span class="name" style={{ background: p.color, color: inkOn(p.color), transform: `scale(${1 / cam.s})` }}>{p.name}</span>
          </div>
        ))}
      </div>
      {/* the lasso selection's bar (recolour, copy, convert …), and Paste after a tap with the lasso */}
      {selBB && !readOnly && !editing && !dragRef.current && !liveRef.current && <LassoBar id="board-lasso-bar" groups={lassoGroups(lassoActions())} rect={clientBox(selBB)} />}
      {pasteAt && !selBB && heldInk() && <LassoBar id="board-paste-bar" groups={pasteGroups(() => { const clip = heldInk(); const at = pasteAt; setPasteAt(null); if (clip) pasteClip(clip, at); })} rect={clientBox({ x: pasteAt[0], y: pasteAt[1], w: 0, h: 0 })} />}
      <div class="board-tools" ref={toolsRef} onPointerDown={e => e.stopPropagation()}>
        {!readOnly && <button class="small-btn" data-board-undo title="Undo (Ctrl+Z, or tap with two fingers)" aria-label="Undo" disabled={!undo.undoStack.length} onClick={doUndo}>{face('bd-undo', glyph(ICONS.undo, '↶'))}</button>}
        {!readOnly && <button class="small-btn" data-board-redo title="Redo (Ctrl+Shift+Z, or swipe right with three fingers)" aria-label="Redo" disabled={!undo.redoStack.length} onClick={doRedo}>{face('bd-redo', glyph(ICONS.redo, '↷'))}</button>}
        {!readOnly && <span class="board-sep" />}
        {toolBtn('select', '⤢', 'Select / move (drag empty space to pan)')}
        {toolBtn('laser', '🔴', 'Laser pointer — a glowing trace that stays while you hold the pen down and fades when you lift it (put down again before it is gone, it comes back); not saved, seen live by everyone on the board')}
        {!readOnly && toolBtn('note', '🗒', 'Sticky note')}
        {!readOnly && <button class="small-btn" title="Add images (or paste / drag them in)" onClick={pickImages}>{face('bd-image', '🖼')}</button>}
        <button class={'small-btn' + (fingerDraw ? ' active' : '')} data-finger-draw title={fingerDraw ? 'Drawing with a finger is on — a finger draws, two fingers pan and zoom (click to let a finger pan)' : 'Draw with a finger (otherwise only a pen or the mouse draws; a finger pans)'} onClick={() => setFingerDraw(!fingerDraw)}>{face('bd-finger', '☝')}</button>
        <button class={'small-btn' + (settingsOpen ? ' active' : '')} data-board-settings-btn aria-expanded={settingsOpen} aria-label="Board settings"
          title="Board settings: the grid, snapping to it, the others' pointers, drawing with a finger" onClick={() => setSettingsOpen(o => !o)}>{face('bd-settings', '⚙')}</button>
        {!readOnly && <span class="board-sep board-sep-draw" />}
        {!readOnly && <Toolbar id="board-draw" groups={drawingToolbar({
          tool: tool === 'pen' || tool === 'highlighter' ? 'pen' : tool,
          setTool: next => { if (next === 'pen') setTool(boardPen()); else if (next === 'eraser' || next === 'lasso') setTool(next); },
          lasso: { kinds: ['ink', 'shapes', 'pictures', 'text'], textLabel: 'Notes', colors: () => usedColors([...objects.values()].map(o => o.color)) },
          ink: { presets: loadDeckInk(), set: patch => saveDeckInk(patchDeckInk(loadDeckInk(), patch)), draw: on => setTool(on ? boardPen() : 'select') },
          done: false,
          shapes: { tool: isShapeTool(tool) ? tool : null, set: kind => setTool(kind) },
        })} />}
      </div>
      {settingsOpen && <BoardSettings at={settingsAt()} fingerDraw={fingerDraw} onFingerDraw={setFingerDraw} onClose={() => setSettingsOpen(false)} />}
      <div class="board-zoom" onPointerDown={e => e.stopPropagation()}>
        <button class="small-btn" title="Zoom out" onClick={() => zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.25)}>−</button>
        <button class="small-btn" title="Reset zoom" onClick={() => zoomAt(innerWidth / 2, innerHeight / 2, 1 / camRef.current.s)}>{Math.round(cam.s * 100)}%</button>
        <button class="small-btn" title="Zoom in" onClick={() => zoomAt(innerWidth / 2, innerHeight / 2, 1.25)}>+</button>
        <button class="small-btn" title="Zoom to fit everything" onClick={fit}>{face('bd-fit', '⤢')}</button>
        <button class={'small-btn' + (full ? ' active' : '')} data-board-full aria-pressed={full} aria-label={full ? 'Leave full screen' : 'Full screen'}
          title={full ? 'Leave full screen (Esc): the menus, the files and the panes back' : 'Full screen: the board alone on the screen' + (coarse ? ' — a tap with a finger hides the tools and brings them back' : '')}
          onClick={() => setFull(!full)}>{face(full ? 'bd-full-exit' : 'bd-full', glyph(ICONS[full ? 'dk-fullscreen-exit' : 'dk-fullscreen'], full ? '✕' : '⛶'))}</button>
        <span class={'board-conn ' + conn} title={conn === 'online' ? 'Connected — changes sync live and save automatically' : conn === 'offline' ? 'No connection — reconnecting' : 'Connecting…'}>
          {conn === 'online' ? (readOnly ? '👁 view only' : '✓ live') : conn === 'offline' ? 'offline' : '…'}
        </span>
      </div>
      {/* the whole board small, the view on it: bottom left (the zoom pill has the right) */}
      <BoardMinimap objects={objects} cam={cam} view={() => vpRef.current} onCenter={centreAt}
        peers={peerList.flatMap(p => (p.view ? [{ id: p.clientId, color: p.color, view: p.view }] : []))} />
      {/* the others: their faces top right (Go to, Follow), markers at the edges for those out of sight, the follow frame */}
      <BoardPresence peers={peerList} cam={cam} size={vpSize} following={following} faces={!(full && barsAway)} onGo={goTo} onFollow={follow}
        insets={full && barsAway ? { top: 40, right: 44, bottom: 44, left: 44 } : { top: 40 + (toolsRef.current?.offsetHeight ?? 40), right: 48, bottom: 80, left: 48 }} />
      {full && fullHint > 0 && <div key={fullHint} class="board-full-hint">A tap with a finger hides the tools and brings them back</div>}
    </div>
  );
}

/** `runs`: worked out already (objRuns); `live`: the stroke being drawn (strokeRuns) */
function BoardStroke({ stroke, legacy, runs: given, live }: { stroke: LiveStroke; legacy?: string; runs?: { w: number; d: string }[] | null; live?: InkCache }) {
  const runs = given !== undefined ? given : strokeRuns(stroke, live);
  return runs ? <g fill="none" stroke={stroke.color} opacity={stroke.o ?? 1} stroke-linecap="round" stroke-linejoin="round">{runs.map(run => <path d={run.d} stroke-width={run.w} />)}</g>
    : <path d={legacy ?? strokePathD(stroke)} fill={stroke.color} fill-opacity={stroke.o ?? 1} />;
}
