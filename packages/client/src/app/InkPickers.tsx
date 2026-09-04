/**
 * Goodnotes-style preset editors for the pens: clicking the selected colour swatch or width dot
 * a second time opens one of these, and what is picked replaces that preset (and is drawn with
 * right away). Shared by the margin-ink toolbar (as a toolbar palette) and the whiteboard's
 * tool bar (as a popover under it).
 */
import { HIGHLIGHT_OPACITY, HIGHLIGHT_WIDTH_FACTOR, INK_WIDTH_MAX, INK_WIDTH_MIN, inkColorName, type InkPen } from '../editor/plugins/ink';

/** The colour grid: greys, then six hues in three tones (the highlighter shows them translucent). */
export const INK_COLOR_GRID: string[] = [
  '#202124', '#5f6368', '#9aa0a6', '#dadce0', '#ffffff', '#795548', '#8d6e63', '#a1887f',
  '#d93025', '#f28b82', '#f29900', '#fdd663', '#fbbc04', '#fff59d', '#188038', '#81c995',
  '#1a73e8', '#8ab4f8', '#12b5cb', '#a1e4f2', '#a142f4', '#d7aefb', '#e8467c', '#f8bbd0',
];

export function InkColorPicker({ value, pen, onChange }: { value: string; pen: InkPen; onChange: (color: string) => void }) {
  const hl = pen === 'highlighter';
  return (
    <div class="ink-pick" data-ink-picker="color">
      <div class="ink-pick-grid">
        {INK_COLOR_GRID.map(c => (
          <button key={c} type="button" class={'ink-pick-sw' + (hl ? ' hl' : '') + (c.toLowerCase() === value.toLowerCase() ? ' active' : '')} style={{ background: c }}
            title={inkColorName(c)} data-ink-color={c} onMouseDown={e => e.preventDefault()} onClick={() => onChange(c)} />
        ))}
        <label class="ink-pick-sw custom" title="Any colour…" style={{ background: value }}>
          <input type="color" value={value} data-ink-custom onInput={e => onChange((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <div class="ink-pick-foot"><span>{inkColorName(value)}</span><span class="ink-pick-hint">replaces this preset</span></div>
    </div>
  );
}

export function InkWidthPicker({ value, color, pen, onChange }: { value: number; color: string; pen: InkPen; onChange: (width: number) => void }) {
  const hl = pen === 'highlighter';
  const drawn = hl ? value * HIGHLIGHT_WIDTH_FACTOR : value;
  return (
    <div class="ink-pick" data-ink-picker="width">
      <svg class="ink-pick-preview" viewBox="0 0 200 48" width="200" height="48">
        <path d="M12 30 C 50 4, 90 44, 130 20 S 180 14, 188 26" fill="none" stroke={color} stroke-opacity={hl ? HIGHLIGHT_OPACITY : 1} stroke-width={Math.min(drawn, 44)} stroke-linecap="round" />
      </svg>
      <input type="range" class="ink-pick-range" min={INK_WIDTH_MIN} max={INK_WIDTH_MAX} step={0.25} value={value} data-ink-width
        onInput={e => onChange(parseFloat((e.target as HTMLInputElement).value))} />
      <div class="ink-pick-foot"><span>{Math.round(drawn * 100) / 100} px</span><span class="ink-pick-hint">replaces this preset</span></div>
    </div>
  );
}
