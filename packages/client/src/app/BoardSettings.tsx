/**
 * The whiteboard's settings (the ⚙ at the end of its tool bar, app/BoardEditor.tsx): the grid behind
 * the board and the size of its cells, snapping to it, the others' pointers, drawing with a finger.
 * They are the person's own (prefs.ts, following the account to every device; drawing with a finger
 * is the pens' setting, deckink.ts) — everyone sees a board the way they set it.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { getUserPrefs, setPref, subscribePrefs } from '../prefs';
import { BOARD_GRIDS, GRID_MIN, GRID_MAX, GRID_RUNGS, type BoardGrid } from './boardview';

const GRID_NAMES: Record<BoardGrid, string> = { none: 'None', dots: 'Dots', squares: 'Squares', lines: 'Lines' };
const GRID_TITLES: Record<BoardGrid, string> = {
  none: 'A plain board', dots: 'Dots where the grid lines cross', squares: 'Squared paper, a stronger line every fourth', lines: 'Ruled lines, as in a notebook',
};
/** a small picture of each grid */
const GRID_ICONS: Record<BoardGrid, string> = {
  none: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/>',
  dots: '<g fill="currentColor" stroke="none"><circle cx="5" cy="5" r="1"/><circle cx="11" cy="5" r="1"/><circle cx="5" cy="11" r="1"/><circle cx="11" cy="11" r="1"/></g>',
  squares: '<path d="M2.5 5.5h11M2.5 10.5h11M5.5 2.5v11M10.5 2.5v11"/>',
  lines: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
};

/** a rung at `p` % of the slider: its tick exactly there, its name centred on it — at the ends reaching inwards (TextStyles' Slider) */
const rungStyle = (p: number) => ({ left: `${p}%`, ...(p < 8 ? { transform: 'none', alignItems: 'flex-start' } : p > 92 ? { transform: 'translateX(-100%)', alignItems: 'flex-end' } : {}) });

/**
 * The cell's size: a continuous slider whose knob snaps to its named rungs. It runs in the ratio of the
 * size (each step doubling it is as long as the next), so Fine, Medium and Coarse are evenly apart.
 */
function GridSize({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled: boolean }) {
  const lo = Math.log2(GRID_MIN), hi = Math.log2(GRID_MAX);
  const pct = (v: number) => ((Math.log2(Math.min(GRID_MAX, Math.max(GRID_MIN, v))) - lo) / (hi - lo)) * 100;
  const fromPos = (x: number) => {
    const r = GRID_RUNGS.find(g => Math.abs(Math.log2(g.v) - x) <= 0.12);
    return r ? r.v : Math.round(2 ** x);
  };
  return (
    <div class={'ts-slider board-set-size' + (disabled ? ' off' : '')}>
      <div class="ts-slider-val">Cells of {value} px at 100 %</div>
      <input type="range" min={lo} max={hi} step={0.01} value={Math.log2(Math.min(GRID_MAX, Math.max(GRID_MIN, value)))} aria-label="Grid size" data-board-grid-size
        onInput={e => onChange(fromPos(Number((e.target as HTMLInputElement).value)))} onKeyDown={e => e.stopPropagation()} />
      <div class="ff-rungs">
        {GRID_RUNGS.map(r => (
          <button key={r.v} type="button" class={'ff-rung' + (r.v === value ? ' on' : '')} style={rungStyle(pct(r.v))} title={`${r.label} (${r.v} px at 100 %)`}
            onClick={() => onChange(r.v)}><span>{r.label}</span></button>
        ))}
      </div>
    </div>
  );
}

/** `at`: where it opens in the board (px: under its button, inside the board) */
export function BoardSettings({ at, fingerDraw, onFingerDraw, onClose }: { at: { left: number; top: number }; fingerDraw: boolean; onFingerDraw: (on: boolean) => void; onClose: () => void }) {
  const [p, setP] = useState(getUserPrefs());
  useEffect(() => subscribePrefs(() => setP(getUserPrefs())), []);
  const ref = useRef<HTMLDivElement>(null);
  // a press anywhere else, or Esc, closes it (its own button toggles it)
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!ref.current?.contains(t) && !t?.closest?.('[data-board-settings-btn]')) onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc, true); };
  }, []);
  const check = (label: string, hint: string, on: boolean, set: (v: boolean) => void, attr: string) => (
    <label class="board-set-check" {...{ [attr]: '' }}>
      <input type="checkbox" checked={on} onChange={e => set((e.currentTarget as HTMLInputElement).checked)} />
      <span>{label}<small>{hint}</small></span>
    </label>
  );
  return (
    <div class="board-settings" ref={ref} data-board-settings role="dialog" aria-label="Whiteboard settings" style={{ left: `${at.left}px`, top: `${at.top}px` }} onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
      <div class="board-set-head">Grid</div>
      <div class="board-seg" role="radiogroup" aria-label="Grid">
        {BOARD_GRIDS.map(g => (
          <button key={g} type="button" role="radio" aria-checked={p.boardGrid === g} class={'board-seg-btn' + (p.boardGrid === g ? ' on' : '')} data-board-grid={g}
            title={GRID_TITLES[g]} onClick={() => setPref('boardGrid', g)}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: GRID_ICONS[g] }} />
            <span>{GRID_NAMES[g]}</span>
          </button>
        ))}
      </div>
      <GridSize value={p.boardGridSize} disabled={p.boardGrid === 'none' && !p.boardSnap} onChange={v => setPref('boardGridSize', v)} />
      {check('Snap to the grid', 'New notes and pictures, and what you move, line up with it', p.boardSnap, v => setPref('boardSnap', v), 'data-board-snap')}
      <div class="board-set-head">Working together</div>
      {check('Show the others’ pointers', 'Their names follow their pens and mice on the board', p.boardPointers, v => setPref('boardPointers', v), 'data-board-pointers')}
      {check('Draw with a finger', 'One finger draws; two fingers pan and zoom', fingerDraw, onFingerDraw, 'data-board-finger')}
      <p class="board-set-note">Your own settings: everyone sees the board as they set it.</p>
    </div>
  );
}
