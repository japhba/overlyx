/**
 * The pen case (packages/client/src/editor/plugins/ink.ts store): pen and highlighter each keep
 * a colour, a width and their presets; picking a colour while another tool is up takes the pen
 * up again; a preset can be replaced (Goodnotes: click the selected swatch again); the
 * whiteboard addresses a pen explicitly without touching the margin tool.
 *   npx vitest run tests/inkpens.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => {
  const g = globalThis as any;
  if (typeof g.window === 'undefined') g.window = g;
  const store = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
});
import { getInk, setInk, currentPen, INK_PALETTES, INK_WIDTHS, INK_WIDTH_MAX, inkColorName } from '../packages/client/src/editor/plugins/ink.ts';

describe('the pen case', () => {
  it('starts with the default presets for both pens', () => {
    const s = getInk();
    expect(s.pens.pen.colors).toEqual(INK_PALETTES.pen.map(c => c[0]));
    expect(s.pens.highlighter.colors).toEqual(INK_PALETTES.highlighter.map(c => c[0]));
    expect(s.pens.pen.widths).toEqual(INK_WIDTHS);
    expect(inkColorName('#fbbc04')).toBe('Yellow');
    expect(inkColorName('#123456')).toBe('#123456');
  });

  it('colour and width go to the pen in use; erasing then picking a colour takes the pen up again', () => {
    setInk({ tool: 'highlighter' });
    setInk({ color: '#e8467c', width: 4 });
    expect(currentPen()).toMatchObject({ color: '#e8467c', width: 4 });
    setInk({ tool: 'pen' });
    expect(currentPen().color).toBe('#1a73e8');   // the pen's own colour, untouched
    setInk({ tool: 'eraser' });
    setInk({ color: '#d93025' });
    expect(getInk().tool).toBe('pen');
    expect(currentPen().color).toBe('#d93025');
    setInk({ tool: 'laser' });
    setInk({ width: 1.5 });
    expect(getInk().tool).toBe('pen');
  });

  it('replacing a preset re-colours the swatch and draws with it; widths are clamped and quantised', () => {
    setInk({ tool: 'pen' });
    setInk({ slotColor: { idx: 2, color: '#12b5cb' } });
    expect(getInk().pens.pen.colors[2]).toBe('#12b5cb');
    expect(currentPen().color).toBe('#12b5cb');
    setInk({ slotColor: { idx: 2, color: 'not a colour' } });   // ignored
    expect(getInk().pens.pen.colors[2]).toBe('#12b5cb');
    setInk({ slotWidth: { idx: 0, width: 99 } });
    expect(getInk().pens.pen.widths[0]).toBe(INK_WIDTH_MAX);
    setInk({ slotWidth: { idx: 1, width: 3.13 } });
    expect(getInk().pens.pen.widths[1]).toBe(3.25);
    expect(currentPen().width).toBe(3.25);
    expect(getInk().pens.pen.widths[2]).toBe(4);   // the others stay
    // persisted for the next session
    expect(JSON.parse(localStorage.getItem('ol.inkPens')!).pen.colors[2]).toBe('#12b5cb');
  });

  it('the whiteboard addresses a pen explicitly: the margin tool is left alone', () => {
    setInk({ tool: 'lasso' });
    setInk({ pen: 'highlighter', color: '#34a853', slotWidth: { idx: 2, width: 6 } });
    expect(getInk().tool).toBe('lasso');
    expect(getInk().pens.highlighter.color).toBe('#34a853');
    expect(getInk().pens.highlighter.widths[2]).toBe(6);
    expect(getInk().pens.highlighter.width).toBe(6);
  });
});
