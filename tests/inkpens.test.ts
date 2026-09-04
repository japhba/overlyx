/**
 * The pen case (packages/client/src/editor/plugins/ink.ts store): pen and highlighter each keep
 * a colour, a nib width in mm and their presets; picking a colour while another tool is up takes
 * the pen up again; a preset can be replaced (Goodnotes: click the selected swatch again); the
 * whiteboard addresses a pen explicitly without touching the margin tool. Widths are mm on the
 * page (96 dpi like the ruler) and become px in the strokes; an older px case migrates.
 *   npx vitest run tests/inkpens.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => {
  const g = globalThis as any;
  if (typeof g.window === 'undefined') g.window = g;
  const store = new Map<string, string>();
  // an old px-based case from before widths were mm: pen 4 px thick, highlighter presets ×4 implied
  store.set('ol.inkPens', JSON.stringify({ pen: { color: '#d93025', width: 4, colors: ['#111111'], widths: [1.5, 2.5, 4] }, highlighter: { width: 2.5 } }));
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
});
import { getInk, setInk, currentPen, INK_PALETTES, INK_WIDTHS, INK_WIDTH_RANGE, PX_PER_MM, mmToPx, pxToMm, formatMm, inkColorName } from '../packages/client/src/editor/plugins/ink.ts';

describe('the pen case', () => {
  it('mm ↔ px at the ruler\'s 96 dpi; widths print without trailing zeros', () => {
    expect(PX_PER_MM).toBeCloseTo(3.7795, 4);
    expect(mmToPx(1)).toBe(3.78);
    expect(mmToPx(0.6)).toBe(2.27);
    expect(pxToMm(3.78)).toBe(1);
    expect(pxToMm(2.5)).toBe(0.65);   // to the nearest 0.05 mm
    expect(formatMm(0.6)).toBe('0.6 mm');
    expect(formatMm(2)).toBe('2 mm');
    expect(formatMm(0.35)).toBe('0.35 mm');
  });

  it('migrates an older px case into mm (the highlighter\'s implied ×4 included), defaults elsewhere', () => {
    const s = getInk();
    expect(s.pens.pen.color).toBe('#d93025');
    expect(s.pens.pen.width).toBe(1.05);                  // 4 px → 1.05 mm
    expect(s.pens.pen.widths).toEqual([0.4, 0.65, 1.05]); // the px presets, converted
    expect(s.pens.pen.colors[0]).toBe('#111111');         // a saved swatch…
    expect(s.pens.pen.colors.slice(1)).toEqual(INK_PALETTES.pen.slice(1).map(c => c[0]));   // …the rest default
    expect(s.pens.highlighter.width).toBe(2.65);          // 2.5 px × 4 → 2.65 mm
    expect(s.pens.highlighter.widths).toEqual(INK_WIDTHS.highlighter);
    expect(s.pens.highlighter.colors).toEqual(INK_PALETTES.highlighter.map(c => c[0]));
    expect(inkColorName('#fbbc04')).toBe('Yellow');
    expect(inkColorName('#123456')).toBe('#123456');
    // from now on the case is kept in mm
    expect(localStorage.getItem('ol.inkPensMm')).toBeNull();
    setInk({ tool: 'pen' });
    expect(JSON.parse(localStorage.getItem('ol.inkPensMm')!).pen.width).toBe(1.05);
  });

  it('colour and width go to the pen in use; erasing then picking a colour takes the pen up again', () => {
    setInk({ tool: 'highlighter' });
    setInk({ color: '#e8467c', width: 5 });
    expect(currentPen()).toMatchObject({ color: '#e8467c', width: 5 });
    setInk({ tool: 'pen' });
    expect(currentPen().color).toBe('#d93025');   // the pen's own colour, untouched
    setInk({ tool: 'eraser' });
    setInk({ color: '#1a73e8' });
    expect(getInk().tool).toBe('pen');
    expect(currentPen().color).toBe('#1a73e8');
    setInk({ tool: 'laser' });
    setInk({ width: 0.4 });
    expect(getInk().tool).toBe('pen');
  });

  it('replacing a preset re-colours the swatch and draws with it; widths are clamped to the pen\'s mm range and quantised', () => {
    setInk({ tool: 'pen' });
    setInk({ slotColor: { idx: 2, color: '#12b5cb' } });
    expect(getInk().pens.pen.colors[2]).toBe('#12b5cb');
    expect(currentPen().color).toBe('#12b5cb');
    setInk({ slotColor: { idx: 2, color: 'not a colour' } });   // ignored
    expect(getInk().pens.pen.colors[2]).toBe('#12b5cb');
    setInk({ slotWidth: { idx: 0, width: 99 } });
    expect(getInk().pens.pen.widths[0]).toBe(INK_WIDTH_RANGE.pen.max);
    setInk({ slotWidth: { idx: 1, width: 1.13 } });
    expect(getInk().pens.pen.widths[1]).toBe(1.15);   // 0.05 mm steps
    expect(currentPen().width).toBe(1.15);
    expect(getInk().pens.pen.widths[2]).toBe(1.05);   // the others stay
    // persisted for the next session
    expect(JSON.parse(localStorage.getItem('ol.inkPensMm')!).pen.colors[2]).toBe('#12b5cb');
  });

  it('the whiteboard addresses a pen explicitly: the margin tool is left alone; the highlighter has its own broader range', () => {
    setInk({ tool: 'lasso' });
    setInk({ pen: 'highlighter', color: '#34a853', slotWidth: { idx: 2, width: 6.1 } });
    expect(getInk().tool).toBe('lasso');
    expect(getInk().pens.highlighter.color).toBe('#34a853');
    expect(getInk().pens.highlighter.widths[2]).toBe(6);   // 0.25 mm steps
    expect(getInk().pens.highlighter.width).toBe(6);
    setInk({ pen: 'highlighter', slotWidth: { idx: 0, width: 0.2 } });
    expect(getInk().pens.highlighter.widths[0]).toBe(INK_WIDTH_RANGE.highlighter.min);
  });
});
