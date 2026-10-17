/** The layout editor's drawing controls, shared by every drawing surface. */
import type { ToolButton } from '../app/Toolbar';
import type { Tool } from './protocol';
import type { DeckInk, DeckInkPatch } from './deckink';
import { DECK_INK_WIDTH_CHOICES, deckInkDot } from './deckink';
import { ColorGrid } from '../app/ColorGrid';
import { ICONS } from '../app/Toolbar';
import type { InkShape } from '@overlyx/core';
import './deckicons';
import { PenSettings } from './PenSettings';
import { inkColorName } from '../editor/plugins/ink';
import { fmtPt, pxToPt } from './units';

export interface DrawingContext {
  tool: string;
  setTool(tool: Tool): void;
  ink: { presets: DeckInk; set(patch: DeckInkPatch): void; draw(on: boolean): void };
  extras?: ToolButton[];
  done?: boolean;
  /**
   * The layout editor's Lines and Shapes, drawn in the pen's colour and width: in documents' margins
   * and on whiteboards (the deck has them in its own tool row). `tool`: the one in use, if any.
   */
  shapes?: { tool: string | null; set(kind: InkShape): void };
}

/** the deck toolbar's Lines and Shapes (decktoolbar.tsx LINES / SHAPES), with its icons */
const LINE_TOOLS: { kind: InkShape; label: string }[] = [{ kind: 'line', label: 'Line' }, { kind: 'arrow', label: 'Arrow' }];
const SHAPE_TOOLS: { kind: InkShape; label: string }[] = [
  { kind: 'rect', label: 'Rectangle' }, { kind: 'roundrect', label: 'Rounded rectangle' }, { kind: 'ellipse', label: 'Ellipse' },
  { kind: 'triangle', label: 'Triangle' }, { kind: 'diamond', label: 'Diamond' }, { kind: 'star', label: 'Star' }, { kind: 'hexagon', label: 'Hexagon' },
];
const icon = (name: string) => (ICONS[name] ? `<span class="dk-ico">${ICONS[name]}</span>` : '');

/** the Draw row while drawing: pen, highlighter, eraser, then the colours and widths of the pen in hand (the documents' Draw row, inkToolbar.tsx) */
export function drawingToolbar(c: DrawingContext): ToolButton[][] {
  const ink = c.ink.presets;
  const erasing = c.tool === 'eraser';
  // a line or shape in hand: drawn in the pen's colour and width, which the swatches and dots then set (keeping the shape)
  const shaping = !!c.shapes?.tool && c.shapes.tool === c.tool;
  const drawing = c.tool === 'pen' || shaping;
  const hl = !shaping && ink.pen === 'highlighter';
  const pen = ink.pens[hl ? 'highlighter' : 'pen'];
  const name = hl ? 'Highlighter' : 'Pen';
  const take = (p: DeckInkPatch) => { if (shaping) c.ink.set(p.pen ? p : { pen: 'pen', ...p }); else { c.ink.set(p); c.setTool('pen'); } };
  const takePen = (p: DeckInkPatch) => { c.ink.set(p); c.setTool('pen'); };
  return [
    [
      { id: 'dk-ink-pen', title: `${ink.nib.ball ? 'Ball pen' : 'Fountain pen'} (P) — with its own colour and width; click it again for its settings: fountain or ball pen, tip, pressure, stabilization`,
        icon: ink.nib.ball ? 'inkball' : 'inkpen', active: c.tool === 'pen' && !hl, action: () => takePen({ pen: 'pen' }),
        paletteWhenActive: true,
        palette: { title: 'Pen', render: () => <PenSettings nib={ink.nib} color={ink.pens.pen.color} width={ink.pens.pen.width} habits={{ scribble: ink.scribble, fingersDraw: ink.fingersDraw, pencil: ink.pencil }}
          onChange={nib => takePen({ pen: 'pen', nib })} onHabits={h => c.ink.set(h)} /> } },
      { id: 'dk-ink-hl', title: 'Highlighter — with its own colour and width; what is under it shows through', icon: 'inkhl', active: c.tool === 'pen' && hl, action: () => takePen({ pen: 'highlighter' }) },
      { id: 'dk-ink-eraser', title: 'Eraser (E) — removes the strokes it passes over (drawn ones: shapes and text stay)', icon: 'inkeraser', active: erasing, action: () => c.setTool('eraser') },
    ],
    ...(c.shapes ? [shapeButtons(c.shapes)] : []),
    pen.colors.map((col, i) => ({
      id: 'dk-ink-c' + i, title: `${inkColorName(col)} (${name.toLowerCase()}) — click the selected colour again to change it`, icon: col,
      html: `<span class="tb-ink-swatch${hl ? ' hl' : ''}" data-color="${col}" style="background:${col}"></span>`,
      active: drawing && pen.color === col,
      action: () => take({ color: col }),
      paletteWhenActive: true,
      // the layout editor's colours (ColorGrid: its fills, lines and text), what is picked replacing this preset
      palette: { title: `${name} colour ${i + 1} — the pick replaces it`, render: close => <ColorGrid current={col} close={close} onPick={v => { if (v) take({ slotColor: { idx: i, color: v } }); }} /> },
    })),
    pen.widths.map((w, i) => ({
      id: 'dk-ink-w' + i, title: `${name} ${fmtPt(pxToPt(w))} pt — click the selected width again to change it`, icon: String(w),
      html: `<span class="tb-ink-width" data-width="${w}" style="width:${deckInkDot(hl ? 'highlighter' : 'pen', w)}px;height:${deckInkDot(hl ? 'highlighter' : 'pen', w)}px"></span>`,
      active: drawing && pen.width === w,
      action: () => take({ width: w }),
      paletteWhenActive: true,
      palette: { title: `${name} width ${i + 1}`, list: true, cols: 1, items: DECK_INK_WIDTH_CHOICES[hl ? 'highlighter' : 'pen'].map(v => ({
        label: `${fmtPt(pxToPt(v))} pt`, html: `<svg viewBox="0 0 40 16" width="40"><path d="M3 8h34" stroke="currentColor" stroke-width="${Math.min(v, 14)}" stroke-linecap="round"${hl ? ' opacity="0.45"' : ''}/></svg>`,
        active: v === w, action: () => take({ slotWidth: { idx: i, width: v } }) })) },
    })),
    ...(c.extras?.length ? [c.extras] : []),
    ...(c.done === false ? [] : [[{ id: 'dk-draw-done', title: 'Done drawing (Esc or V)', icon: 'Done', active: true, action: () => c.ink.draw(false) }]]),
  ];
}


/** Lines and Shapes, as in the layout editor's tool row: the one in use shows on its button */
function shapeButtons(sh: NonNullable<DrawingContext['shapes']>): ToolButton[] {
  const line = LINE_TOOLS.find(t => t.kind === sh.tool), shape = SHAPE_TOOLS.find(t => t.kind === sh.tool);
  return [
    { id: 'dk-ink-lines', title: 'Lines — a line or an arrow in the pen\'s colour and width: drag it out (Shift: in steps of 45°)', icon: line ? `dk-${line.kind}` : 'dk-line', active: !!line,
      palette: { title: 'Lines', cols: 4, items: LINE_TOOLS.map(t => ({ label: t.label, html: icon(`dk-${t.kind}`), active: sh.tool === t.kind, action: () => sh.set(t.kind) })) } },
    { id: 'dk-ink-shapes', title: 'Shapes — outlined in the pen\'s colour and width: drag one out (Shift: as wide as high)', icon: shape ? `dk-${shape.kind}` : 'dk-shapes', active: !!shape,
      palette: { title: 'Shapes', cols: 4, items: SHAPE_TOOLS.map(t => ({ label: t.label, html: icon(`dk-${t.kind}`), active: sh.tool === t.kind, action: () => sh.set(t.kind) })) } },
  ];
}
