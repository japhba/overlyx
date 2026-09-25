// @vitest-environment happy-dom
/**
 * The web client's pane layout (app/panes.ts) and what the PDF pane / status bar say about the PDF
 * (app/pdfstatus.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, PRESETS, applyPreset, loadLayout, mirrorPanes, movePane, normalizeLayout, presetMatches, resizeBetween, saveLayout, setPaneShown, soloPane, togglePane, visiblePanes } from '../packages/client/src/app/panes';
import { formatAge, pdfStatus } from '../packages/client/src/app/pdfstatus';

beforeEach(() => localStorage.clear());

describe('pane layout', () => {
  it('shows the WYSIWYG document alone by default', () => {
    expect(visiblePanes(loadLayout())).toEqual(['doc']);
  });
  it('toggles panes; the last one never disappears (the source toggled off alone falls back to the document)', () => {
    let l = togglePane(DEFAULT_LAYOUT, 'pdf');
    expect(visiblePanes(l)).toEqual(['doc', 'pdf']);
    l = togglePane(l, 'doc');
    expect(visiblePanes(l)).toEqual(['pdf']);
    expect(visiblePanes(togglePane(l, 'pdf'))).toEqual(['doc']);
    const docOnly = DEFAULT_LAYOUT;
    expect(togglePane(docOnly, 'doc')).toBe(docOnly);
    expect(visiblePanes(soloPane(togglePane(l, 'tex'), 'tex'))).toEqual(['tex']);
    expect(setPaneShown(l, 'pdf', true)).toBe(l);
  });
  it('moves a pane to any place and mirrors the visible ones', () => {
    const all = applyPreset(DEFAULT_LAYOUT, ['doc', 'tex', 'pdf']);
    expect(movePane(all, 'pdf', 0).order).toEqual(['pdf', 'doc', 'tex']);
    expect(movePane(all, 'doc', 5).order).toEqual(['tex', 'pdf', 'doc']);
    expect(movePane(all, 'doc', 0)).toBe(all);
    expect(mirrorPanes(all).order).toEqual(['pdf', 'tex', 'doc']);
    // mirroring two panes leaves the hidden one where it is
    const two = applyPreset(DEFAULT_LAYOUT, ['doc', 'pdf']);
    const m = mirrorPanes(two);
    expect(visiblePanes(m)).toEqual(['pdf', 'doc']);
    expect(m.shown.tex).toBe(false);
  });
  it('offers every arrangement once: 3 single, 6 pairs, 6 orders of three', () => {
    const all = PRESETS.flat().map(p => p.join('|'));
    expect(PRESETS.map(g => g.length)).toEqual([3, 6, 6]);
    expect(new Set(all).size).toBe(15);
    for (const p of PRESETS.flat()) expect(presetMatches(applyPreset(DEFAULT_LAYOUT, p), p)).toBe(true);
  });
  it('a dragged divider moves width between its two panes, never below the minimum', () => {
    const l = applyPreset(DEFAULT_LAYOUT, ['doc', 'pdf']);
    const r = resizeBetween(l, 'doc', 'pdf', [600, 600], -200);
    expect(r.weights.doc / (r.weights.doc + r.weights.pdf)).toBeCloseTo(400 / 1200, 5);
    const clamped = resizeBetween(l, 'doc', 'pdf', [600, 600], -1000);
    expect(clamped.weights.doc / (clamped.weights.doc + clamped.weights.pdf)).toBeCloseTo(200 / 1200, 5);
    expect(r.weights.tex).toBe(l.weights.tex);
  });
  it('is kept in the browser; a damaged value falls back to the default; an old PDF sidebar tab becomes the PDF pane', () => {
    const l = applyPreset(DEFAULT_LAYOUT, ['pdf', 'tex']);
    saveLayout(l);
    expect(loadLayout()).toEqual(l);
    expect(normalizeLayout({ order: ['doc', 'doc', 'pdf'], shown: { doc: false, tex: false, pdf: false }, weights: { doc: -3 } })).toEqual(DEFAULT_LAYOUT);
    localStorage.clear();
    localStorage.setItem('ol.right', 'pdf');
    expect(visiblePanes(loadLayout())).toEqual(['doc', 'pdf']);
  });
});

describe('PDF status', () => {
  const T = 1_800_000_000_000;
  it('counts in whole minutes', () => {
    expect([3000, 59000, 60000, 125000, 59 * 60000 + 59000, 2 * 3600e3 + 5, 3 * 86400e3].map(formatAge)).toEqual(['just now', 'just now', '1 min', '2 min', '59 min', '2 h', '3 days']);
  });
  it('is current, outdated after a later save, and says so for errors, builds and no PDF', () => {
    const base = { url: '/pdf?t=1', busy: false, ok: true, pdfAt: T - 120000, skew: 0 };
    expect(pdfStatus(base, T - 130000, T)).toMatchObject({ kind: 'current', label: '✓ built 2 min ago', short: 'PDF 2 min old' });
    expect(pdfStatus(base, T - 60000, T)).toMatchObject({ kind: 'outdated', label: '✓ built 2 min ago · outdated' });
    expect(pdfStatus({ ...base, ok: false }, 0, T).kind).toBe('error');
    expect(pdfStatus({ ...base, busy: true }, 0, T)).toMatchObject({ kind: 'building', label: 'building… · last PDF 2 min ago' });
    expect(pdfStatus({ ...base, ok: false }, 0, T)).toMatchObject({ label: '✗ errors · last PDF 2 min ago', short: 'PDF ✗ errors' });
    expect(pdfStatus({ ...base, pdfAt: T - 30000 }, T - 10000, T)).toMatchObject({ kind: 'outdated', label: '✓ built just now · outdated', short: 'PDF just built · outdated' });
    expect(pdfStatus({ url: null, busy: false, ok: null }, 0, T).kind).toBe('none');
    expect(pdfStatus({ url: null, busy: false, ok: false }, 0, T).kind).toBe('error');
    expect(pdfStatus({ ...base, pdfAt: T - 1000 }, 0, T).short).toBe('PDF just built');
  });
  it('measures the age on the server clock (a browser clock that is off does not matter)', () => {
    // the browser runs 10 minutes behind the server: its "now" is T - 600 s
    const st = pdfStatus({ url: '/pdf', busy: false, ok: true, pdfAt: T - 180000, skew: 600000 }, 0, T - 600000);
    expect(st.label).toBe('✓ built 3 min ago');
  });
});
