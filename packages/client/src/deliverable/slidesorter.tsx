/**
 * The slide sorter: all of a deck's slides in a grid over the editor (View ▸ Slide sorter, or the
 * button above the slide list), to see the whole talk and reorder it by dragging. It is the slide
 * list itself — the rail's frame laid out as a grid (runtime `railGrid`) — so the selection, keys and
 * menu are the rail's (slideselection.ts); a double-click or Enter opens the slide, Esc goes back.
 * This file: its bar (how big the slides are, Done) and the size remembered.
 */
import './slidesorter.css';

/** how wide a slide of the sorter is (screen px): the slider's labelled rungs */
export const SORTER_RUNGS: { w: number; label: string }[] = [{ w: 140, label: 'Small' }, { w: 220, label: 'Medium' }, { w: 320, label: 'Large' }];
const MIN = 100, MAX = 420, KEY = 'ol.sorterThumb';

export function loadSorterThumb(): number {
  try { const v = Number(localStorage.getItem(KEY)); if (v >= MIN && v <= MAX) return v; } catch { /* private window */ }
  return SORTER_RUNGS[1].w;
}
function saveSorterThumb(w: number): void { try { localStorage.setItem(KEY, String(w)); } catch { /* private window */ } }
/** near a rung: on it */
const snap = (w: number) => { for (const r of SORTER_RUNGS) if (Math.abs(r.w - w) <= 12) return r.w; return w; };

export function SorterBar({ count, selected, thumb, setThumb, done }: { count: number; selected: number; thumb: number; setThumb: (w: number) => void; done: () => void }) {
  const set = (v: number, keep: boolean) => { const w = snap(v); setThumb(w); if (keep) saveSorterThumb(w); };
  return (
    <div class="dl-sorter-bar" data-dl-sorter-bar>
      <span class="dl-sorter-title">Slide sorter</span>
      <span class="dl-sorter-count" title="Shift+click or Ctrl+click selects several; drag them to reorder. Double-click or Enter opens a slide.">
        {selected > 1 ? `${selected} of ${count} slides selected` : `${count} slide${count === 1 ? '' : 's'}`}
      </span>
      <span class="dl-sorter-size">
        <input type="range" min={MIN} max={MAX} step={1} value={thumb} list="dl-sorter-rungs" aria-label="Size of the slides" aria-valuetext={SORTER_RUNGS.find(r => r.w === thumb)?.label ?? `${thumb} px`}
          onInput={e => set(Number((e.target as HTMLInputElement).value), false)} onChange={e => set(Number((e.target as HTMLInputElement).value), true)} />
        <datalist id="dl-sorter-rungs">{SORTER_RUNGS.map(r => <option key={r.w} value={r.w} label={r.label} />)}</datalist>
        <span class="dl-sorter-rungs" aria-hidden="true">
          {SORTER_RUNGS.map(r => <button type="button" key={r.w} class={r.w === thumb ? 'on' : ''} style={{ left: `${((r.w - MIN) / (MAX - MIN)) * 100}%` }} onClick={() => set(r.w, true)}>{r.label}</button>)}
        </span>
      </span>
      <button type="button" class="dl-btn dl-sorter-done" data-dl-sorter-done title="Back to the slide shown (Esc; a double-click or Enter opens the selected slide)" onClick={done}>Done</button>
    </div>
  );
}
/** the sorter's bar above the grid (screen px; the rail's is RAIL_HEAD) */
export const SORTER_HEAD = 40;
