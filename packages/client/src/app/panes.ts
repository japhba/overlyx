/**
 * The writing area's panes (web client): the WYSIWYG document, its LaTeX source and the PDF, side
 * by side — any one, two or all three, in any order, with draggable widths (Overleaf's split view,
 * with a third pane). The layout is kept per browser (`ol.panes`); the `raw:` prefix of a document
 * hash asks for the source pane (links and the View menu's LaTeX-source switch use it).
 *
 * Pure functions here; app/PaneSwitch.tsx is the control in the menu bar, App.tsx lays the panes out.
 */

export type PaneId = 'doc' | 'tex' | 'pdf';
export const PANES: readonly PaneId[] = ['doc', 'tex', 'pdf'];
export const PANE_LABELS: Record<PaneId, string> = { doc: 'WYSIWYG', tex: 'TeX', pdf: 'PDF' };
export const PANE_TITLES: Record<PaneId, string> = {
  doc: 'The rendered document, edited in place',
  tex: 'The LaTeX source of the document (Ctrl+Alt+S)',
  pdf: 'The PDF built from the document (Ctrl+R builds it)',
};

export interface PaneLayout {
  /** left to right; always all three ids */
  order: PaneId[];
  shown: Record<PaneId, boolean>;
  /** relative widths (flex-grow) of the panes that are shown */
  weights: Record<PaneId, number>;
}

export const DEFAULT_WEIGHTS: Record<PaneId, number> = { doc: 1, tex: 0.8, pdf: 0.9 };
export const DEFAULT_LAYOUT: PaneLayout = { order: ['doc', 'tex', 'pdf'], shown: { doc: true, tex: false, pdf: false }, weights: { ...DEFAULT_WEIGHTS } };
const STORAGE = 'ol.panes';

export const visiblePanes = (l: PaneLayout): PaneId[] => l.order.filter(p => l.shown[p]);

/** A layout read back from storage: anything malformed falls back to the default, at least one pane is shown. */
export function normalizeLayout(v: unknown): PaneLayout {
  const d = DEFAULT_LAYOUT;
  if (!v || typeof v !== 'object') return { ...d, shown: { ...d.shown }, weights: { ...d.weights } };
  const o = v as Partial<PaneLayout>;
  const order = Array.isArray(o.order) && o.order.length === 3 && PANES.every(p => o.order!.includes(p)) ? [...o.order] as PaneId[] : [...d.order];
  const shown = { ...d.shown };
  if (o.shown && typeof o.shown === 'object') for (const p of PANES) if (typeof o.shown[p] === 'boolean') shown[p] = o.shown[p];
  if (!PANES.some(p => shown[p])) shown.doc = true;
  const weights = { ...d.weights };
  if (o.weights && typeof o.weights === 'object') for (const p of PANES) { const w = Number(o.weights[p]); if (Number.isFinite(w) && w > 0.05 && w < 20) weights[p] = w; }
  return { order, shown, weights };
}

export function loadLayout(): PaneLayout {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw) return normalizeLayout(JSON.parse(raw));
    // an earlier build showed the PDF as a tab of the right sidebar: bring it over as a pane once
    if (localStorage.getItem('ol.right') === 'pdf') return { ...DEFAULT_LAYOUT, shown: { doc: true, tex: false, pdf: true }, weights: { ...DEFAULT_WEIGHTS } };
  } catch { /* storage unavailable */ }
  return normalizeLayout(null);
}
export function saveLayout(l: PaneLayout): void {
  try { localStorage.setItem(STORAGE, JSON.stringify(l)); } catch { /* storage unavailable */ }
}

/** Show or hide a pane; the last visible one stays (hiding it shows the WYSIWYG document instead, or does nothing when that is it). */
export function setPaneShown(l: PaneLayout, id: PaneId, on: boolean): PaneLayout {
  if (l.shown[id] === on) return l;
  const shown = { ...l.shown, [id]: on };
  if (!PANES.some(p => shown[p])) { if (id === 'doc') return l; shown.doc = true; }
  return { ...l, shown };
}
export const togglePane = (l: PaneLayout, id: PaneId): PaneLayout => setPaneShown(l, id, !l.shown[id]);

/** Only this pane. */
export function soloPane(l: PaneLayout, id: PaneId): PaneLayout {
  return { ...l, shown: { doc: id === 'doc', tex: id === 'tex', pdf: id === 'pdf' } };
}

/** Put a pane at `index` of the order (0 = leftmost). */
export function movePane(l: PaneLayout, id: PaneId, index: number): PaneLayout {
  const rest = l.order.filter(p => p !== id);
  const i = Math.max(0, Math.min(rest.length, index));
  const order = [...rest.slice(0, i), id, ...rest.slice(i)];
  return order.every((p, k) => p === l.order[k]) ? l : { ...l, order };
}

/** Swap the visible neighbours: a two-pane layout mirrored, three panes reversed. */
export function mirrorPanes(l: PaneLayout): PaneLayout {
  const vis = visiblePanes(l);
  if (vis.length < 2) return l;
  const rev = [...vis].reverse();
  let k = 0;
  return { ...l, order: l.order.map(p => (l.shown[p] ? rev[k++] : p)) };
}

/** A preset: the panes shown, left to right. */
export type Preset = PaneId[];
/** Every arrangement: one pane (3), two (6 ordered pairs), three (6 orders) — the layout menu offers them all. */
export const PRESETS: Preset[][] = [
  [['doc'], ['tex'], ['pdf']],
  [['doc', 'pdf'], ['tex', 'pdf'], ['doc', 'tex'], ['pdf', 'doc'], ['pdf', 'tex'], ['tex', 'doc']],
  [['doc', 'tex', 'pdf'], ['tex', 'doc', 'pdf'], ['doc', 'pdf', 'tex'], ['pdf', 'doc', 'tex'], ['tex', 'pdf', 'doc'], ['pdf', 'tex', 'doc']],
];
export function applyPreset(l: PaneLayout, preset: Preset): PaneLayout {
  const order = [...preset, ...l.order.filter(p => !preset.includes(p))];
  return { ...l, order, shown: { doc: preset.includes('doc'), tex: preset.includes('tex'), pdf: preset.includes('pdf') } };
}
export const presetMatches = (l: PaneLayout, preset: Preset): boolean => {
  const vis = visiblePanes(l);
  return vis.length === preset.length && vis.every((p, i) => p === preset[i]);
};

/**
 * A divider dragged between two visible panes: their widths change by `dx` px (the others keep
 * theirs), neither gets narrower than `min`. `widths` are the two panes' current widths in px.
 */
export function resizeBetween(l: PaneLayout, left: PaneId, right: PaneId, widths: [number, number], dx: number, min = 200): PaneLayout {
  const [wl, wr] = widths;
  const total = wl + wr;
  if (total <= 0) return l;
  const nl = Math.max(Math.min(min, total / 2), Math.min(total - Math.min(min, total / 2), wl + dx));
  const sum = l.weights[left] + l.weights[right];
  return { ...l, weights: { ...l.weights, [left]: (sum * nl) / total, [right]: (sum * (total - nl)) / total } };
}

export const resetWidths = (l: PaneLayout): PaneLayout => ({ ...l, weights: { ...DEFAULT_WEIGHTS } });
