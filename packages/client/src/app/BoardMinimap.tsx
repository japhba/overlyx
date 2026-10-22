/**
 * The whiteboard's minimap (BoardEditor.tsx): the whole board small, in its bottom-left corner (the
 * zoom pill has the right) — strokes as thin lines in their colours, notes in theirs, pictures as
 * grey boxes — over what is drawn and what is in view together, the view an outlined rectangle on it.
 * A press or a drag on it takes the view there; a press inside the rectangle drags the view from where
 * it was taken, without a jump. Hidden on an empty board; its − folds it to a button (remembered per
 * browser, `ol.boardMinimap`).
 *
 * It paints a canvas outside Preact's renders, at most once a frame: the objects again only when they
 * changed or the frame the board is fitted into did (the view went past the drawing); while the camera
 * moves inside the drawing, just the rectangle (a div) moves.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type * as Y from 'yjs';
import type { BoardObj } from './BoardEditor';
import './boardminimap.css';

/** the board's camera (BoardEditor.tsx): a board point (x, y) is at (tx + x·s, ty + y·s) in the view */
export interface MinimapCamera { tx: number; ty: number; s: number }
interface Box { x0: number; y0: number; x1: number; y1: number }
/** how the board maps onto the card: a board point (x, y) is at (ox + (x − x0)·k, oy + (y − y0)·k) */
interface Frame { x0: number; y0: number; k: number; ox: number; oy: number }

const STORE = 'ol.boardMinimap';
const MAX_W = 180, MAX_H = 120;
const NOTE_COLOR = '#fff3bf';

function storedOpen(): boolean {
  try { return localStorage.getItem(STORE) !== '0'; } catch { return true; }
}

/** what is drawn: the box round every object; null on an empty board */
function contentBox(objects: Y.Map<BoardObj>): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  objects.forEach(o => { x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + o.h); });
  return x0 > x1 ? null : { x0, y0, x1, y1 };
}

/** the card for a frame of this shape: at most 180 × 120, its aspect kept between 0.6 and 3 (a long thin board stays a card) */
function cardSize(b: Box): [number, number] {
  const a = Math.min(3, Math.max(0.6, (b.x1 - b.x0) / Math.max(1, b.y1 - b.y0)));
  return a >= MAX_W / MAX_H ? [MAX_W, Math.round(MAX_W / a)] : [Math.round(MAX_H * a), MAX_H];
}

/** a dark ink (black, graphite, navy): on the dark theme's card it would not show */
function darkInk(color: string): boolean {
  let hex = /^#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(color)?.[1];
  if (!hex) return false;
  if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex!.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.3;
}

export function BoardMinimap({ objects, cam, view, onCenter }: {
  objects: Y.Map<BoardObj>;
  cam: MinimapCamera;
  /** the board's viewport (the view is its size) */
  view: () => HTMLElement | null;
  /** move the camera so that the board point (x, y) is in the middle of the view */
  onCenter: (x: number, y: number) => void;
}) {
  const [open, setOpen] = useState(storedOpen);
  const [empty, setEmpty] = useState(() => objects.size === 0);
  const [size, setSize] = useState<[number, number]>([MAX_W, MAX_H]);
  const cardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rectRef = useRef<HTMLDivElement>(null);
  const camRef = useRef(cam); camRef.current = cam;
  const sizeRef = useRef(size); sizeRef.current = size;
  /** what is drawn, and whether the canvas still shows it as it is */
  const content = useRef<Box | null>(null);
  const dirty = useRef(true);
  /** the frame last painted; a drag on the card keeps it (the frame follows the view, which the drag moves: the map would slide under the pointer) */
  const painted = useRef<Frame | null>(null);
  const drag = useRef<{ id: number; frame: Frame; dx: number; dy: number } | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raf = useRef(0);

  /** what is in view, in board coordinates */
  const viewBox = (): Box | null => {
    const vp = view(), c = camRef.current;
    return vp ? { x0: -c.tx / c.s, y0: -c.ty / c.s, x1: (vp.clientWidth - c.tx) / c.s, y1: (vp.clientHeight - c.ty) / c.s } : null;
  };

  const drawObjects = (canvas: HTMLCanvasElement, f: Frame, W: number, H: number) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = canvas.width / W;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // (the board itself shows ink as it is; small on a dark card, black ink would just be gone)
    const fg = document.documentElement.dataset.theme === 'dark' ? getComputedStyle(canvas).color : null;
    const list = [...objects.values()].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    for (const o of list) {
      const x = f.ox + (o.x - f.x0) * f.k, y = f.oy + (o.y - f.y0) * f.k, w = o.w * f.k, h = o.h * f.k;
      if (o.t !== 'stroke') {
        ctx.globalAlpha = 1;
        ctx.fillStyle = o.t === 'note' ? o.color ?? NOTE_COLOR : 'rgba(128, 128, 128, 0.5)';
        ctx.fillRect(x, y, Math.max(2, w), Math.max(2, h));
        // (a pale note on the pale card: an edge so it shows)
        if (o.t === 'note' && w >= 3 && h >= 3) { ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)'; ctx.lineWidth = 0.75; ctx.strokeRect(x, y, w, h); }
        continue;
      }
      const pts = o.pts ?? [];
      const color = o.color ?? '#000';
      ctx.strokeStyle = fg && darkInk(color) ? fg : color;
      ctx.globalAlpha = o.o ?? 1;
      ctx.lineWidth = Math.min(4, Math.max(0.8, (o.sw ?? 2) * f.k));
      ctx.beginPath();
      if (pts.length < 2 || (w < 1.5 && h < 1.5)) {
        // a dot (a zero-length line draws nothing in some browsers)
        ctx.moveTo(x + w / 2, y + h / 2);
        ctx.lineTo(x + w / 2 + 0.01, y + h / 2);
      } else {
        // a point a pixel or more from the last one drawn: a long stroke costs what it shows
        let lx = x + pts[0][0] * f.k, ly = y + pts[0][1] * f.k;
        ctx.moveTo(lx, ly);
        for (let i = 1; i < pts.length; i++) {
          const px = x + pts[i][0] * f.k, py = y + pts[i][1] * f.k;
          if (i < pts.length - 1 && (px - lx) ** 2 + (py - ly) ** 2 < 1) continue;
          ctx.lineTo(px, py);
          lx = px; ly = py;
        }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  const paint = () => {
    const canvas = canvasRef.current, rect = rectRef.current, box = content.current, vb = viewBox();
    if (!canvas || !rect || !box || !vb) return;
    const [W, H] = sizeRef.current;
    // the frame: what is drawn and what is in view together, with a margin
    const u = { x0: Math.min(box.x0, vb.x0), y0: Math.min(box.y0, vb.y0), x1: Math.max(box.x1, vb.x1), y1: Math.max(box.y1, vb.y1) };
    const pad = 0.05 * Math.max(u.x1 - u.x0, u.y1 - u.y0, 1);
    u.x0 -= pad; u.y0 -= pad; u.x1 += pad; u.y1 += pad;
    // the card takes the frame's shape once the camera rests (while it moves, the card would twitch)
    const want = cardSize(u);
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = !drag.current && (Math.abs(want[0] - W) > 6 || Math.abs(want[1] - H) > 6)
      ? setTimeout(() => { resizeTimer.current = null; setSize(want); }, 300) : null;
    let f = drag.current?.frame;
    if (!f) {
      const k = Math.min(W / (u.x1 - u.x0), H / (u.y1 - u.y0));
      f = { x0: u.x0, y0: u.y0, k, ox: (W - (u.x1 - u.x0) * k) / 2, oy: (H - (u.y1 - u.y0) * k) / 2 };
    }
    const p = painted.current;
    if (dirty.current || !p || p.x0 !== f.x0 || p.y0 !== f.y0 || p.k !== f.k || p.ox !== f.ox || p.oy !== f.oy) {
      drawObjects(canvas, f, W, H);
      dirty.current = false;
      painted.current = f;
    }
    const st = rect.style;
    st.left = `${f.ox + (vb.x0 - f.x0) * f.k}px`;
    st.top = `${f.oy + (vb.y0 - f.y0) * f.k}px`;
    st.width = `${Math.max(4, (vb.x1 - vb.x0) * f.k)}px`;
    st.height = `${Math.max(4, (vb.y1 - vb.y0) * f.k)}px`;
  };
  const paintRef = useRef(paint); paintRef.current = paint;
  const schedule = () => {
    if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; paintRef.current(); });
  };

  // the objects: the box round them, and the canvas again
  useEffect(() => {
    const changed = () => { content.current = contentBox(objects); dirty.current = true; setEmpty(!content.current); schedule(); };
    changed();
    objects.observe(changed);
    return () => objects.unobserve(changed);
  }, [objects]);
  // the camera (the board renders on every move of it) and the board's own size
  useEffect(schedule, [cam.tx, cam.ty, cam.s]);
  useEffect(() => {
    const vp = view();
    const ro = vp && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (vp) ro?.observe(vp);
    // the theme switched: dark ink is drawn otherwise
    const mo = new MutationObserver(() => { dirty.current = true; schedule(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      ro?.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
    };
  }, []);
  // a new canvas (unfolded, the first object drawn) or a new size: its pixels for the screen's, painted at once
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(size[0] * dpr);
    canvas.height = Math.round(size[1] * dpr);
    dirty.current = true;
    paintRef.current();
  }, [open, empty, size[0], size[1]]);

  const toggle = (on: boolean) => {
    setOpen(on);
    try { localStorage.setItem(STORE, on ? '1' : '0'); } catch { /* the choice just is not remembered */ }
  };

  /** the board point under the pointer by the frame `f` (kept to the card: a drag past its edge stops there) */
  const boardAt = (e: PointerEvent, f: Frame): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    const mx = Math.max(0, Math.min(r.width, e.clientX - r.left)), my = Math.max(0, Math.min(r.height, e.clientY - r.top));
    return [f.x0 + (mx - f.ox) / f.k, f.y0 + (my - f.oy) / f.k];
  };
  // every pointer event stops here: the board would draw, pan or select under the card, and say a cursor there
  const onDown = (e: PointerEvent) => {
    e.stopPropagation();
    if ((e.target as Element).closest('button') || e.button > 0) return;
    const f = painted.current, vb = viewBox();
    if (!f || !vb) return;
    e.preventDefault();
    const [bx, by] = boardAt(e, f);
    const inside = bx >= vb.x0 && bx <= vb.x1 && by >= vb.y0 && by <= vb.y1;
    drag.current = { id: e.pointerId, frame: f, dx: inside ? (vb.x0 + vb.x1) / 2 - bx : 0, dy: inside ? (vb.y0 + vb.y1) / 2 - by : 0 };
    cardRef.current!.setPointerCapture(e.pointerId);
    cardRef.current!.classList.add('dragging');
    if (!inside) onCenter(bx, by);
  };
  const onMove = (e: PointerEvent) => {
    e.stopPropagation();
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const [bx, by] = boardAt(e, d.frame);
    onCenter(bx + d.dx, by + d.dy);
  };
  const onUp = (e: PointerEvent) => {
    e.stopPropagation();
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    cardRef.current?.classList.remove('dragging');
    // the frame fits the view where it is now
    schedule();
  };

  if (empty) return null;
  if (!open) {
    return (
      <button type="button" class="board-minimap-open" data-board-minimap="folded" title="Show the minimap" aria-label="Show the minimap"
        onPointerDown={e => e.stopPropagation()} onClick={() => toggle(true)}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
          <rect x="1.5" y="3" width="13" height="10" rx="1.5" /><rect x="4" y="5.5" width="5" height="4" rx="0.5" />
        </svg>
      </button>
    );
  }
  return (
    <div class="board-minimap" ref={cardRef} data-board-minimap="open" style={{ width: `${size[0]}px`, height: `${size[1]}px` }}
      aria-label="Minimap of the board — press or drag to move the view"
      onPointerDown={onDown as never} onPointerMove={onMove as never} onPointerUp={onUp as never} onPointerCancel={onUp as never} onLostPointerCapture={onUp as never}>
      <canvas ref={canvasRef} />
      <div class="board-minimap-view" ref={rectRef} />
      <button type="button" class="board-minimap-fold" title="Fold the minimap away" aria-label="Fold the minimap away" onClick={() => toggle(false)}>
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 5h6" /></svg>
      </button>
    </div>
  );
}
