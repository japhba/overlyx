/** The layout editor's drawing controls, shared by every drawing surface. */
import type { ToolButton } from '../app/Toolbar';
import type { Tool } from './protocol';
import type { DeckInk, DeckInkPatch, LassoKind } from './deckink';
import { DECK_INK_WIDTH_CHOICES, deckInkDot, getLassoColors, setLassoColors } from './deckink';
import { EraserSettings, LassoSettings } from './DrawSettings';
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
   * The layout editor's Lines and Shapes, drawn in the pen's colour and width: on whiteboards (the
   * deck has them in its own tool row; documents draw freehand only). `tool`: the one in use, if any.
   */
  shapes?: { tool: string | null; set(kind: InkShape): void };
  /**
   * The lasso, where the surface has one: the kinds of thing it can take there, the colours used there
   * now (its settings' colour filter offers them), what its text is called (a whiteboard's notes)
   */
  lasso?: { kinds: LassoKind[]; colors(): string[]; textLabel?: string };
  /**
   * Something was picked in the row — a pen, the eraser, the lasso, a colour, a width, a line or a
   * shape: the row folds away, what was picked stays in hand (the user's wish: the row is out of the
   * way while drawing; the Draw button brings it back). Not for the settings opened by a second click.
   */
  picked?: () => void;
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
  const done = () => c.picked?.();
  const take = (p: DeckInkPatch) => { if (shaping) c.ink.set(p.pen ? p : { pen: 'pen', ...p }); else { c.ink.set(p); c.setTool('pen'); } done(); };
  const takePen = (p: DeckInkPatch) => { c.ink.set(p); c.setTool('pen'); };
  return [
    [
      { id: 'dk-ink-pen', title: `${ink.nib.ball ? 'Ball pen' : 'Fountain pen'} (P) — with its own colour and width; click it again for its settings: fountain or ball pen, tip, pressure, stabilization, rounding, draw and hold for shapes, calibration`,
        icon: ink.nib.ball ? 'inkball' : 'inkpen', active: c.tool === 'pen' && !hl, action: () => { takePen({ pen: 'pen' }); done(); },
        paletteWhenActive: true,
        palette: { title: 'Pen', render: close => <PenSettings nib={ink.nib} color={ink.pens.pen.color} width={ink.pens.pen.width} habits={{ scribble: ink.scribble, fingersDraw: ink.fingersDraw, pencil: ink.pencil, penInks: ink.penInks, snap: ink.snap }}
          onChange={nib => takePen({ pen: 'pen', nib })} onHabits={h => c.ink.set(h)} onClose={close} /> } },
      { id: 'dk-ink-hl', title: 'Highlighter — with its own colour and width; what is under it shows through (draw and hold: a straight one)', icon: 'inkhl', active: c.tool === 'pen' && hl, action: () => { takePen({ pen: 'highlighter' }); done(); } },
      { id: 'dk-ink-eraser', title: `Eraser (E) — ${ink.eraser.precise ? 'rubs out the part of a stroke it passes over' : 'removes the strokes it passes over'} (drawn ones: shapes and text stay); click it again for its settings: precise, size, highlighter only`,
        icon: 'inkeraser', active: erasing, action: () => { c.setTool('eraser'); done(); },
        paletteWhenActive: true,
        palette: { title: 'Eraser', render: () => <EraserSettings eraser={ink.eraser} onChange={p => c.ink.set({ eraser: p })} /> } },
      ...(c.lasso ? [lassoButton(c.tool === 'lasso', ink, c.lasso, t => { c.setTool(t); done(); }, p => c.ink.set(p))] : []),
    ],
    ...(c.shapes ? [shapeButtons({ ...c.shapes, set: kind => { c.shapes!.set(kind); done(); } })] : []),
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


/** the lasso: a loop drawn round things selects them; clicked again, what it takes and of which colours */
function lassoButton(active: boolean, ink: DeckInk, l: NonNullable<DrawingContext['lasso']>, setTool: (t: Tool) => void, set: (p: DeckInkPatch) => void): ToolButton {
  const kinds = l.kinds.filter(k => ink.lasso.includes(k));
  const some = kinds.length < l.kinds.length || getLassoColors().length > 0;
  return {
    id: 'dk-ink-lasso', title: `Lasso (S) — draw a loop round things to select them: move, resize, recolour, copy or convert them${some ? ' (only some things: click it again to see which)' : ''}; click it again for what it takes`,
    icon: 'inklasso', active, action: () => setTool('lasso'),
    paletteWhenActive: true,
    palette: { title: 'Lasso', render: () => <LassoSettings kinds={l.kinds} value={ink.lasso} onChange={k => set({ lasso: k })} colors={l.colors()} picked={getLassoColors()} onPick={setLassoColors} textLabel={l.textLabel} /> },
  };
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
