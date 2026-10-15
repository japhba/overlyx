/** The layout editor's drawing controls, shared by every drawing surface. */
import type { ToolButton } from '../app/Toolbar';
import type { Tool } from './protocol';
import type { DeckInk, DeckInkPatch } from './deckink';
import { DECK_INK_WIDTH_CHOICES, deckInkDot } from './deckink';
import { InkColorPicker } from '../app/InkPickers';
import { PenSettings } from './PenSettings';
import { inkColorName } from '../editor/plugins/ink';
import { fmtPt, pxToPt } from './units';

export interface DrawingContext {
  tool: string;
  setTool(tool: Tool): void;
  ink: { presets: DeckInk; set(patch: DeckInkPatch): void; draw(on: boolean): void };
  extras?: ToolButton[];
  done?: boolean;
}

/** the Draw row while drawing: pen, highlighter, eraser, then the colours and widths of the pen in hand (the documents' Draw row, inkToolbar.tsx) */
export function drawingToolbar(c: DrawingContext): ToolButton[][] {
  const ink = c.ink.presets, pen = ink.pens[ink.pen];
  const erasing = c.tool === 'eraser';
  const drawing = c.tool === 'pen';
  const hl = ink.pen === 'highlighter';
  const name = hl ? 'Highlighter' : 'Pen';
  const take = (p: DeckInkPatch) => { c.ink.set(p); c.setTool('pen'); };
  return [
    [
      { id: 'dk-ink-pen', title: `${ink.nib.ball ? 'Ball pen' : 'Fountain pen'} (P) — with its own colour and width; click it again for its settings: fountain or ball pen, tip, pressure, stabilization`,
        icon: ink.nib.ball ? 'inkball' : 'inkpen', active: drawing && !hl, action: () => take({ pen: 'pen' }),
        paletteWhenActive: true,
        palette: { title: 'Pen', render: () => <PenSettings nib={ink.nib} color={ink.pens.pen.color} width={ink.pens.pen.width} habits={{ scribble: ink.scribble, fingersDraw: ink.fingersDraw, pencil: ink.pencil }}
          onChange={nib => take({ pen: 'pen', nib })} onHabits={h => c.ink.set(h)} /> } },
      { id: 'dk-ink-hl', title: 'Highlighter — with its own colour and width; what is under it shows through', icon: 'inkhl', active: drawing && hl, action: () => take({ pen: 'highlighter' }) },
      { id: 'dk-ink-eraser', title: 'Eraser (E) — removes the strokes it passes over (drawn ones: shapes and text stay)', icon: 'inkeraser', active: erasing, action: () => c.setTool('eraser') },
    ],
    pen.colors.map((col, i) => ({
      id: 'dk-ink-c' + i, title: `${inkColorName(col)} (${name.toLowerCase()}) — click the selected colour again to change it`, icon: col,
      html: `<span class="tb-ink-swatch${hl ? ' hl' : ''}" data-color="${col}" style="background:${col}"></span>`,
      active: drawing && pen.color === col,
      action: () => take({ color: col }),
      paletteWhenActive: true,
      palette: { title: `${name} colour ${i + 1}`, render: () => <InkColorPicker value={col} pen={ink.pen} onChange={v => take({ slotColor: { idx: i, color: v } })} /> },
    })),
    pen.widths.map((w, i) => ({
      id: 'dk-ink-w' + i, title: `${name} ${fmtPt(pxToPt(w))} pt — click the selected width again to change it`, icon: String(w),
      html: `<span class="tb-ink-width" data-width="${w}" style="width:${deckInkDot(ink.pen, w)}px;height:${deckInkDot(ink.pen, w)}px"></span>`,
      active: drawing && pen.width === w,
      action: () => take({ width: w }),
      paletteWhenActive: true,
      palette: { title: `${name} width ${i + 1}`, list: true, cols: 1, items: DECK_INK_WIDTH_CHOICES[ink.pen].map(v => ({
        label: `${fmtPt(pxToPt(v))} pt`, html: `<svg viewBox="0 0 40 16" width="40"><path d="M3 8h34" stroke="currentColor" stroke-width="${Math.min(v, 14)}" stroke-linecap="round"${hl ? ' opacity="0.45"' : ''}/></svg>`,
        active: v === w, action: () => take({ slotWidth: { idx: i, width: v } }) })) },
    })),
    ...(c.extras?.length ? [c.extras] : []),
    ...(c.done === false ? [] : [[{ id: 'dk-draw-done', title: 'Done drawing (Esc or V)', icon: 'Done', active: true, action: () => c.ink.draw(false) }]]),
  ];
}

