/**
 * What the lasso's selection offers, as GoodNotes' lasso menu has it — shared by whiteboards and
 * documents' margins (their bar over the selection) and the slides' quick menu: its colour, thinner
 * or thicker, duplicate, copy, cut, delete, and Convert: the strokes straightened into the shapes they
 * were meant to be (core/shapesnap.ts), the handwriting typed (the server's handwriting reader, POST
 * /api/ai/ink with `notes`), on slides into a formula too.
 *
 * `inkPicture` draws strokes black on white for the reader; `chooseReading` offers its readings beside
 * the selection when it is not sure (the first is the most likely).
 */
import type { ToolButton } from '../app/Toolbar';
import { ColorGrid } from '../app/ColorGrid';
import { api } from '../api';

export interface LassoActions {
  /** the selection's colour, when all of it has one */
  color: string | null;
  recolor?(color: string): void;
  /** thinner (k < 1) or thicker (k > 1) */
  thicken?(k: number): void;
  duplicate?(): void;
  copy?(): void;
  cut?(): void;
  remove(): void;
  /** the strokes the shapes they were meant to be */
  straighten?(): void;
  /** the handwriting typed */
  toText?(): void;
  /** the handwriting as a formula */
  toFormula?(): void;
}

const THINNER = 1 / 1.4, THICKER = 1.4;
const swatch = (c: string | null) => `<span class="tb-ink-swatch" style="background:${c ?? 'linear-gradient(135deg,#e8467c,#2f6fde)'}"></span>`;
const weightIcon = (w: number) => `<svg viewBox="0 0 16 16" width="16" height="16"><path d="M2.5 8h11" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/></svg>`;

/** the selection's buttons (`ids`: their prefix — the bar's own, so they stay one of a kind on the page) */
export function lassoGroups(a: LassoActions, ids = 'lz'): ToolButton[][] {
  const converts = [
    ...(a.toText ? [{ label: 'Text — the handwriting typed', html: '<span class="lz-conv">Aa</span>', action: a.toText }] : []),
    ...(a.toFormula ? [{ label: 'Formula — the handwriting as LaTeX', html: '<span class="lz-conv">∑</span>', action: a.toFormula }] : []),
    ...(a.straighten ? [{ label: 'Shapes — each stroke the line, circle, box or arrow it was meant to be', html: '<span class="lz-conv">△</span>', action: a.straighten }] : []),
  ];
  return [
    [
      ...(a.recolor ? [{ id: `${ids}-color`, title: 'Colour of the selection', icon: '', html: swatch(a.color),
        palette: { title: 'Colour', render: (close: () => void) => <ColorGrid current={a.color} close={close} onPick={c => { if (c) a.recolor!(c); }} /> } } as ToolButton] : []),
      ...(a.thicken ? [
        { id: `${ids}-thinner`, title: 'Thinner strokes', icon: '', html: weightIcon(1), action: () => a.thicken!(THINNER) },
        { id: `${ids}-thicker`, title: 'Thicker strokes', icon: '', html: weightIcon(3.2), action: () => a.thicken!(THICKER) },
      ] : []),
      ...(converts.length ? [{ id: `${ids}-convert`, title: 'Convert: handwriting to text, strokes to clean shapes', icon: '', html: '<span class="lz-conv">T</span>',
        palette: { title: 'Convert to', list: true, cols: 1, items: converts } } as ToolButton] : []),
    ],
    [
      ...(a.duplicate ? [{ id: `${ids}-duplicate`, title: 'Duplicate (Ctrl+D)', icon: 'dk-duplicate', action: a.duplicate }] : []),
      ...(a.copy ? [{ id: `${ids}-copy`, title: 'Copy (Ctrl+C)', icon: 'copy', action: a.copy }] : []),
      ...(a.cut ? [{ id: `${ids}-cut`, title: 'Cut (Ctrl+X)', icon: 'cut', action: a.cut }] : []),
      { id: `${ids}-delete`, title: 'Delete (Del)', icon: 'dk-delete', action: a.remove },
    ],
  ].filter(g => g.length);
}

export type InkLine = readonly (readonly [number, number, ...unknown[]])[];

/** the strokes black on white, a letter about 40 px high, as the reader is sent them (a PNG data URL; null: no ink) */
export function inkPicture(lines: readonly InkLine[]): string | null {
  const pts = lines.flat();
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  // the letters' height: the median height of the strokes taller than a seventh of the tallest (dots, bars and dashes are not)
  const hs = lines.map(l => { let lo = Infinity, hi = -Infinity; for (const p of l) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); } return hi - lo; });
  const top = Math.max(...hs, 1e-6), tall = hs.filter(h => h > top / 7).sort((a, b) => a - b);
  const letter = tall.length ? tall[Math.floor(tall.length / 2)] : top;
  const PAD = 24;
  let k = 40 / Math.max(letter, 1e-6);
  k = Math.min(k, (1800 - 2 * PAD) / Math.max(x1 - x0, 1e-6), (1400 - 2 * PAD) / Math.max(y1 - y0, 1e-6));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round((x1 - x0) * k + 2 * PAD));
  cv.height = Math.max(1, Math.round((y1 - y0) * k + 2 * PAD));
  const g = cv.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, cv.width, cv.height);
  g.strokeStyle = g.fillStyle = '#000';
  g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round';
  const at = (p: readonly [number, number, ...unknown[]]) => [(p[0] - x0) * k + PAD, (p[1] - y0) * k + PAD] as const;
  for (const l of lines) {
    if (!l.length) continue;
    const [sx, sy] = at(l[0]);
    if (l.length === 1) { g.beginPath(); g.arc(sx, sy, 2.5, 0, 2 * Math.PI); g.fill(); continue; }
    g.beginPath();
    g.moveTo(sx, sy);
    for (const p of l.slice(1)) { const [x, y] = at(p); g.lineTo(x, y); }
    g.stroke();
  }
  return cv.toDataURL('image/png');
}

/** the handwriting read: as notes (text, its math as $…$) or as one formula — its readings, the most likely first */
export async function readHandwriting(lines: readonly InkLine[], as: 'notes' | 'formula'): Promise<string[]> {
  const image = inkPicture(lines);
  if (!image) return [];
  const r = await api.aiInk({ image, ...(as === 'notes' ? { notes: true } : {}) });
  return r.candidates;
}

/**
 * The readings offered at (x, y) (client px), when there are several: the one picked, null when
 * dismissed (Escape, a click elsewhere). One reading is taken as it is.
 */
export function chooseReading(readings: string[], x: number, y: number, title = 'Typed as'): Promise<string | null> {
  if (readings.length <= 1) return Promise.resolve(readings[0] ?? null);
  return new Promise(resolve => {
    const box = document.createElement('div');
    box.className = 'tb-popup lz-readings';
    box.setAttribute('role', 'listbox');
    box.style.cssText = `position:fixed;left:${Math.max(8, Math.min(innerWidth - 300, x))}px;top:${Math.max(8, Math.min(innerHeight - 160, y))}px;z-index:1000`;
    const head = document.createElement('div');
    head.className = 'ink-pick-title';
    head.textContent = title;
    box.append(head);
    const done = (v: string | null) => { box.remove(); removeEventListener('pointerdown', away, true); removeEventListener('keydown', key, true); resolve(v); };
    const away = (e: Event) => { if (!box.contains(e.target as Node)) done(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    readings.forEach((r, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lz-reading' + (i === 0 ? ' active' : '');
      b.textContent = r;
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', () => done(r));
      box.append(b);
    });
    document.body.append(box);
    addEventListener('pointerdown', away, true);
    addEventListener('keydown', key, true);
  });
}

/** what went wrong reading the handwriting, said plainly */
export function readingError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/not configured|OPENROUTER/i.test(m)) return 'Handwriting recognition is not set up on this server';
  if (/429|Too much/i.test(m)) return 'Too much handwriting at once — try again in a moment';
  return 'The handwriting could not be read: ' + m;
}
