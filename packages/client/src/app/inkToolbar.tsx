import type { ToolButton } from './Toolbar';
import { getInk, setInk, currentPen, inkColorName, formatMm } from '../editor/plugins/ink';
import { InkColorPicker, InkWidthPicker, widthDotPx } from './InkPickers';

export function inkToolbar(): ToolButton[][] {
  // The margin-ink toolbar (bottom-docked while drawing is on): tool, then the colour and width
  // of the pen in use — pen and highlighter each keep their own (Goodnotes), so the swatches and
  // dots change with the tool; picking one while erasing or lassoing takes the pen up again.
  // The swatches and dots are presets: one click selects, a click on the selected one opens a
  // picker that replaces it (Goodnotes). The laser is the one tool that works over the text too.
  const ink = getInk();
  const pen = currentPen(ink);
  const penName = ink.pen === 'highlighter' ? 'highlighter' : 'pen';
  const hlPen = ink.pen === 'highlighter';
  const drawing = ink.tool === 'pen' || ink.tool === 'highlighter';
  return [
    [
      { id: 'i-pen', title: 'Pen (pressure-sensitive) — with its own colour and width', icon: 'inkpen', active: ink.tool === 'pen', action: () => setInk({ tool: 'pen' }) },
      { id: 'i-hl', title: 'Highlighter — with its own colour and width', icon: 'inkhl', active: ink.tool === 'highlighter', action: () => setInk({ tool: 'highlighter' }) },
      { id: 'i-eraser', title: 'Eraser — removes whole strokes (also the pen’s eraser end)', icon: 'inkeraser', active: ink.tool === 'eraser', action: () => setInk({ tool: 'eraser' }) },
      { id: 'i-lasso', title: 'Lasso — closes itself and selects every stroke and image it touches, to move, resize (corner handles, Shift keeps proportions) or delete them; with the canvas focused, Ctrl+V pastes an image into the margin instead of the text', icon: 'inklasso', active: ink.tool === 'lasso', action: () => setInk({ tool: 'lasso' }) },
      { id: 'i-laser', title: 'Laser pointer — a glowing trace over the text or the margins that stays while you hold the pen down and fades when you lift it; nothing is saved, but everyone in the document sees it live', icon: 'inklaser', active: ink.tool === 'laser', action: () => setInk({ tool: 'laser' }) },
    ],
    pen.colors.map((c, i) => ({
      id: 'i-c-' + i, title: `${inkColorName(c)} (${penName}) — click the selected colour again to change it`, icon: c,
      html: `<span class="tb-ink-swatch${hlPen ? ' hl' : ''}" data-color="${c}" style="background:${c}"></span>`,
      active: pen.color === c && drawing,
      action: () => setInk({ color: c }),
      paletteWhenActive: true,
      palette: { title: `${penName === 'pen' ? 'Pen' : 'Highlighter'} colour ${i + 1}`, render: () => <InkColorPicker value={c} pen={ink.pen} onChange={v => setInk({ slotColor: { idx: i, color: v } })} /> },
    })),
    pen.widths.map((w, i) => ({
      id: 'i-w-' + i, title: `${penName === 'pen' ? 'Pen' : 'Highlighter'} ${formatMm(w)} — click the selected width again to change it`, icon: String(w),
      html: `<span class="tb-ink-width" data-width="${w}" style="width:${widthDotPx(ink.pen, w)}px;height:${widthDotPx(ink.pen, w)}px"></span>`,
      active: pen.width === w && drawing,
      action: () => setInk({ width: w }),
      paletteWhenActive: true,
      palette: { title: `${penName === 'pen' ? 'Pen' : 'Highlighter'} width ${i + 1}`, render: () => <InkWidthPicker value={w} color={pen.color} pen={ink.pen} onChange={v => setInk({ slotWidth: { idx: i, width: v } })} /> },
    })),
  ];
}
