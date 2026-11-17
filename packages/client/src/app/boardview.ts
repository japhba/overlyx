/**
 * The whiteboard's view, apart from its objects (app/BoardEditor.tsx): the grid drawn behind the
 * board for the camera, snapping to it, the others on the board as their awareness states say
 * (their pointer, their view, what they selected, the note they write in), the camera that shows
 * one of them, and the marker at the view's edge for someone out of sight. Pure functions, tested
 * in tests/boardview.test.ts.
 *
 * The camera: a board point (x, y) is at (tx + x·s, ty + y·s) in the view.
 */

export interface Camera { tx: number; ty: number; s: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const MIN_ZOOM = 0.08, MAX_ZOOM = 4;
export const clampZoom = (s: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));

/* ------------------------------------------------------------- the grid */

/** what is drawn behind the board (Settings ▸ the board's ⚙): dots, squared paper, ruled lines or nothing */
export type BoardGrid = 'none' | 'dots' | 'squares' | 'lines';
export const BOARD_GRIDS: readonly BoardGrid[] = ['none', 'dots', 'squares', 'lines'];
/** a cell's size in board units: the slider's range and its named rungs */
export const GRID_MIN = 8, GRID_MAX = 128;
export const GRID_RUNGS = [{ v: 16, label: 'Fine' }, { v: 32, label: 'Medium' }, { v: 64, label: 'Coarse' }];
/** the smallest a cell is drawn on the screen (px): zoomed out further, only every 2nd (squares: 4th) line or dot is */
export const MIN_CELL_PX = 10;
/** squared paper: a stronger line every this many cells */
export const MAJOR_EVERY = 4;

const mod = (a: number, n: number): number => ((a % n) + n) % n;
const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

/** the size a cell of `size` board units is drawn at with zoom `s` (px), coarser steps while it would be under MIN_CELL_PX */
export function shownCell(grid: BoardGrid, size: number, s: number): number {
  let cell = size * s;
  const k = grid === 'squares' ? MAJOR_EVERY : 2;
  for (let i = 0; cell < MIN_CELL_PX && i < 40; i++) cell *= k;
  return cell;
}

/**
 * The grid as CSS backgrounds of the board's element for the camera: it moves and scales with the
 * board (a fixed pattern behind a moving board looked like a window, not paper). Colours from the
 * board's custom properties (board.css), so the theme decides them. null: no grid.
 */
export function gridStyle(grid: BoardGrid, size: number, cam: Camera): { backgroundImage: string; backgroundSize: string; backgroundPosition: string } | null {
  if (grid === 'none' || !(size > 0) || !(cam.s > 0)) return null;
  const cell = shownCell(grid, size, cam.s);
  const ox = mod(cam.tx, cell), oy = mod(cam.ty, cell);
  if (grid === 'dots') {
    const r = cell >= 28 ? 1.4 : 1.1;
    return {
      backgroundImage: `radial-gradient(circle at ${r}px ${r}px, var(--board-grid-dot) ${r}px, transparent ${r + 0.7}px)`,
      backgroundSize: `${px(cell)} ${px(cell)}`,
      backgroundPosition: `${px(ox - r)} ${px(oy - r)}`,
    };
  }
  const line = (dir: 'right' | 'bottom', c: string) => `linear-gradient(to ${dir}, ${c} 1px, transparent 1px)`;
  if (grid === 'lines') {
    return { backgroundImage: line('bottom', 'var(--board-grid)'), backgroundSize: `100% ${px(cell)}`, backgroundPosition: `0 ${px(oy)}` };
  }
  const major = cell * MAJOR_EVERY, mx = mod(cam.tx, major), my = mod(cam.ty, major);
  return {
    backgroundImage: [line('right', 'var(--board-grid-major)'), line('bottom', 'var(--board-grid-major)'), line('right', 'var(--board-grid)'), line('bottom', 'var(--board-grid)')].join(', '),
    backgroundSize: `${px(major)} ${px(major)}, ${px(major)} ${px(major)}, ${px(cell)} ${px(cell)}, ${px(cell)} ${px(cell)}`,
    backgroundPosition: `${px(mx)} ${px(my)}, ${px(mx)} ${px(my)}, ${px(ox)} ${px(oy)}, ${px(ox)} ${px(oy)}`,
  };
}

/** `v` on the grid of `step` board units */
export const snapTo = (v: number, step: number): number => (step > 0 ? Math.round(v / step) * step : v);

/* ------------------------------------------------------------- the camera */

/** what a W × H view shows, in board coordinates */
export const viewRect = (cam: Camera, W: number, H: number): Rect => ({ x: -cam.tx / cam.s, y: -cam.ty / cam.s, w: W / cam.s, h: H / cam.s });

/** the camera with the board point (x, y) in the middle of a W × H view at zoom s */
export const camCentredOn = (x: number, y: number, s: number, W: number, H: number): Camera => ({ s, tx: W / 2 - x * s, ty: H / 2 - y * s });

/** the camera that shows `r` whole in the middle of a W × H view, `pad` px round it */
export function camForRect(r: Rect, W: number, H: number, pad = 0): Camera {
  const s = clampZoom(Math.min((W - 2 * pad) / Math.max(1, r.w), (H - 2 * pad) / Math.max(1, r.h)));
  return camCentredOn(r.x + r.w / 2, r.y + r.h / 2, s, W, H);
}

/**
 * The camera `t` (0…1) of the way from `a` to `b` in a W × H view: the middle of the view goes the
 * straight way, the zoom evenly in its ratio (a fly over the board, not a lurch).
 */
export function lerpCam(a: Camera, b: Camera, t: number, W: number, H: number): Camera {
  const ca = [(W / 2 - a.tx) / a.s, (H / 2 - a.ty) / a.s], cb = [(W / 2 - b.tx) / b.s, (H / 2 - b.ty) / b.s];
  const s = Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * t);
  return camCentredOn(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, s, W, H);
}
/** ease in and out */
export const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/* ------------------------------------------------------------- the others */

/** another person on the board, from their awareness state */
export interface BoardPeer {
  clientId: number;
  name: string;
  color: string;
  avatar?: string | null;
  username?: string;
  /** their pointer on the board (none: it left the board, or they never pointed) */
  cursor: { x: number; y: number } | null;
  /** what their screen shows of the board */
  view: Rect | null;
  /** the objects they selected */
  sel: string[];
  /** the sticky note they are writing in */
  edit: string | null;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** a person from their awareness state, the fields checked (another client's message: anything may be in it); null without a user */
export function readPeer(clientId: number, state: unknown): BoardPeer | null {
  const s = (state && typeof state === 'object' ? state : {}) as Record<string, unknown>;
  const u = s.user as { name?: unknown; color?: unknown; avatar?: unknown; username?: unknown } | undefined;
  if (!u || typeof u.name !== 'string') return null;
  const c = s.boardCursor as { x?: unknown; y?: unknown } | null | undefined;
  const v = s.boardView as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null | undefined;
  const sel = Array.isArray(s.boardSel) ? (s.boardSel as unknown[]).filter((k): k is string => typeof k === 'string').slice(0, 2000) : [];
  return {
    clientId,
    name: u.name.slice(0, 80) || 'Someone',
    color: typeof u.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(u.color) ? u.color : '#6b7280',
    avatar: typeof u.avatar === 'string' ? u.avatar : null,
    username: typeof u.username === 'string' ? u.username : undefined,
    cursor: c && num(c.x) && num(c.y) ? { x: c.x, y: c.y } : null,
    view: v && num(v.x) && num(v.y) && num(v.w) && num(v.h) && v.w > 0 && v.h > 0 ? { x: v.x, y: v.y, w: v.w, h: v.h } : null,
    sel,
    edit: typeof s.boardEdit === 'string' ? s.boardEdit : null,
  };
}

const inside = (p: { x: number; y: number }, r: Rect): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** where a person is: their pointer, else the middle of what they see; null when neither is known */
export function peerSpot(p: Pick<BoardPeer, 'cursor' | 'view'>): { x: number; y: number } | null {
  if (p.cursor) return p.cursor;
  return p.view ? { x: p.view.x + p.view.w / 2, y: p.view.y + p.view.h / 2 } : null;
}

/**
 * The camera that goes to a person in a W × H view: what they see, fitted into this view (their
 * pointer in it); their pointer outside it or no view known, their pointer in the middle at the zoom
 * `s` as it is. null when nothing says where they are.
 */
export function camForPeer(p: Pick<BoardPeer, 'cursor' | 'view'>, s: number, W: number, H: number): Camera | null {
  if (p.view && (!p.cursor || inside(p.cursor, p.view))) return camForRect(p.view, W, H);
  return p.cursor ? camCentredOn(p.cursor.x, p.cursor.y, s, W, H) : null;
}

export interface Insets { top: number; right: number; bottom: number; left: number }

/**
 * The marker for a point (x, y) of the view (W × H px) that lies outside it: where the line from the
 * middle of the view's inner part (the view less `m`: clear of its bars) towards the point leaves
 * that part, and the direction it points (radians, 0 = right). null while the point is in view.
 */
export function edgeSpot(x: number, y: number, W: number, H: number, m: Insets): { x: number; y: number; angle: number } | null {
  if (x >= 0 && x <= W && y >= 0 && y <= H) return null;
  const x0 = Math.min(m.left, W / 2), x1 = Math.max(W - m.right, W / 2), y0 = Math.min(m.top, H / 2), y1 = Math.max(H - m.bottom, H / 2);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, dx = x - cx, dy = y - cy;
  const hw = Math.max(1, (x1 - x0) / 2), hh = Math.max(1, (y1 - y0) / 2);
  const k = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: cx + dx * k, y: cy + dy * k, angle: Math.atan2(dy, dx) };
}
