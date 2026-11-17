/**
 * The whiteboard's view helpers (app/boardview.ts): the grid that moves with the camera, the camera
 * that goes to another person, the marker at the edge for someone out of sight, reading another
 * client's awareness state.
 */
import { describe, it, expect } from 'vitest';
import { gridStyle, shownCell, snapTo, camForPeer, camForRect, edgeSpot, lerpCam, readPeer, viewRect, MIN_CELL_PX } from '../packages/client/src/app/boardview';

describe('board grid', () => {
  it('moves and scales with the camera', () => {
    const a = gridStyle('dots', 32, { tx: 0, ty: 0, s: 1 })!;
    const b = gridStyle('dots', 32, { tx: 10, ty: -5, s: 1 })!;
    expect(a.backgroundSize).toBe('32px 32px');
    expect(a.backgroundPosition).not.toBe(b.backgroundPosition);
    expect(gridStyle('dots', 32, { tx: 0, ty: 0, s: 2 })!.backgroundSize).toBe('64px 64px');
  });
  it('takes coarser steps zoomed out, and is gone with none', () => {
    expect(shownCell('dots', 32, 0.1)).toBeGreaterThanOrEqual(MIN_CELL_PX);
    expect(shownCell('squares', 16, 0.08)).toBeGreaterThanOrEqual(MIN_CELL_PX);
    expect(gridStyle('none', 32, { tx: 0, ty: 0, s: 1 })).toBeNull();
    expect(gridStyle('squares', 32, { tx: 0, ty: 0, s: 1 })!.backgroundImage.split('linear-gradient').length - 1).toBe(4);
    expect(gridStyle('lines', 32, { tx: 0, ty: 0, s: 1 })!.backgroundImage).toContain('to bottom');
  });
  it('snaps to it', () => {
    expect(snapTo(47, 32)).toBe(32);
    expect(snapTo(49, 32)).toBe(64);
    expect(snapTo(-17, 32)).toBe(-32);
    expect(snapTo(5, 0)).toBe(5);
  });
});

describe('going to another person', () => {
  it('shows what they see, their pointer in it', () => {
    const view = { x: 1000, y: 500, w: 400, h: 300 };
    const c = camForPeer({ view, cursor: { x: 1100, y: 600 } }, 1, 800, 600)!;
    const r = viewRect(c, 800, 600);
    expect(r.x).toBeLessThanOrEqual(view.x + 1e-6);
    expect(r.y).toBeLessThanOrEqual(view.y + 1e-6);
    expect(r.x + r.w).toBeGreaterThanOrEqual(view.x + view.w - 1e-6);
    expect(c.s).toBeCloseTo(2);
  });
  it('their pointer in the middle when it is outside their view or no view is known', () => {
    const c = camForPeer({ view: null, cursor: { x: 300, y: 200 } }, 0.5, 800, 600)!;
    expect(c.s).toBe(0.5);
    expect(c.tx + 300 * c.s).toBeCloseTo(400);
    expect(c.ty + 200 * c.s).toBeCloseTo(300);
    expect(camForPeer({ view: null, cursor: null }, 1, 800, 600)).toBeNull();
  });
  it('flies there: the ends are the cameras, the zoom goes evenly in its ratio', () => {
    const a = { tx: 0, ty: 0, s: 1 }, b = camForRect({ x: 0, y: 0, w: 100, h: 100 }, 400, 400);
    expect(lerpCam(a, b, 0, 400, 400).s).toBeCloseTo(1);
    expect(lerpCam(a, b, 1, 400, 400).tx).toBeCloseTo(b.tx);
    expect(lerpCam(a, b, 0.5, 400, 400).s).toBeCloseTo(Math.sqrt(a.s * b.s));
  });
});

describe('markers for someone out of sight', () => {
  const m = { top: 70, right: 40, bottom: 60, left: 40 };
  it('none while they are in view', () => {
    expect(edgeSpot(100, 100, 800, 600, m)).toBeNull();
  });
  it('at the edge of the inner part, pointing their way', () => {
    const e = edgeSpot(2000, 305, 800, 600, m)!;
    expect(e.x).toBeCloseTo(760);
    expect(Math.abs(e.angle)).toBeLessThan(0.01);
    const up = edgeSpot(400, -500, 800, 600, m)!;
    expect(up.y).toBeCloseTo(70);
    expect(up.angle).toBeLessThan(0);
  });
});

describe('another client\'s awareness state', () => {
  it('is read with its fields checked', () => {
    const p = readPeer(7, { user: { name: 'Ada Lovelace', color: '#3366cc' }, boardCursor: { x: 1, y: 2 }, boardView: { x: 0, y: 0, w: 10, h: 0 }, boardSel: ['a', 3, 'b'], boardEdit: 'n1' })!;
    expect(p).toMatchObject({ clientId: 7, name: 'Ada Lovelace', color: '#3366cc', cursor: { x: 1, y: 2 }, view: null, sel: ['a', 'b'], edit: 'n1' });
    expect(readPeer(8, { boardCursor: { x: 1, y: 2 } })).toBeNull();
    expect(readPeer(9, { user: { name: 'X', color: 'red; background:url(x)' }, boardCursor: { x: NaN, y: 0 } })).toMatchObject({ color: '#6b7280', cursor: null });
  });
});
