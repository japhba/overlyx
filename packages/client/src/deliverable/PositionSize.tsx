/**
 * Position and size (PowerPoint's Size and Position, Google Slides' Format options ▸ Size & rotation):
 * X, Y, width, height and rotation of the selection, typed — from the contextual toolbar's Arrange
 * section, the Arrange menu and an object's right-click menu. Lengths in the document's unit (units.ts:
 * mm, inches in the US), from the slide's top left corner; for one object its own box before it is
 * turned, for several the box round them (moved and spread as one). Enter or leaving a field places
 * it, ↑ / ↓ step (Shift: ten times, Alt: a tenth) — each a move as a drag makes it, one undo step
 * (runtime place.ts). Keep proportions: a width typed brings the height with it, and the other way.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Rect, SelItem } from './protocol';
import type { PlaceTo } from './runtime/place';
import { lengthUnit } from './units';
import './positionsize.css';

interface Props {
  sel: SelItem[];
  place(to: PlaceTo): void;
}

type Field = 'x' | 'y' | 'w' | 'h' | 'r';

const PER_PX = { mm: 25.4 / 96, in: 1 / 96 } as const;

function union(rs: Rect[]): Rect {
  const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
  return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y };
}

let lockKept: boolean | null = null;

export function PositionSize({ sel, place }: Props) {
  const unit = lengthUnit(), per = PER_PX[unit];
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({});
  const [lock, setLockState] = useState<boolean>(() => lockKept ?? (sel.length > 0 && sel.every(s => s.kind === 'image' || s.kind === 'svg')));
  const setLock = (on: boolean) => { lockKept = on; setLockState(on); };
  // (another selection: nothing typed carries over)
  const which = sel.map(s => s.path.join('.')).join('|');
  useEffect(() => setDraft({}), [which]);
  const boxes = sel.map(s => s.box).filter((b): b is Rect => !!b);
  if (!boxes.length) return <div class="dl-pos" data-dl-position><p class="dialog-hint">Select an object on a {sel.length ? 'slide' : 'slide or poster'} to see and type its position and size.</p></div>;
  const u = union(boxes);
  const locked = sel.every(s => s.locked);
  const angles = sel.map(s => s.style.rotate || 0);
  const angle = angles.every(a => Math.abs(a - angles[0]) < 0.05) ? angles[0] : null;
  const shown = (px: number) => String(unit === 'mm' ? Math.round(px * per * 10) / 10 : Math.round(px * per * 100) / 100);
  const now: Record<Field, string> = { x: shown(u.x), y: shown(u.y), w: shown(u.w), h: shown(u.h), r: angle === null ? '' : String(Math.round(angle * 10) / 10) };
  const value = (f: Field) => draft[f] ?? now[f];

  /** a field's value placed (px from the unit; the rotation in degrees) */
  const commit = (f: Field, text: string) => {
    setDraft(d => { const n = { ...d }; delete n[f]; return n; });
    const n = Number(text.replace(',', '.').trim());
    if (!text.trim() || !Number.isFinite(n) || text.trim() === now[f]) return;
    if (f === 'r') { place({ rotate: n }); return; }
    const px = n / per;
    if (f === 'x') place({ x: px });
    else if (f === 'y') place({ y: px });
    else if (f === 'w') { const w = Math.max(1, px); place(lock && u.w > 0 ? { w, h: w * u.h / u.w } : { w }); }
    else { const h = Math.max(1, px); place(lock && u.h > 0 ? { h, w: h * u.w / u.h } : { h }); }
  };
  const key = (f: Field) => (e: KeyboardEvent) => {
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === 'Enter') { e.preventDefault(); commit(f, input.value); return; }
    if (e.key === 'Escape') { setDraft(d => { const n = { ...d }; delete n[f]; return n; }); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const base = f === 'r' ? (e.shiftKey ? 15 : e.altKey ? 0.1 : 1) : (unit === 'mm' ? 1 : 0.1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    const cur = Number((input.value || '0').replace(',', '.')) || 0;
    const next = String(Math.round((f === 'w' || f === 'h' ? Math.max(base, cur + (e.key === 'ArrowUp' ? base : -base)) : cur + (e.key === 'ArrowUp' ? base : -base)) * 1000) / 1000);
    commit(f, next);
    // (shown at once: a key held steps on from it before the selection comes back)
    setDraft(d => ({ ...d, [f]: next }));
  };
  const field = (f: Field, label: string, title: string, suffix: string) => <label class="dl-pos-field" title={title}>
    <span>{label}</span>
    <input type="text" inputMode="decimal" value={value(f)} disabled={locked} data-pos={f} aria-label={title}
      onInput={e => { const v = (e.target as HTMLInputElement).value; setDraft(d => ({ ...d, [f]: v })); }}
      onKeyDown={key(f)} onBlur={e => { if (draft[f] !== undefined) commit(f, (e.target as HTMLInputElement).value); }} />
    <small>{suffix}</small>
  </label>;

  return <div class="dl-pos" data-dl-position>
    <p class="dialog-hint">{sel.length > 1 ? `${sel.length} objects — the box round them. ` : ''}From the {sel.some(s => s.slide >= 0) ? 'slide' : 'page'}’s top left corner{locked ? ' — locked: unlock it to move it' : ''}.</p>
    <div class="dl-pos-grid">
      <span class="dl-pos-row">Position</span>
      {field('x', 'X', 'Distance from the left edge', unit)}
      {field('y', 'Y', 'Distance from the top edge', unit)}
      <span class="dl-pos-row">Size</span>
      {field('w', 'W', 'Width', unit)}
      {field('h', 'H', 'Height', unit)}
      <span class="dl-pos-row">Rotation</span>
      {field('r', '↻', 'Rotation, degrees clockwise', '°')}
      <label class="dl-pos-lock" title="A width typed brings the height with it, and the other way">
        <input type="checkbox" checked={lock} disabled={locked} data-pos-lock onChange={e => setLock((e.target as HTMLInputElement).checked)} /> Keep proportions
      </label>
    </div>
    <p class="dialog-hint dl-pos-keys">Enter places it · ↑ ↓ step {unit === 'mm' ? '1 mm' : '0.1 in'} (Shift ×10, Alt ÷10) · each change one undo step</p>
  </div>;
}
