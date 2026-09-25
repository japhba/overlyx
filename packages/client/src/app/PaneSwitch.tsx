/**
 * The pane control in the menu bar (web client): WYSIWYG · TeX · PDF, left to right in the order
 * the panes stand. A click shows or hides a pane (the last one stays), a double-click shows it
 * alone, dragging a chip sideways moves its pane; ▾ opens every arrangement as a small picture,
 * and mirror / equal widths. On a phone-width screen one pane at a time: a click shows that one.
 * The layout logic is app/panes.ts.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { PANE_LABELS, PANE_TITLES, PRESETS, applyPreset, mirrorPanes, movePane, presetMatches, resetWidths, soloPane, togglePane, visiblePanes, type PaneId, type PaneLayout, type Preset } from './panes';

const MINI: Record<PaneId, string> = { doc: 'Doc', tex: 'TeX', pdf: 'PDF' };

export function PaneSwitch({ layout, onChange, narrow = false }: { layout: PaneLayout; onChange: (l: PaneLayout) => void; narrow?: boolean }) {
  const row = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: PaneId; dx: number; to: number; w: number } | null>(null);
  const suppressClick = useRef(false);
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); };
  }, [menu]);

  const onPointerDown = (id: PaneId, e: PointerEvent) => {
    if (e.button !== 0 || narrow) return;
    const chip = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const chips = Array.from(row.current?.querySelectorAll<HTMLElement>('[data-pane-chip]') ?? []);
    const w = chip.getBoundingClientRect().width + 2;   // the chip and the gap: what the others move by to make room
    const centers = chips.map(c => { const r = c.getBoundingClientRect(); return { id: c.dataset.paneChip as PaneId, mid: r.left + r.width / 2 }; });
    let moving = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moving && Math.abs(dx) < 5) return;
      if (!moving) { moving = true; try { chip.setPointerCapture(ev.pointerId); } catch { /* ignore */ } }
      const x = ev.clientX;
      const to = centers.filter(c => c.id !== id && c.mid < x).length;
      setDrag({ id, dx, to, w });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!moving) return;
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      setDrag(d => { if (d) onChange(movePane(layout, d.id, d.to)); return null; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const click = (id: PaneId) => {
    if (suppressClick.current) return;
    if (!narrow && layout.shown[id] && visiblePanes(layout).length === 1) return;   // the last pane stays
    onChange(narrow ? soloPane(layout, id) : togglePane(layout, id));
  };
  const vis = visiblePanes(layout);
  const hint = narrow ? 'Click to show this pane' : 'Click to show or hide · double-click to show only this · drag to move it';
  // where the dragged chip would land: the other chips make room on that side
  const dropOrder = drag ? movePane(layout, drag.id, drag.to).order : layout.order;

  return (
    <div class="pane-switch-wrap" ref={wrap}>
      <div class={'pane-switch view-mode-switch' + (drag ? ' dragging' : '')} role="group" aria-label="Panes: WYSIWYG, TeX and PDF" ref={row}>
        {layout.order.map(id => {
          const shift = drag && drag.id !== id ? (dropOrder.indexOf(id) - layout.order.indexOf(id)) * drag.w : 0;
          return (
            <button type="button" key={id} data-pane-chip={id} aria-pressed={layout.shown[id]} class={(layout.shown[id] ? 'active' : '') + (drag?.id === id ? ' lifted' : '')}
              title={`${PANE_TITLES[id]} — ${hint}`}
              style={drag?.id === id ? { transform: `translateX(${drag.dx}px)` } : shift ? { transform: `translateX(${shift}px)` } : undefined}
              onPointerDown={e => onPointerDown(id, e as unknown as PointerEvent)}
              onClick={() => click(id)}
              onDblClick={() => { if (!narrow) onChange(soloPane(layout, id)); }}>
              {PANE_LABELS[id]}
            </button>
          );
        })}
      </div>
      <button type="button" class={'pane-menu-btn' + (menu ? ' open' : '')} aria-haspopup="menu" aria-expanded={menu} title="Arrange the panes: every layout, mirror, equal widths" data-pane-menu onClick={() => setMenu(m => !m)}>▾</button>
      {menu && (
        <div class="pane-menu" role="menu">
          {PRESETS.map((group, gi) => (
            <div class="pane-presets" key={gi}>
              {group.map(p => <PresetButton key={p.join('-')} preset={p} active={presetMatches(layout, p)} onPick={() => { onChange(applyPreset(layout, p)); setMenu(false); }} />)}
            </div>
          ))}
          <div class="pane-menu-actions">
            <button type="button" disabled={vis.length < 2} onClick={() => { onChange(mirrorPanes(layout)); setMenu(false); }} title="Reverse the order of the panes that are shown">⇄ Mirror</button>
            <button type="button" onClick={() => { onChange(resetWidths(layout)); setMenu(false); }} title="Give the panes their default widths again">Equal widths</button>
          </div>
          <div class="pane-menu-hint">{hint}.</div>
        </div>
      )}
    </div>
  );
}

function PresetButton({ preset, active, onPick }: { preset: Preset; active: boolean; onPick: () => void }) {
  const label = preset.map(p => PANE_LABELS[p]).join(' | ');
  return (
    <button type="button" role="menuitemradio" aria-checked={active} class={'pane-preset' + (active ? ' active' : '')} data-preset={preset.join('-')} title={label} aria-label={label} onClick={onPick}>
      {preset.map(p => <span key={p} class={'mini mini-' + p}>{MINI[p]}</span>)}
    </button>
  );
}
