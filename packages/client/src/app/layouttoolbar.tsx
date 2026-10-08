/**
 * The Layout toolbar of layout documents (pages of positioned objects, editor/layout): Inkscape's
 * tools (select, text box, shapes, line, arrow, Bézier pen, pencil, nodes, crop), PowerPoint's
 * arrangement (z-order, align, distribute, group, rotate / flip), the selection's fill, outline,
 * line width, dash and arrow tips, its position and size in millimetres, its animation step and
 * the page commands (add, duplicate, delete, move, background, transition, size, notes, present).
 * Built from the shared ToolbarContext (toolbars.tsx), so both shells show the same row.
 */
import { useEffect, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { hexToTex, cssColor, OBJECT_EFFECTS, PAGE_TRANSITIONS, PAGE_PRESETS, SHAPE_PRESETS, rgbToHex } from '@overlyx/core';
import { api } from '../api';
import { ICONS, NAMED_COLORS, type ToolButton, type Palette } from './Toolbar';
import type { ToolbarContext } from './toolbars';
import { layoutKey, selectedObjects, setTool, layoutControllerOf, selectObjects, showNotes, setMasterView, isMasterView, toggleObjectsPanel, canvasGuides, setCanvasSwitch, setCanvasGuides, SHAPE_TOOLS, type Tool } from '../editor/layout/controller';
import { objectsShown } from '../editor/layout/objects';
import { masterPages, applyMaster, slideFromMaster, newMaster, renameMaster, deleteMaster, duplicateMaster, possibleBases, resolvedFill } from '../editor/layout/masters';
import * as L from '../editor/layout/commands';
import { docColors, boxOf, objectBounds } from '../editor/layout/geom';
import { placeImage, placeImageFiles } from '../editor/layout/images';
import { startPresentation } from '../editor/layout/present';
import { openRawEditor } from '../editor/layout/rawedit';

const I = (body: string) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
Object.assign(ICONS, {
  'ol-select': I('<path d="M4 2.5l8 6.2-3.6.5 2.1 4.1-1.5.8-2.1-4.2L4 12.5z" fill="currentColor" stroke-width="0.8"/>'),
  'ol-text': I('<rect x="2" y="2.5" width="12" height="11" rx="1" stroke-dasharray="2 1.5"/><path d="M5 5.5h6M8 5.5v6"/>'),
  'ol-shape': I('<rect x="1.8" y="5.5" width="7" height="7" rx="0.5"/><circle cx="10.5" cy="6" r="3.8" fill="var(--surface)"/>'),
  'ol-line': I('<path d="M2.5 13.5l11-11"/>'),
  'ol-arrow': I('<path d="M2.5 13.5L13 3"/><path d="M8 3h5v5"/>'),
  'ol-pen': I('<path d="M3 13c1-4 3-6 6-7"/><path d="M9 6l3.5-3.5L14 4l-3.5 3.5z"/><circle cx="3" cy="13" r="1.2" fill="currentColor"/>'),
  'ol-pencil': I('<path d="M2 14c3-1 2-5 5-6s3 3 7-4"/>'),
  'ol-nodes': I('<path d="M3 12C4 5 12 11 13 4"/><rect x="1.8" y="10.8" width="2.4" height="2.4" fill="currentColor"/><rect x="11.8" y="2.8" width="2.4" height="2.4" fill="currentColor"/><circle cx="8" cy="8" r="1.3"/>'),
  'ol-crop': I('<path d="M4.5 1.5v10h10M1.5 4.5h10v10"/>'),
  'ol-image': I('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1"/><circle cx="5.5" cy="6.2" r="1.3"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3.5 3.5"/>'),
  'ol-tex': '<svg viewBox="0 0 16 16"><text x="1" y="11.5" font-size="8.5" font-family="serif" fill="currentColor">TeX</text></svg>',
  'ol-front': I('<rect x="5.5" y="5.5" width="8" height="8" fill="currentColor"/><path d="M2.5 10.5v-8h8" stroke-dasharray="1.6 1.2"/>'),
  'ol-forward': I('<rect x="2.5" y="2.5" width="7" height="7" stroke-dasharray="1.6 1.2"/><rect x="6.5" y="6.5" width="7" height="7" fill="currentColor"/>'),
  'ol-backward': I('<rect x="6.5" y="6.5" width="7" height="7" stroke-dasharray="1.6 1.2"/><rect x="2.5" y="2.5" width="7" height="7" fill="currentColor"/>'),
  'ol-back': I('<rect x="2.5" y="2.5" width="8" height="8" fill="currentColor"/><path d="M13.5 5.5v8h-8" stroke-dasharray="1.6 1.2"/>'),
  'ol-align': I('<path d="M2 1.5v13"/><rect x="3.5" y="3" width="9" height="3.5"/><rect x="3.5" y="9.5" width="5.5" height="3.5"/>'),
  'ol-group': I('<rect x="1.5" y="1.5" width="13" height="13" stroke-dasharray="1.6 1.2"/><rect x="3.5" y="3.5" width="5" height="5"/><circle cx="10.5" cy="10.5" r="2.5"/>'),
  'ol-ungroup': I('<rect x="2" y="2" width="6" height="6"/><circle cx="11" cy="11" r="3"/>'),
  'ol-rotate': I('<path d="M13 8a5 5 0 1 1-2-4"/><path d="M11.5 1.5v3h-3"/>'),
  'ol-fill': I('<path d="M3 8l5-5 5 5-5 5z" fill="currentColor" fill-opacity="0.25"/><path d="M13 10.5c.8 1.2 1.2 2 1.2 2.5a1.2 1.2 0 0 1-2.4 0c0-.5.4-1.3 1.2-2.5z" fill="currentColor"/>'),
  'ol-stroke': I('<rect x="2.5" y="2.5" width="11" height="11" rx="1" stroke-width="2.2"/>'),
  'ol-width': I('<path d="M2 3.5h12" stroke-width="0.8"/><path d="M2 7.5h12" stroke-width="1.6"/><path d="M2 12h12" stroke-width="2.8"/>'),
  'ol-dash': I('<path d="M2 5h3M7 5h3M12 5h2"/><path d="M2 11h1.5M5 11h1.5M8 11h1.5M11 11h1.5"/>'),
  'ol-tips': I('<path d="M2 8h11"/><path d="M10 5l3.5 3-3.5 3" fill="currentColor"/>'),
  'ol-boxstyle': I('<rect x="2" y="3" width="12" height="10" rx="2.5"/><path d="M5 6.5h6M5 9.5h4"/>'),
  'ol-anim': I('<circle cx="5" cy="8" r="2.5" stroke-dasharray="1.4 1.1"/><circle cx="11" cy="8" r="3" fill="currentColor" fill-opacity="0.3"/><path d="M7.8 8h1"/>'),
  'ol-page-add': I('<rect x="2.5" y="3.5" width="11" height="7" rx="0.5"/><path d="M8 11.5v3.5M6.2 13.2h3.6"/>'),
  'ol-page': I('<rect x="1.5" y="3.5" width="13" height="9" rx="0.8"/><path d="M4 6.5h5M4 9h3"/>'),
  'ol-objects': I('<path d="M8 2 14 5 8 8 2 5z"/><path d="m2 8 6 3 6-3M2 11l6 3 6-3"/>'),
  'ol-grid': I('<path d="M2 5.5h12M2 10.5h12M5.5 2v12M10.5 2v12"/>'),
  'ol-notes': I('<rect x="2.5" y="1.5" width="11" height="13" rx="1"/><path d="M5 5h6M5 8h6M5 11h4"/>'),
  'ol-present': '<svg viewBox="0 0 16 16"><path d="M4.5 2.5l9 5.5-9 5.5z" fill="currentColor"/></svg>',
  'ol-lock': I('<rect x="3.5" y="7" width="9" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
});

const SHAPE_ICON = (d: string) => `<svg viewBox="-8 -8 116 116"><path d="${d}" fill="currentColor" fill-opacity="0.18" stroke="currentColor" stroke-width="7" stroke-linejoin="round"/></svg>`;

/** A colour as a swatch in the toolbar (the document's colours evaluated like the page draws them). */
function swatch(expr: string | null): string {
  const css = expr ? cssColor(expr, docColors.map) ?? '#ccc' : null;
  return css ? `<span class="ol-swatch" style="background:${css}"></span>` : '<span class="ol-swatch ol-swatch-none"></span>';
}

/** Fill / outline colour: the document's own colours (\definecolor), LaTeX's named ones, a picker, none. */
export function LayoutColorPalette({ current, onPick, close, noneLabel }: { current: string | null; onPick: (c: string | null) => void; close: () => void; noneLabel: string }) {
  const cssNow = current ? cssColor(current, docColors.map) : null;
  const [custom, setCustom] = useState(cssNow ?? '#2f5597');
  const pick = (c: string | null) => { close(); onPick(c); };
  const own = Object.entries(docColors.map);
  return (
    <div class="tb-colors ol-colors" data-color-palette>
      {own.length > 0 && <div class="ol-colors-title">This document’s colours</div>}
      {own.length > 0 && (
        <div class="tb-color-grid">
          {own.map(([name, rgb]) => <button key={name} type="button" class={'tb-swatch' + (current === name ? ' active' : '')} style={{ background: rgbToHex(rgb) }} title={name} data-color={name} onMouseDown={e => e.preventDefault()} onClick={() => pick(name)} />)}
        </div>
      )}
      <div class="ol-colors-title">LaTeX colours</div>
      <div class="tb-color-grid">
        {NAMED_COLORS.map(([name, css]) => <button key={name} type="button" class={'tb-swatch' + (current === name ? ' active' : '')} style={{ background: css }} title={name} data-color={name} onMouseDown={e => e.preventDefault()} onClick={() => pick(name)} />)}
        <label class="tb-swatch custom" title="Custom colour…" style={{ background: custom }} data-color="custom">
          <input type="color" value={custom} onInput={e => setCustom((e.target as HTMLInputElement).value)} onChange={e => pick(hexToTex((e.target as HTMLInputElement).value))} />
        </label>
      </div>
      <div class="ol-colors-title">Lighter / darker</div>
      <div class="tb-color-grid">
        {current && !current.startsWith('[') && [15, 30, 50, 70].map(p => <button key={p} type="button" class="tb-swatch" style={{ background: cssColor(`${current}!${p}`, docColors.map) ?? '#ccc' }} title={`${current}!${p}`} onMouseDown={e => e.preventDefault()} onClick={() => pick(`${current}!${p}`)} />)}
        {current && !current.startsWith('[') && [70, 50].map(p => <button key={'k' + p} type="button" class="tb-swatch" style={{ background: cssColor(`${current}!${p}!black`, docColors.map) ?? '#333' }} title={`${current}!${p}!black`} onMouseDown={e => e.preventDefault()} onClick={() => pick(`${current}!${p}!black`)} />)}
      </div>
      <div class="tb-colors-foot">
        <button type="button" class="small-btn" data-color="none" onMouseDown={e => e.preventDefault()} onClick={() => pick(null)}>{noneLabel}</button>
        <span>{current ?? 'none'}</span>
      </div>
    </div>
  );
}

/** X / Y / W / H / rotation of the selection, in millimetres and degrees. */
function GeomFields({ view, objs }: { view: EditorView; objs: { node: PMNode; pos: number }[] }) {
  const single = objs.length === 1 && objs[0].node.type.name !== 'ol_group' ? objs[0] : null;
  const none = !objs.length;
  const b = none ? { x: NaN, y: NaN, w: NaN, h: NaN, rot: NaN } : single ? boxOf(single.node) : (() => { const u = objs.map(o => objectBounds(o.node)); const x = Math.min(...u.map(v => v.x)), y = Math.min(...u.map(v => v.y)); return { x, y, w: Math.max(...u.map(v => v.x + v.w)) - x, h: Math.max(...u.map(v => v.y + v.h)) - y, rot: 0 }; })();
  const set = (k: 'x' | 'y' | 'w' | 'h' | 'rot', v: number) => {
    if (!Number.isFinite(v)) return;
    const tr = view.state.tr;
    if (k === 'rot') { if (single) L.setAttrs(tr, single.pos, { rot: L.normDeg(v) }); }
    else if (k === 'x' || k === 'y') { for (const o of objs) L.translate(tr, o.pos, k === 'x' ? v - b.x : 0, k === 'y' ? v - b.y : 0); }
    else if (single) {
      const patch: Record<string, unknown> = { [k]: Math.max(0.5, v) };
      if (k === 'h' && single.node.type.name === 'ol_box') patch.grow = false;
      L.setAttrs(tr, single.pos, patch);
    } else for (const o of objs) L.scaleInto(tr, o.pos, b, { ...b, w: k === 'w' ? v : b.w, h: k === 'h' ? v : b.h });
    view.dispatch(selectObjects(tr, objs.map(o => o.pos)));
  };
  const field = (k: 'x' | 'y' | 'w' | 'h' | 'rot', label: string, val: number, title: string, disabled = false) => (
    <label class="ol-geom-field" title={title}>{label}
      <NumberInput value={val} disabled={disabled || none} onCommit={v => set(k, v)} step={k === 'rot' ? 1 : 0.5} />
    </label>
  );
  return (
    <span class="ol-geom" data-ol-geom>
      {field('x', 'X', b.x, 'Left edge, mm from the page’s left')}
      {field('y', 'Y', b.y, 'Top edge, mm from the page’s top')}
      {field('w', 'W', b.w, 'Width, mm')}
      {field('h', 'H', b.h, 'Height, mm')}
      {field('rot', '∠', b.rot, 'Rotation, degrees counter-clockwise', !single)}
    </span>
  );
}

function NumberInput({ value, onCommit, step, disabled }: { value: number; onCommit: (v: number) => void; step: number; disabled?: boolean }) {
  const shown = Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '';
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(shown); }, [shown, focused]);
  const commit = () => { const v = Number(text.replace(',', '.')); if (Number.isFinite(v) && String(v) !== shown) onCommit(v); };
  return <input type="text" inputMode="decimal" class="ol-num" value={text} disabled={disabled}
    onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); commit(); }}
    onInput={e => setText((e.target as HTMLInputElement).value)}
    onKeyDown={e => {
      if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
      else if (e.key === 'Escape') { setText(shown); (e.target as HTMLInputElement).blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const v = (Number(text) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1); setText(String(Math.round(v * 10) / 10)); onCommit(v); }
      e.stopPropagation();
    }} />;
}

/** Text box settings: inner margin, corner radius, vertical alignment, shape, height follows text, font size. */
function BoxStylePanel({ view, pos, close }: { view: EditorView; pos: number; close: () => void }) {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return null;
  const a = node.attrs;
  const set = (patch: Record<string, unknown>) => view.dispatch(selectObjects(L.setAttrs(view.state.tr, pos, patch), [pos]));
  return (
    <div class="ol-panel">
      <label>Inner margin <NumberInput value={a.pad ?? 0} step={0.5} onCommit={v => set({ pad: Math.max(0, v) || null })} /> mm</label>
      <label>Corner radius <NumberInput value={a.radius ?? 0} step={0.5} onCommit={v => set({ radius: Math.max(0, v) || null })} /> mm</label>
      <label>Font size <NumberInput value={a.font ?? 0} step={1} onCommit={v => set({ font: v > 0 ? v : null })} /> pt <span class="ol-hint">(0: the document’s)</span></label>
      <label>Line spacing <NumberInput value={a.leading ?? 1.2} step={0.05} onCommit={v => set({ leading: v > 0 && Math.abs(v - 1.2) > 1e-3 ? v : null })} /> × size</label>
      <div class="ol-seg">Vertical {(['t', 'c', 'b'] as const).map(v => <button key={v} type="button" class={'small-btn' + (a.valign === v ? ' active' : '')} onClick={() => set({ valign: v })}>{v === 't' ? 'Top' : v === 'c' ? 'Middle' : 'Bottom'}</button>)}</div>
      <div class="ol-seg">Text {(['left', 'justify', 'center', 'right'] as const).map(v => <button key={v} type="button" class={'small-btn' + ((a.align ?? 'left') === v ? ' active' : '')} onClick={() => set({ align: v })}>{v === 'left' ? 'Left' : v === 'justify' ? 'Justified' : v === 'center' ? 'Centred' : 'Right'}</button>)}</div>
      <div class="ol-seg">Shape {(['rect', 'ellipse'] as const).map(v => <button key={v} type="button" class={'small-btn' + (a.shape === v ? ' active' : '')} onClick={() => set({ shape: v })}>{v === 'rect' ? 'Rectangle' : 'Ellipse'}</button>)}</div>
      <label class="ol-check"><input type="checkbox" checked={!!a.grow} onChange={e => set({ grow: (e.target as HTMLInputElement).checked })} /> Height follows the text</label>
      <div class="ol-panel-foot"><button type="button" class="small-btn" onClick={close}>Done</button></div>
    </div>
  );
}

/** Animation: the steps an object is shown on (beamer overlays) and its entrance in presentation mode. */
function AnimationPanel({ view, objs, close }: { view: EditorView; objs: { node: PMNode; pos: number }[]; close: () => void }) {
  const first = objs[0]?.node.attrs;
  const spec = String(first?.step ?? '');
  const m = /^(\d*)-(\d*)$/.exec(spec) ?? /^(\d+)$/.exec(spec);
  const from = m ? Number(m[1]) || 0 : 0;
  const until = m && m.length > 2 ? Number(m[2]) || 0 : m ? Number(m[1]) || 0 : 0;
  const setAll = (patch: Record<string, unknown>) => {
    const tr = view.state.tr;
    for (const o of objs) L.setAttrs(tr, o.pos, patch);
    view.dispatch(selectObjects(tr, objs.map(o => o.pos)));
  };
  const setSteps = (f: number, u: number) => setAll({ step: !f && !u ? null : f && u === f && m && m.length === 2 ? String(f) : `${f || ''}-${u || ''}`.replace(/^-$/, '') || null });
  // the next free step of the page: what "Appear after the others" picks
  const page = objs.length ? L.pageAt(view.state.doc, objs[0].pos) : null;
  let maxStep = 1;
  page?.node.descendants(n => { const s = String(n.attrs?.step ?? ''); for (const d of s.match(/\d+/g) ?? []) maxStep = Math.max(maxStep, Number(d)); return true; });
  return (
    <div class="ol-panel ol-anim-panel">
      <div class="ol-hint">Shown on beamer overlay steps (the PDF gets one page per step); presentation mode plays the entrance.</div>
      <div class="ol-seg"><button type="button" class={'small-btn' + (!spec ? ' active' : '')} onClick={() => setAll({ step: null })}>Always</button>
        <button type="button" class="small-btn" onClick={() => setSteps(maxStep + (spec ? 0 : 1), 0)} title="The step after the page’s last one">Appear next (step {maxStep + (spec ? 0 : 1)})</button></div>
      <label>Appears on step <NumberInput value={from} step={1} onCommit={v => setSteps(Math.max(0, Math.round(v)), until && until < v ? 0 : until)} /></label>
      <label>Disappears after step <NumberInput value={until} step={1} onCommit={v => setSteps(from, Math.max(0, Math.round(v)))} /> <span class="ol-hint">(0: stays)</span></label>
      <label>Overlay spec <input class="ol-text-in" value={spec} onChange={e => setAll({ step: (e.target as HTMLInputElement).value.trim() || null })} onKeyDown={e => e.stopPropagation()} placeholder="e.g. 2- or 2-4 or 1,3" /></label>
      <div class="ol-seg ol-wrap">Entrance {OBJECT_EFFECTS.map(ef => <button key={ef} type="button" class={'small-btn' + ((first?.effect ?? 'appear') === ef ? ' active' : '')} onClick={() => setAll({ effect: ef === 'appear' ? null : ef })}>{ef.replace('fly-', 'fly ')}</button>)}</div>
      <div class="ol-panel-foot"><button type="button" class="small-btn" onClick={close}>Done</button></div>
    </div>
  );
}

/** The canvas's grid (shown, snapped to, its spacing — the document's), its guides (shown; added, all removed) and rulers. */
function GridPanel({ view, close }: { view: EditorView; close: () => void }) {
  const [state, setState] = useState(() => canvasGuides(view));
  if (!state) return null;
  const sw = (k: 'grid' | 'snapGrid' | 'guides' | 'rulers', label: string) => (
    <label class="ol-check-row"><input type="checkbox" checked={state.prefs[k]} data-ol-pref={k} onChange={e => { setCanvasSwitch(view, k, (e.target as HTMLInputElement).checked); setState(canvasGuides(view)); }} /> {label}</label>
  );
  const page = layoutControllerOf(view)?.page ?? { w: 160, h: 90 };
  const add = (axis: 'x' | 'y') => { setCanvasGuides(view, { guides: [...state.guides, { axis, at: Math.round((axis === 'x' ? page.w : page.h) / 2 * 10) / 10 }] }); if (!state.prefs.guides) setCanvasSwitch(view, 'guides', true); close(); };
  return (
    <div class="ol-panel">
      {sw('grid', 'Show the grid')}
      {sw('snapGrid', 'Snap to the grid')}
      <label>Spacing <NumberInput value={state.grid} step={0.5} onCommit={v => { if (v > 0) { setCanvasGuides(view, { grid: v }); setState(canvasGuides(view)); } }} /> mm</label>
      <div class="ol-hint">The grid’s spacing and the guides are the document’s (everyone editing it sees them); what is shown is yours.</div>
      {sw('guides', `Show the guides (${state.guides.length})`)}
      {sw('rulers', 'Rulers — drag a guide out of one')}
      <div class="ol-seg ol-wrap">
        <button type="button" class="small-btn" data-ol-guide-add="x" onClick={() => add('x')}>Vertical guide</button>
        <button type="button" class="small-btn" onClick={() => add('y')}>Horizontal guide</button>
        <button type="button" class="small-btn" disabled={!state.guides.length} onClick={() => { setCanvasGuides(view, { guides: [] }); close(); }}>Remove all guides</button>
      </div>
    </div>
  );
}

/** Page size: the presets (slides, posters, pages) or a custom size, written as the document's paper size. */
function PageSizePanel({ ctx, close }: { ctx: ToolbarContext; close: () => void }) {
  const ctl = ctx.view ? layoutControllerOf(ctx.view) : null;
  const [w, setW] = useState(ctl?.page.w ?? 160), [h, setH] = useState(ctl?.page.h ?? 90);
  const apply = (pw: number, ph: number) => {
    if (!ctx.docId) return;
    close();
    api.setHeader(ctx.docId, { set: { papersize: 'custom', paperwidth: `${pw}mm`, paperheight: `${ph}mm` } })
      .then(r => { ctx.onHeaderLines?.(r.headerLines); ctx.notify(`Page size: ${pw} × ${ph} mm`); })
      .catch(e => ctx.notify(String(e), 'error'));
  };
  return (
    <div class="ol-panel">
      <div class="ol-presets">{PAGE_PRESETS.map(p => <button key={p.id} type="button" class={'small-btn' + (Math.abs(p.w - w) < 0.1 && Math.abs(p.h - h) < 0.1 ? ' active' : '')} onClick={() => apply(p.w, p.h)}>{p.label} <span class="ol-hint">{p.w} × {p.h}</span></button>)}</div>
      <label>Custom <NumberInput value={w} step={1} onCommit={v => setW(v)} /> × <NumberInput value={h} step={1} onCommit={v => setH(v)} /> mm <button type="button" class="small-btn" onClick={() => apply(w, h)}>Apply</button></label>
      <div class="ol-hint">Objects keep their positions in millimetres from the top left corner.</div>
    </div>
  );
}

function hasAttr(objs: { node: PMNode }[], name: string): boolean { return objs.some(o => name in o.node.attrs); }
/** the selection's objects, groups flattened (styles apply to the members) */
function flatten(view: EditorView, objs: { node: PMNode; pos: number }[]): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  const add = (node: PMNode, pos: number) => { if (node.type.name === 'ol_group') node.forEach((c, off) => add(c, pos + 1 + off)); else out.push({ node, pos }); };
  for (const o of objs) add(o.node, o.pos);
  void view;
  return out;
}

export function layoutToolbar(ctx: ToolbarContext): ToolButton[][] {
  const view = ctx.view;
  if (!view) return [];
  const st = layoutKey.getState(view.state);
  const tool: Tool = st?.tool ?? 'select';
  const objs = selectedObjects(view.state);
  const edited = L.editedBox(view.state);
  const targets = objs.length ? objs : edited ? [edited] : [];
  const flat = flatten(view, targets);
  const run = (fn: (v: EditorView) => void) => ctx.runView(v => { fn(v); return true; });
  const t = (id: Tool, icon: string, title: string, shape?: string): ToolButton => ({ id: 'ol-t-' + id, icon, title, active: tool === id, action: () => run(v => setTool(v, id, shape)) });
  const shapePal: Palette = { title: 'Shapes (R rectangle, E ellipse)', cols: 4, items: SHAPE_TOOLS.map(s => ({ label: s.label, html: SHAPE_ICON(s.d), active: tool === 'shape' && st?.shape === s.id, action: () => run(v => setTool(v, 'shape', s.id)) })) };
  const positions = objs.map(o => o.pos);
  const none = !objs.length;
  const ctl = layoutControllerOf(view);
  const pageSz = ctl?.page ?? { w: 160, h: 90 };
  const withSel = (fn: (v: EditorView) => void) => () => run(fn);

  // styles of the selection (first object's value shown)
  const fillable = flat.filter(o => 'fill' in o.node.attrs);
  const strokable = flat.filter(o => 'stroke' in o.node.attrs);
  const curFill = (fillable[0]?.node.attrs.fill as string | null) ?? null;
  const curStroke = (strokable[0]?.node.attrs.stroke as string | null) ?? null;
  const curLw = (strokable[0]?.node.attrs.lw as number | null) ?? 0.4;
  const setStyle = (list: { node: PMNode; pos: number }[], patch: Record<string, unknown>) => run(v => {
    const tr = v.state.tr;
    for (const o of list) L.setAttrs(tr, o.pos, patch);
    v.dispatch(objs.length ? selectObjects(tr, positions) : tr);
  });
  const shapesOnly = flat.filter(o => o.node.type.name === 'ol_shape');

  const tools: ToolButton[] = [
    t('select', 'ol-select', 'Select and move (V) — click selects, Shift adds, drag on the page for a rubber band'),
    t('text', 'ol-text', 'Text box (T) — click for a box, or drag its size'),
    { id: 'ol-t-shape', icon: SHAPE_TOOLS.find(s => s.id === st?.shape) ? 'ol-shape' : 'ol-shape', title: 'Shapes — rectangle (R), ellipse (E), triangle, star, arrow…', active: tool === 'shape', palette: shapePal },
    t('line', 'ol-line', 'Line (L) — Shift: 45° steps'),
    t('arrow', 'ol-arrow', 'Arrow (A)'),
    t('pen', 'ol-pen', 'Bézier pen (B) — click for corners, drag for curves; click the first node or double-click / Enter to finish'),
    t('pencil', 'ol-pencil', 'Pencil (P) — freehand lines, smoothed'),
    { id: 'ol-t-nodes', icon: 'ol-nodes', title: 'Edit nodes (N, or double-click a shape) — drag nodes and handles, double-click the outline for a new node, Delete removes one, C: smooth / corner', active: tool === 'nodes', action: () => run(v => setTool(v, 'nodes')) },
    { id: 'ol-t-crop', icon: 'ol-crop', title: 'Crop an image (C, or double-click it) — the handles crop, drag the picture to move it inside its frame', active: tool === 'crop', disabled: !flat.some(o => o.node.type.name === 'ol_image'), action: () => run(v => setTool(v, 'crop')) },
    { id: 'ol-image', icon: 'ol-image', title: 'Insert an image (or paste / drop one onto a page)', palette: { title: 'Insert an image', list: true, cols: 1, items: [
      { label: 'Upload from this computer…', action: () => run(v => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*,.pdf,.eps,.svg'; inp.multiple = true; inp.onchange = () => { void placeImageFiles(v, [...(inp.files ?? [])]); }; inp.click(); }) },
      ...((ctx.meta?.files ?? []).filter(f => /\.(png|jpe?g|gif|webp|svg|pdf|eps)$/i.test(f.path) && !/(^|\/)(_build|\.)/.test(f.path)).slice(0, 60).map(f => ({ label: f.path, action: () => run(v => { void placeImage(v, relToDoc(ctx.docId, f.path)); }) }))),
    ] } },
    { id: 'ol-raw', icon: 'ol-tex', title: 'Raw LaTeX object (TikZ, pgfplots, anything): shown as its compiled image', action: () => run(v => {
      const page = ctl?.currentPage();
      if (!page) return;
      const latex = '\\begin{tikzpicture}\n  \\draw[thick,->] (0,0) -- (2,1) node[right] {$e^{i\\pi}$};\n\\end{tikzpicture}';
      const node = view.state.schema.nodes.ol_raw.create({ latex, x: pageSz.w * 0.3, y: pageSz.h * 0.3, w: pageSz.w * 0.3, h: pageSz.h * 0.25 });
      const r = L.insertObject(v.state, page.pos, node);
      v.dispatch(selectObjects(r.tr, [r.pos]));
      openRawEditor(v, r.pos);
    }) },
  ];

  const arrange: ToolButton[] = [
    { id: 'ol-front', icon: 'ol-front', title: 'Bring to front (Ctrl+Shift+])', disabled: none, action: withSel(v => { const r = L.reorder(v.state, positions, 'front'); if (r) v.dispatch(selectObjects(r.tr, r.positions)); }) },
    { id: 'ol-forward', icon: 'ol-forward', title: 'Bring forward (Ctrl+])', disabled: none, action: withSel(v => { const r = L.reorder(v.state, positions, 'forward'); if (r) v.dispatch(selectObjects(r.tr, r.positions)); }) },
    { id: 'ol-backward', icon: 'ol-backward', title: 'Send backward (Ctrl+[)', disabled: none, action: withSel(v => { const r = L.reorder(v.state, positions, 'backward'); if (r) v.dispatch(selectObjects(r.tr, r.positions)); }) },
    { id: 'ol-back', icon: 'ol-back', title: 'Send to back (Ctrl+Shift+[)', disabled: none, action: withSel(v => { const r = L.reorder(v.state, positions, 'back'); if (r) v.dispatch(selectObjects(r.tr, r.positions)); }) },
    { id: 'ol-align', icon: 'ol-align', title: 'Align and distribute (one object: on the page)', disabled: none, palette: { title: objs.length > 1 ? 'Align the selection' : 'Align on the page', list: true, cols: 1, items: [
      ...([['left', 'Left edges'], ['hcenter', 'Centres (horizontally)'], ['right', 'Right edges'], ['top', 'Top edges'], ['vcenter', 'Middles (vertically)'], ['bottom', 'Bottom edges']] as [L.AlignHow, string][]).map(([how, label]) => ({ label, action: withSel(v => { const tr = L.align(v.state, positions, how, pageSz); if (tr) v.dispatch(selectObjects(tr, positions)); }) })),
      { label: 'Distribute horizontally (3 or more)', action: withSel(v => { const tr = L.distribute(v.state, positions, 'h'); if (tr) v.dispatch(selectObjects(tr, positions)); }) },
      { label: 'Distribute vertically (3 or more)', action: withSel(v => { const tr = L.distribute(v.state, positions, 'v'); if (tr) v.dispatch(selectObjects(tr, positions)); }) },
    ] } },
    { id: 'ol-group', icon: 'ol-group', title: 'Group (Ctrl+G)', disabled: objs.length < 2, action: withSel(v => { const r = L.group(v.state, positions); if (r) v.dispatch(selectObjects(r.tr, [r.pos])); }) },
    { id: 'ol-ungroup', icon: 'ol-ungroup', title: 'Ungroup (Ctrl+Shift+G)', disabled: !objs.some(o => o.node.type.name === 'ol_group'), action: withSel(v => { const r = L.ungroup(v.state, positions); if (r) v.dispatch(selectObjects(r.tr, r.positions)); }) },
    { id: 'ol-rotate', icon: 'ol-rotate', title: 'Rotate and flip', disabled: none, palette: { title: 'Rotate and flip', list: true, cols: 1, items: [
      { label: 'Rotate 90° clockwise', action: withSel(v => v.dispatch(selectObjects(L.rotateBy(v.state, positions, -90), positions))) },
      { label: 'Rotate 90° counter-clockwise', action: withSel(v => v.dispatch(selectObjects(L.rotateBy(v.state, positions, 90), positions))) },
      { label: 'Flip horizontally', action: withSel(v => v.dispatch(selectObjects(L.flip(v.state, positions, 'h'), positions))) },
      { label: 'Flip vertically', action: withSel(v => v.dispatch(selectObjects(L.flip(v.state, positions, 'v'), positions))) },
      { label: 'No rotation', action: withSel(v => { const tr = v.state.tr; for (const o of flat) L.setAttrs(tr, o.pos, { rot: 0 }); v.dispatch(selectObjects(tr, positions)); }) },
    ] } },
    { id: 'ol-lock', icon: 'ol-lock', title: 'Lock in place (a locked object is not selected by a click — use Tab or the rubber band to reach it again)', active: objs.some(o => o.node.attrs.lock), disabled: none, action: withSel(v => { const on = !objs.some(o => o.node.attrs.lock); const tr = v.state.tr; for (const o of objs) L.setAttrs(tr, o.pos, { lock: on }); v.dispatch(selectObjects(tr, positions)); }) },
  ];

  const style: ToolButton[] = [
    { id: 'ol-fill', icon: 'ol-fill', html: ICONS['ol-fill'] + swatch(curFill), title: `Fill: ${curFill ?? 'none'}`, disabled: !fillable.length, palette: { title: 'Fill', render: close => <LayoutColorPalette current={curFill} close={close} noneLabel="No fill" onPick={c => setStyle(fillable, { fill: c })} /> } },
    { id: 'ol-stroke', icon: 'ol-stroke', html: ICONS['ol-stroke'] + swatch(curStroke), title: `Outline: ${curStroke ?? 'none'}`, disabled: !strokable.length, palette: { title: 'Outline', render: close => <LayoutColorPalette current={curStroke} close={close} noneLabel="No outline" onPick={c => setStyle(strokable, { stroke: c })} /> } },
    { id: 'ol-width', icon: 'ol-width', title: `Line width: ${curLw} pt`, disabled: !strokable.length, palette: { title: 'Line width (pt)', list: true, cols: 1, items: [0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4, 6, 8].map(w => ({ label: `${w} pt${w === 0.4 ? ' (TikZ’s default)' : ''}`, active: Math.abs(curLw - w) < 1e-3, action: () => setStyle(strokable, { lw: w, ...(strokable.some(o => !o.node.attrs.stroke) ? {} : {}) }) })) } },
    { id: 'ol-dash', icon: 'ol-dash', title: 'Dashes', disabled: !shapesOnly.length, palette: { title: 'Dash pattern', list: true, cols: 1, items: [['', 'Solid'], ['dashed', 'Dashed'], ['densely dashed', 'Densely dashed'], ['loosely dashed', 'Loosely dashed'], ['dotted', 'Dotted'], ['densely dotted', 'Densely dotted'], ['dashdotted', 'Dash-dotted']].map(([v, l]) => ({ label: l, active: (shapesOnly[0]?.node.attrs.dash ?? '') === v, action: () => setStyle(shapesOnly, { dash: v || null }) })) } },
    { id: 'ol-tips', icon: 'ol-tips', title: 'Arrow tips', disabled: !shapesOnly.length, palette: { title: 'Arrow tips (TikZ)', list: true, cols: 1, items: [...[['', 'None'], ['-Stealth', 'End: Stealth'], ['Stealth-', 'Start: Stealth'], ['Stealth-Stealth', 'Both: Stealth'], ['-Latex', 'End: LaTeX'], ['->', 'End: open'], ['<->', 'Both: open']].map(([v, l]) => ({ label: l, active: (shapesOnly[0]?.node.attrs.arrows ?? '') === v, action: () => setStyle(shapesOnly, { arrows: v || null }) })),
      // a connector (its ends attached to objects, connectors.ts): straight, or in horizontal and vertical runs
      ...(shapesOnly.some(o => o.node.attrs.from || o.node.attrs.to) ? [['straight', 'Connector: straight'], ['elbow', 'Connector: elbow']].map(([v, l]) => ({ label: l, active: (shapesOnly[0]?.node.attrs.conn ?? 'straight') === v, action: () => setStyle(shapesOnly, { conn: v === 'straight' ? null : v }) })) : [])] } },
    // always there (disabled unless one text box is selected): the row keeps its width, so the page below never jumps when the selection changes
    { id: 'ol-boxstyle', icon: 'ol-boxstyle', title: 'Text box: margin, corners, alignment, font size', disabled: !(flat.length === 1 && flat[0].node.type.name === 'ol_box'), palette: { title: 'Text box', render: (close: () => void) => <BoxStylePanel view={view} pos={flat[0].pos} close={close} /> } } as ToolButton,
    { id: 'ol-opacity', icon: 'α', title: 'Opacity', disabled: !flat.length, palette: { title: 'Opacity', list: true, cols: 1, items: [1, 0.85, 0.7, 0.5, 0.3, 0.15].map(o => ({ label: `${Math.round(o * 100)} %`, active: Math.abs((flat[0]?.node.attrs.opacity ?? 1) - o) < 1e-3, action: () => setStyle(flat, { opacity: o === 1 ? null : o }) })) } },
  ];

  const anim: ToolButton[] = [
    { id: 'ol-anim', icon: 'ol-anim', title: objs.length ? `Animation: ${objs[0].node.attrs.step ? 'step ' + objs[0].node.attrs.step : 'always shown'}` : 'Animation (select objects first)', active: objs.some(o => !!o.node.attrs.step), disabled: none,
      palette: { title: 'Animation', render: close => <AnimationPanel view={view} objs={objs} close={close} /> } },
  ];

  const page = ctl?.currentPage();
  const pageNode = page ? view.state.doc.nodeAt(page.pos) : null;
  // the master view (masters.ts): the page commands are the masters'
  const inMasters = isMasterView(view);
  const masterNames = masterPages(view.state.doc).map(m => m.node.attrs.name as string);
  const masterFill = pageNode?.attrs.master ? resolvedFill(view.state.doc, { attrs: { fill: null, master: pageNode.attrs.master } }) : null;
  const pages: ToolButton[] = [
    { id: 'ol-page-add', icon: 'ol-page-add', title: inMasters ? 'A new master page' : 'New page after this one (with the master of this one)', action: () => run(v => {
      if (inMasters) { v.dispatch(newMaster(v.state, pageSz).tr); return; }
      const cur = ctl?.currentPage();
      const curNode = cur ? v.state.doc.nodeAt(cur.pos) : null;
      const made = curNode?.attrs.master ? slideFromMaster(v.state, cur!.pos, curNode.attrs.master) : null;
      if (made) { v.dispatch(made.tr); return; }
      const at = cur ? cur.pos + curNode!.nodeSize : null;
      v.dispatch(L.insertPage(v.state, at));
    }) },
    { id: 'ol-page', icon: 'ol-page', title: inMasters ? 'This master: name, the master it builds on, background, duplicate, delete' : 'This page: master, duplicate, delete, move, background, transition, size', palette: { title: inMasters ? 'Master' : 'Page', render: close => (
      <div class="ol-panel">
        {inMasters ? <>
          <label>Name <input class="ol-text-in" value={pageNode?.attrs.name ?? ''} onKeyDown={e => e.stopPropagation()} onChange={e => run(v => { const cur = ctl?.currentPage(); const name = (e.target as HTMLInputElement).value.trim(); if (!cur || !name) return; const tr = renameMaster(v.state, cur.pos, name); if (tr) v.dispatch(tr); })} /></label>
          <div class="ol-colors-title">Builds on (its objects drawn first)</div>
          <div class="ol-seg ol-wrap">{[null, ...possibleBases(view.state.doc, pageNode?.attrs.name ?? '')].map(b => <button key={b ?? ''} type="button" class={'small-btn' + ((pageNode?.attrs.master ?? null) === b ? ' active' : '')} onClick={() => { close(); run(v => { const cur = ctl?.currentPage(); if (cur) v.dispatch(L.setAttrs(v.state.tr, cur.pos, { master: b })); }); }}>{b ?? 'nothing'}</button>)}</div>
          <div class="ol-seg ol-wrap">
            <button type="button" class="small-btn" onClick={() => { close(); run(v => { const cur = ctl?.currentPage(); const r = cur ? duplicateMaster(v.state, cur.pos) : null; if (r) v.dispatch(r.tr); }); }}>Duplicate</button>
            <button type="button" class="small-btn" onClick={() => { close(); run(v => { const cur = ctl?.currentPage(); const tr = cur ? deleteMaster(v.state, cur.pos) : null; if (tr) v.dispatch(tr); }); }}>Delete</button>
            <button type="button" class="small-btn" data-ol-close-masters="" onClick={() => { close(); setMasterView(view, false); }}>Close masters</button>
          </div>
        </> : <>
          <div class="ol-colors-title">Master (drawn behind this page; its placeholders place the title and text)</div>
          <div class="ol-seg ol-wrap">{[null, ...masterNames].map(m => <button key={m ?? ''} type="button" data-ol-master={m ?? ''} class={'small-btn' + ((pageNode?.attrs.master ?? null) === m ? ' active' : '')} onClick={() => { close(); run(v => { const cur = ctl?.currentPage(); if (!cur) return; const tr = v.state.tr; applyMaster(tr, cur.pos, m); v.dispatch(tr); }); }}>{m ?? 'none'}</button>)}</div>
          <div class="ol-seg ol-wrap">
            {pageNode?.attrs.master ? <button type="button" class="small-btn" onClick={() => { close(); run(v => { const cur = ctl?.currentPage(); if (!cur) return; const tr = v.state.tr; applyMaster(tr, cur.pos, pageNode.attrs.master, true); v.dispatch(tr); }); }}>Reset to master</button> : null}
            <button type="button" class="small-btn" data-ol-edit-masters="" onClick={() => { close(); setMasterView(view, true); }}>Edit masters</button>
          </div>
        </>}
        {inMasters ? null : <div class="ol-seg ol-wrap">
          <button type="button" class="small-btn" onClick={() => { close(); run(v => { const cur = ctl?.currentPage(); if (!cur) return; const n = v.state.doc.nodeAt(cur.pos)!; v.dispatch(L.insertPage(v.state, cur.pos + n.nodeSize, n)); }); }}>Duplicate</button>
          <button type="button" class="small-btn" onClick={() => { close(); run(v => { const cur = ctl?.currentPage(); if (!cur) return; const tr = L.deletePage(v.state, cur.pos); if (tr) v.dispatch(tr); else ctx.notify('A document keeps at least one page', 'error'); }); }}>Delete</button>
          <button type="button" class="small-btn" onClick={() => { close(); run(v => { const cur = ctl?.currentPage(); if (!cur) return; const tr = L.movePage(v.state, cur.pos, -1); if (tr) v.dispatch(tr.scrollIntoView()); }); }}>Move up</button>
          <button type="button" class="small-btn" onClick={() => { close(); run(v => { const cur = ctl?.currentPage(); if (!cur) return; const tr = L.movePage(v.state, cur.pos, 1); if (tr) v.dispatch(tr.scrollIntoView()); }); }}>Move down</button>
        </div>}
        <div class="ol-colors-title">Background</div>
        <LayoutColorPalette current={pageNode?.attrs.fill ?? null} close={close} noneLabel={masterFill ? 'The master’s' : 'White'} onPick={c => run(v => { const cur = ctl?.currentPage(); if (cur) v.dispatch(L.setAttrs(v.state.tr, cur.pos, { fill: c })); })} />
        {inMasters ? null : <>
          <div class="ol-colors-title">Transition to this page</div>
          <div class="ol-seg ol-wrap">{['', ...PAGE_TRANSITIONS].map(tn => <button key={tn} type="button" class={'small-btn' + ((pageNode?.attrs.transition ?? '') === tn ? ' active' : '')} onClick={() => { close(); run(v => { const cur = ctl?.currentPage(); if (cur) v.dispatch(L.setAttrs(v.state.tr, cur.pos, { transition: tn || null })); }); }}>{tn || 'none'}</button>)}</div>
          <label>Name <input class="ol-text-in" value={pageNode?.attrs.name ?? ''} onKeyDown={e => e.stopPropagation()} onChange={e => run(v => { const cur = ctl?.currentPage(); if (cur) v.dispatch(L.setAttrs(v.state.tr, cur.pos, { name: (e.target as HTMLInputElement).value.trim() || null })); })} /></label>
        </>}
      </div>
    ) } },
    { id: 'ol-size', icon: `${Math.round(pageSz.w)}×${Math.round(pageSz.h)}`, title: 'Page size of the document', palette: { title: 'Page size', render: close => <PageSizePanel ctx={ctx} close={close} /> } },
    // (a page without notes offers "Click to add speaker notes" under it: nothing is added to the file by showing them)
    { id: 'ol-notes', icon: 'ol-notes', title: 'Speaker notes under the pages (beamer’s \\note)', active: view.dom.classList.contains('ol-show-notes'), action: () => run(v => showNotes(v, !v.dom.classList.contains('ol-show-notes'))) },
    { id: 'ol-present', icon: 'ol-present', title: 'Present — full screen from this page (F5; Shift+F5 from the start)', action: () => run(v => startPresentation(v, { fromCurrent: true })) },
    // the grid, the guides and the rulers (guides.ts)
    { id: 'ol-grid', icon: 'ol-grid', title: 'Grid and guides: show the grid, snap to it, its spacing; the guides and rulers', active: canvasGuides(view)?.prefs.grid || canvasGuides(view)?.prefs.snapGrid,
      palette: { title: 'Grid and guides', render: close => <GridPanel view={view} close={close} /> } },
    // the objects list beside the canvas: select, rename, hide, lock, reorder (objects.ts)
    { id: 'ol-objects', icon: 'ol-objects', title: 'Objects: the list of this page’s objects — select, rename, hide, lock, reorder', active: objectsShown(), action: () => run(v => { toggleObjectsPanel(v); }) },
  ];

  // the fields are there with nothing selected too (empty, disabled): the row keeps its width
  const geom: ToolButton[] = [{ id: 'ol-geom', icon: '', title: 'Position and size (mm)', widget: () => <GeomFields view={view} objs={objs} /> }];
  void hasAttr;
  return [tools, arrange, style, anim, geom, pages];
}

/** A project path as the document references it (relative to the document's folder). */
function relToDoc(docId: string | null, projectPath: string): string {
  const parts = (docId ?? '').split('/');
  const dir = parts.slice(2, -1);
  if (!dir.length) return projectPath;
  const prefix = dir.join('/') + '/';
  return projectPath.startsWith(prefix) ? projectPath.slice(prefix.length) : '../'.repeat(dir.length) + projectPath;
}
