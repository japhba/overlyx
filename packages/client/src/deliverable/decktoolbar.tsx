/**
 * The deck toolbar (slides, posters, web pages — DeliverableEditor): the tools to make objects
 * always, and then only what fits what is selected, like Google Slides — text (font, size, B I U,
 * colour, alignment, lists, spacing) for text and shapes with text, fill and outline for shapes,
 * colour / weight / dash / arrow tips for lines, crop / remove background / replace for pictures,
 * arrangement, opacity and the rest for anything selected; with nothing selected, the slide's
 * background and the canvas around the pages. Rendered by the toolbars' own component (Toolbar.tsx),
 * so it looks like the LyX rows in the Classic interface and like Google's in the Modern one.
 */
import { useEffect, useState } from 'preact/hooks';
import { mathPreview, type ToolButton, type Palette } from '../app/Toolbar';
import { ColorGrid } from '../app/ColorGrid';
import type { SelItem, Tool, Paint, ArrangeHow, DeliverableKind, CanvasView, NodeCmd } from './protocol';
import { ASPECTS } from './runtime/crop';
import './deckicons';

export interface DeckTextActions {
  family(css: string | null, google?: string): void;
  size(px: number): void;
  bold(): void; italic(): void; underline(): void; strike(): void;
  color(c: string | null): void;
  highlight(c: string | null): void;
  align(a: 'left' | 'center' | 'right' | 'justify'): void;
  valign(v: 'flex-start' | 'center' | 'flex-end'): void;
  list(kind: 'ul' | 'ol'): void;
  lineHeight(v: string): void;
  clear(): void;
}

export interface DeckCtx {
  kind: DeliverableKind;
  tool: Tool;
  setTool(t: Tool): void;
  readOnly: boolean;
  sel: SelItem[];
  editingText: boolean;
  undo(): void; redo(): void;
  insertImage(): void;
  text: DeckTextActions;
  paint(p: Paint): void;
  arrange(how: ArrangeHow): void;
  image: {
    /** crop mode is on (the picture's frame, Done / Cancel) */
    cropping: boolean;
    crop(): void; resetCrop(): void; removeBackground(): void; replace(): void;
    /** cropped at once to an aspect / a round frame (crop mode: the frame changed) */
    shape(aspect: number | null, shape?: 'rect' | 'circle'): void;
    done(commit: boolean): void;
  };
  remove(): void;
  slideBackground(c: string | null): void;
  canvas: { view: CanvasView; set(v: Partial<CanvasView>): void };
  newSlide(): void;
  /** LyX's formula editor (MathOverlay): open on a formula of the text, a new formula at the caret, its commands, the math panels */
  math: { editing: boolean; insert(display: boolean): void; exec(cmd: string, ...args: unknown[]): void; panels: { id: string; title: string; palette: Palette }[] };
  /** the node editor (a path's points): on, its selected nodes, its commands */
  nodes: { editing: boolean; selected: number; total: number; cmd(c: NodeCmd): void };
}

/** the node editor's row: Inkscape's node toolbar */
function nodeGroups(c: DeckCtx): ToolButton[][] {
  const n = c.nodes, none = n.selected === 0, x = n.cmd;
  return [
    [
      { id: 'dk-node-add', title: 'Add a node between the selected ones (or double-click the outline)', icon: 'dk-node-add', disabled: none, action: () => x('insert') },
      { id: 'dk-node-del', title: 'Delete the selected nodes (Delete)', icon: 'dk-node-del', disabled: none, action: () => x('delete') },
    ],
    [
      { id: 'dk-node-corner', title: 'Corner: the handles move on their own (double-click a node to switch)', icon: 'dk-node-corner', disabled: none, action: () => x('corner') },
      { id: 'dk-node-smooth', title: 'Smooth: the handles stay on one line', icon: 'dk-node-smooth', disabled: none, action: () => x('smooth') },
      { id: 'dk-seg-line', title: 'Make the segments between the selected nodes straight', icon: 'dk-seg-line', disabled: n.selected < 2, action: () => x('straight') },
      { id: 'dk-seg-curve', title: 'Make the segments between the selected nodes curves', icon: 'dk-seg-curve', disabled: n.selected < 2, action: () => x('curve') },
    ],
    [
      { id: 'dk-node-break', title: 'Break the path at the selected nodes', icon: 'dk-node-break', disabled: none, action: () => x('break') },
      { id: 'dk-node-join', title: 'Join two selected end nodes', icon: 'dk-node-join', disabled: n.selected !== 2, action: () => x('join') },
      { id: 'dk-path-close', title: 'Close or open the path', icon: 'dk-path-close', action: () => x('close') },
    ],
    [
      { id: 'dk-node-all', title: 'Select all nodes (Ctrl+A)', icon: `${n.selected}/${n.total}`, action: () => x('all') },
      { id: 'dk-node-done', title: 'Done (Enter or Esc, or click beside the path)', icon: 'Done', active: true, action: () => x('done') },
    ],
  ];
}

/** Inkscape's Path menu for the selection */
function pathItems(c: DeckCtx, sel: SelItem[]) {
  const many = sel.length >= 2;
  const items = [
    ...(many ? [
      { label: 'Union', html: ICON('dk-union'), title: 'One shape of all of them', action: () => c.arrange('union') },
      { label: 'Difference', html: ICON('dk-difference'), title: 'The bottom shape minus the ones above it', action: () => c.arrange('difference') },
      { label: 'Intersection', html: ICON('dk-intersection'), title: 'Only where they all overlap', action: () => c.arrange('intersection') },
      { label: 'Exclusion', html: ICON('dk-exclusion'), title: 'Where an odd number of them overlap', action: () => c.arrange('exclusion') },
      { label: 'Combine (Ctrl+K)', html: ICON('dk-combine'), title: 'One path made of their outlines', action: () => c.arrange('combine') },
    ] : []),
    { label: 'Break apart (Ctrl+Shift+K)', html: ICON('dk-breakapart'), title: 'A path of several pieces: one object per piece', action: () => c.arrange('break-apart') },
    { label: 'Object to path', html: ICON('dk-topath'), title: 'A rectangle, an ellipse, a polygon… as a path whose points can be edited', action: () => c.arrange('to-path') },
    { label: 'Edit points (N)', html: ICON('dk-nodes'), title: 'Drag the nodes and handles of the path (or double-click it)', action: () => c.arrange('edit-nodes') },
    { label: 'Simplify (Ctrl+L)', html: ICON('dk-simplify'), title: 'Fewer nodes, smoother curves', action: () => c.arrange('simplify') },
    { label: 'Reverse direction', html: ICON('dk-reverse'), title: 'The path runs the other way (arrowheads swap ends)', action: () => c.arrange('reverse') },
  ];
  return items;
}

const MATH_PANEL_FACE: Record<string, string> = {
  latex_greek: '\\alpha', latex_brel: '\\leq', latex_bop: '\\otimes', latex_arrow: '\\rightarrow', latex_misc: '\\infty', latex_varsz: '\\sum',
  latex_dots: '\\cdots', latex_deco: '\\hat{a}', functions: '\\sin', font: '\\mathbb{R}', latex_delim: '\\lfloor\\rfloor', latex_ams_rel: '\\leqslant',
  latex_ams_nrel: '\\nleq', latex_ams_ops: '\\boxtimes', latex_ams_arrows: '\\rightrightarrows', latex_ams_misc: '\\square', 'frac-square': '\\frac{a}{b}', 'sqrt-square': '\\sqrt{x}', space: '\\square\\,\\square', style: '\\displaystyle',
};

/** the math row while a formula is open: LyX's math toolbar, the commonest first, then its panels */
function mathGroups(c: DeckCtx): ToolButton[][] {
  const x = c.math.exec;
  const face = (tex: string) => mathPreview(tex) ?? undefined;
  return [
    [
      { id: 'm-frac', title: 'Fraction (Alt+M F)', icon: 'mfrac', action: () => x('insert', '\\frac{#0}{}') },
      { id: 'm-sup', title: 'Superscript (^)', icon: 'sup', action: () => x('moveToSuperscript') },
      { id: 'm-sub', title: 'Subscript (_)', icon: 'sub', action: () => x('moveToSubscript') },
      { id: 'm-sqrt', title: 'Square root (Alt+M S)', icon: 'msqrt', action: () => x('insert', '\\sqrt{#0}') },
      { id: 'm-sum', title: 'Sum (Alt+M U)', icon: 'msum', action: () => x('insert', '\\sum') },
      { id: 'm-int', title: 'Integral (Alt+M I)', icon: 'mint', action: () => x('insert', '\\int') },
    ],
    [
      { id: 'm-paren', title: '( ) that grow with their content (Alt+M ()', icon: '( )', html: face('\\left(\\square\\right)'), action: () => x('delim', '(', ')') },
      { id: 'm-bracket', title: '[ ] (Alt+M [)', icon: '[ ]', html: face('\\left[\\square\\right]'), action: () => x('delim', '[', ']') },
      { id: 'm-brace', title: '{ } (Alt+M {)', icon: '{ }', html: face('\\left\\{\\square\\right\\}'), action: () => x('delim', '\\{', '\\}') },
      { id: 'm-abs', title: '| | (Alt+M |)', icon: '| |', html: face('\\left|\\square\\right|'), action: () => x('delim', '|', '|') },
      { id: 'm-matrix', title: 'Matrix (2 × 2)', icon: 'matrix', html: face('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}'), action: () => x('insert', '\\begin{pmatrix}#0 & \\\\ & \\end{pmatrix}') },
      { id: 'm-cases', title: 'Cases (Alt+M C)', icon: 'cases', html: face('\\cases'), action: () => x('insert', '\\cases') },
      { id: 'm-text', title: 'Text in the formula (Ctrl+M)', icon: 'Tx', action: () => x('text') },
    ],
    c.math.panels.filter(p => MATH_PANEL_FACE[p.id]).map(p => ({ id: 'mp-' + p.id, title: p.title, icon: p.title, html: face(MATH_PANEL_FACE[p.id]), palette: p.palette })),
  ];
}

/** fonts offered: the web fonts load from Google Fonts (a <link> is added to the page when one is first used) */
export const DECK_FONTS: { label: string; css: string | null; google?: string }[] = [
  { label: 'Default', css: null },
  { label: 'Inter', css: 'Inter, system-ui, sans-serif', google: 'Inter' },
  { label: 'Roboto', css: 'Roboto, system-ui, sans-serif', google: 'Roboto' },
  { label: 'Open Sans', css: '"Open Sans", system-ui, sans-serif', google: 'Open Sans' },
  { label: 'Lato', css: 'Lato, system-ui, sans-serif', google: 'Lato' },
  { label: 'Montserrat', css: 'Montserrat, system-ui, sans-serif', google: 'Montserrat' },
  { label: 'Poppins', css: 'Poppins, system-ui, sans-serif', google: 'Poppins' },
  { label: 'Source Sans 3', css: '"Source Sans 3", system-ui, sans-serif', google: 'Source Sans 3' },
  { label: 'Merriweather', css: 'Merriweather, Georgia, serif', google: 'Merriweather' },
  { label: 'Lora', css: 'Lora, Georgia, serif', google: 'Lora' },
  { label: 'Playfair Display', css: '"Playfair Display", Georgia, serif', google: 'Playfair Display' },
  { label: 'EB Garamond', css: '"EB Garamond", Georgia, serif', google: 'EB Garamond' },
  { label: 'Source Code Pro', css: '"Source Code Pro", ui-monospace, monospace', google: 'Source Code Pro' },
  { label: 'System sans-serif', css: 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif' },
  { label: 'Georgia', css: 'Georgia, "Times New Roman", serif' },
  { label: 'Courier', css: '"Courier New", Courier, monospace' },
];

const SHAPES: { tool: Tool; label: string }[] = [
  { tool: 'rect', label: 'Rectangle' }, { tool: 'roundrect', label: 'Rounded rectangle' }, { tool: 'ellipse', label: 'Ellipse' },
  { tool: 'triangle', label: 'Triangle' }, { tool: 'diamond', label: 'Diamond' }, { tool: 'star', label: 'Star' }, { tool: 'hexagon', label: 'Hexagon' },
];
const LINES: { tool: Tool; label: string }[] = [{ tool: 'line', label: 'Line' }, { tool: 'arrow', label: 'Arrow' }, { tool: 'pen', label: 'Scribble (pen)' }, { tool: 'bezier', label: 'Path: click for corners, drag for curves (B)' }];

const firstFamily = (css: string) => css.split(',')[0].trim().replace(/^["']|["']$/g, '');

/** − [size] + : Google's font size box (px) */
function SizeBox({ px, onSet }: { px: number; onSet: (px: number) => void }) {
  const [text, setText] = useState(px ? String(px) : '');
  useEffect(() => { setText(px ? String(px) : ''); }, [px]);
  const commit = () => { const v = Math.round(Number(text)); if (v >= 4 && v <= 800 && v !== px) onSet(v); else setText(px ? String(px) : ''); };
  const step = (d: number) => { const cur = px || 16; onSet(Math.max(4, d > 0 ? (cur < 12 ? cur + 1 : cur < 32 ? cur + 2 : Math.round(cur * 1.15)) : (cur <= 12 ? cur - 1 : cur <= 32 ? cur - 2 : Math.round(cur / 1.15)))); };
  return (
    <span class="dk-size" data-dk-size>
      <button type="button" class="tb-btn" title="Smaller (Ctrl+Shift+,)" onMouseDown={e => e.preventDefault()} onClick={() => step(-1)}>−</button>
      <input value={text} inputMode="numeric" aria-label="Font size" onInput={e => setText((e.target as HTMLInputElement).value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') { setText(px ? String(px) : ''); (e.target as HTMLInputElement).blur(); } }}
        onBlur={commit} />
      <button type="button" class="tb-btn" title="Larger (Ctrl+Shift+.)" onMouseDown={e => e.preventDefault()} onClick={() => step(1)}>+</button>
    </span>
  );
}

function Slider({ value, onSet, label }: { value: number; onSet: (v: number) => void; label: string }) {
  const [v, setV] = useState(value);
  return (
    <div class="dk-slider">
      <input type="range" min={0} max={100} value={v} aria-label={label} onInput={e => setV(Number((e.target as HTMLInputElement).value))} onChange={e => onSet(Number((e.target as HTMLInputElement).value))} />
      <span>{v}%</span>
    </div>
  );
}

const swatchIcon = (glyph: string, color: string | null) => `<svg viewBox="0 0 16 16">${glyph}<rect x="2" y="12.6" width="12" height="2.6" rx="0.5" fill="${color ?? 'none'}" stroke="${color ? 'none' : 'currentColor'}" stroke-width="0.7"/></svg>`;

export function deckToolbar(c: DeckCtx): { tools: ToolButton[][]; context: ToolButton[][] } {
  const ro = c.readOnly;
  const sel = c.sel;
  const one = sel.length === 1 ? sel[0] : null;
  const shapeTool = SHAPES.find(s => s.tool === c.tool);
  const lineTool = LINES.find(s => s.tool === c.tool);

  const tools: ToolButton[][] = [
    [
      { id: 'dk-undo', title: 'Undo (Ctrl+Z)', icon: 'undo', action: c.undo, disabled: ro },
      { id: 'dk-redo', title: 'Redo (Ctrl+Y)', icon: 'redo', action: c.redo, disabled: ro },
    ],
    [
      { id: 'dk-select', title: 'Select and move (V)', icon: 'dk-select', action: () => c.setTool('select'), active: c.tool === 'select' },
      { id: 'dk-text', title: 'Text box (T) — click or drag on the slide', icon: 'dk-text', action: () => c.setTool('text'), active: c.tool === 'text', disabled: ro },
      { id: 'dk-shapes', title: 'Shapes (R rectangle, O ellipse)', icon: shapeTool ? `dk-${shapeTool.tool}` : 'dk-shapes', active: !!shapeTool, disabled: ro,
        palette: { title: 'Shapes', cols: 4, items: SHAPES.map(s => ({ label: s.label, html: ICON(`dk-${s.tool}`), active: c.tool === s.tool, action: () => c.setTool(s.tool) })) } },
      { id: 'dk-lines', title: 'Lines (L line, A arrow, P pen, B Bézier path)', icon: lineTool ? `dk-${lineTool.tool}` : 'dk-line', active: !!lineTool, disabled: ro,
        palette: { title: 'Lines', cols: 4, items: LINES.map(s => ({ label: s.label, html: ICON(`dk-${s.tool}`), active: c.tool === s.tool, action: () => c.setTool(s.tool) })) } },
      { id: 'dk-image', title: 'Picture… (or drop a picture or an SVG on the slide)', icon: 'dk-image', action: c.insertImage, disabled: ro },
      { id: 'dk-formula', title: c.editingText ? 'Formula here, in the text (Ctrl+M; Ctrl+Shift+M displayed)' : 'Formula — click or drag on the slide; while typing a text, Ctrl+M puts one in it', icon: 'dk-formula',
        action: () => { if (c.editingText) c.math.insert(false); else c.setTool('formula'); }, active: c.tool === 'formula' || c.math.editing, disabled: ro },
    ],
  ];

  if (ro) return { tools, context: [] };
  if (c.math.editing) return { tools, context: mathGroups(c) };
  if (c.nodes.editing) return { tools, context: nodeGroups(c) };
  const context: ToolButton[][] = [];
  const textish = c.editingText || sel.some(s => s.canText || s.text);
  const shapes = sel.filter(s => s.kind === 'shape' || s.kind === 'svg' || s.kind === 'svgpart' || (s.kind === 'text' && s.style.fill));
  const lines = sel.filter(s => s.kind === 'line');
  const images = sel.filter(s => s.kind === 'image');

  if (textish) {
    const st = one?.style;
    const px = st ? Math.round(parseFloat(st.fontSize) || 0) : 0;
    const fam = st ? firstFamily(st.fontFamily) : '';
    const bold = sel.length > 0 && sel.every(s => Number(s.style.fontWeight) >= 600);
    const italic = sel.length > 0 && sel.every(s => s.style.fontStyle === 'italic');
    const under = sel.length > 0 && sel.every(s => s.style.textDecoration.includes('underline'));
    context.push([
      { id: 'dk-font', title: 'Font', icon: '', html: `<span class="dk-font-face">${escHtml(fam || 'Font')}</span>`,
        palette: { title: 'Font', list: true, cols: 1, items: DECK_FONTS.map(f => ({ label: f.label, html: `<span class="dk-font-sample" style="font-family:${escAttr(f.css ?? 'inherit')}">Aa</span>`, active: !!f.css && firstFamily(f.css) === fam, action: () => c.text.family(f.css, f.google) })) } },
      { id: 'dk-size', title: 'Font size (px)', icon: '', widget: () => <SizeBox px={px} onSet={c.text.size} /> },
    ]);
    context.push([
      { id: 'dk-b', title: 'Bold (Ctrl+B)', icon: 'dk-bold', action: c.text.bold, active: bold },
      { id: 'dk-i', title: 'Italic (Ctrl+I)', icon: 'dk-italic', action: c.text.italic, active: italic },
      { id: 'dk-u', title: 'Underline (Ctrl+U)', icon: 'dk-underline', action: c.text.underline, active: under },
      { id: 'dk-color', title: 'Text colour', icon: '', html: swatchIcon('<text x="3.6" y="10.4" font-size="10.5" font-family="system-ui, sans-serif" fill="currentColor">A</text>', st?.color ?? null),
        palette: { title: 'Text colour', render: close => <ColorGrid current={st?.color ?? null} close={close} onPick={col => c.text.color(col)} /> } },
      ...(c.editingText ? [{ id: 'dk-hl', title: 'Highlight colour (of the selected words)', icon: '', html: swatchIcon(ICONSVG.highlight, null),
        palette: { title: 'Highlight', render: (close: () => void) => <ColorGrid current={null} close={close} none="None" onPick={col => c.text.highlight(col)} /> } } as ToolButton] : []),
    ]);
    const al = st?.textAlign ?? 'left';
    context.push([
      { id: 'dk-align', title: 'Alignment', icon: al === 'center' ? 'aligncenter' : al === 'right' || al === 'end' ? 'alignright' : 'alignleft',
        palette: { title: 'Alignment', list: true, cols: 1, items: [
          { label: 'Left (Ctrl+Shift+L)', html: ICON('alignleft'), active: al === 'left' || al === 'start', action: () => c.text.align('left') },
          { label: 'Centre (Ctrl+Shift+E)', html: ICON('aligncenter'), active: al === 'center', action: () => c.text.align('center') },
          { label: 'Right (Ctrl+Shift+R)', html: ICON('alignright'), active: al === 'right' || al === 'end', action: () => c.text.align('right') },
          { label: 'Justified (Ctrl+Shift+J)', html: ICON('alignleft'), active: al === 'justify', action: () => c.text.align('justify') },
          ...(sel.some(s => s.kind === 'shape') ? [
            { label: 'Top', html: ICON('valigntop'), action: () => c.text.valign('flex-start') },
            { label: 'Middle', html: ICON('valignmiddle'), action: () => c.text.valign('center') },
            { label: 'Bottom', html: ICON('valignbottom'), action: () => c.text.valign('flex-end') },
          ] : []),
        ] } },
      { id: 'dk-ul', title: 'Bulleted list (Ctrl+Shift+8)', icon: 'dk-bullets', action: () => c.text.list('ul') },
      { id: 'dk-ol', title: 'Numbered list (Ctrl+Shift+7)', icon: 'dk-numbers', action: () => c.text.list('ol') },
      { id: 'dk-more-text', title: 'More text options', icon: 'dk-lines',
        palette: { title: 'Text', list: true, cols: 1, items: [
          { label: 'Strikethrough', html: ICON('dk-strike'), action: c.text.strike },
          ...['1', '1.15', '1.5', '2'].map(v => ({ label: `Line spacing ${v}`, html: ICON('dk-lines'), active: lineSpacing(st) === v, action: () => c.text.lineHeight(v) })),
          { label: 'Clear formatting (Ctrl+\\)', html: ICON('dk-clear'), action: c.text.clear },
        ] } },
    ]);
  }

  const paintOf = (items: SelItem[]) => items[0]?.style;
  if (shapes.length) {
    const st = paintOf(shapes)!;
    const boxShape = shapes.some(s => s.kind === 'shape');
    context.push([
      { id: 'dk-fill', title: 'Fill colour', icon: '', html: swatchIcon(ICONSVG.fill, st.fill),
        palette: { title: 'Fill colour', render: close => <ColorGrid current={st.fill} close={close} none="Transparent" onPick={col => c.paint({ fill: col })} /> } },
      { id: 'dk-stroke', title: 'Border colour', icon: '', html: swatchIcon(ICONSVG.stroke, st.stroke),
        palette: { title: 'Border colour', render: close => <ColorGrid current={st.stroke} close={close} none="No border" onPick={col => c.paint({ stroke: col })} /> } },
      weightBtn('dk-weight', 'Border weight', st.strokeWidth, w => c.paint(w === 0 ? { stroke: null } : { strokeWidth: w })),
      dashBtn('dk-dash', 'Border dash', st.dash, d => c.paint({ dash: d })),
      ...(boxShape ? [{ id: 'dk-radius', title: 'Corner radius', icon: 'dk-radius',
        palette: { title: 'Corners', list: true, cols: 1, items: [0, 4, 8, 16, 28, 48].map(r => ({ label: r ? `${r} px` : 'Square', action: () => c.paint({ radius: r || null }) })).concat([{ label: 'Round (ellipse)', action: () => c.paint({ radius: 9999 }) }]) } } as ToolButton] : []),
    ]);
  }
  if (lines.length) {
    const st = paintOf(lines)!;
    context.push([
      { id: 'dk-linecolor', title: 'Line colour', icon: '', html: swatchIcon(ICONSVG.stroke, st.stroke),
        palette: { title: 'Line colour', render: close => <ColorGrid current={st.stroke} close={close} onPick={col => c.paint({ stroke: col })} /> } },
      weightBtn('dk-lineweight', 'Line weight', st.strokeWidth, w => c.paint({ strokeWidth: w || 1 })),
      dashBtn('dk-linedash', 'Line dash', st.dash, d => c.paint({ dash: d })),
      { id: 'dk-tips', title: 'Arrowheads', icon: 'dk-tips',
        palette: { title: 'Arrowheads', list: true, cols: 1, items: [
          { label: 'None', active: !st.arrowStart && !st.arrowEnd, action: () => c.paint({ arrowStart: false, arrowEnd: false }) },
          { label: 'At the end →', active: !st.arrowStart && st.arrowEnd, action: () => c.paint({ arrowStart: false, arrowEnd: true }) },
          { label: 'At the start ←', active: st.arrowStart && !st.arrowEnd, action: () => c.paint({ arrowStart: true, arrowEnd: false }) },
          { label: 'Both ↔', active: st.arrowStart && st.arrowEnd, action: () => c.paint({ arrowStart: true, arrowEnd: true }) },
        ] } },
    ]);
  }
  if (images.length === 1 || c.image.cropping) {
    const im = images[0];
    const shapes = ASPECTS.map(a => ({ label: a.label, html: a.shape === 'circle' ? ICON('dk-ellipse') : ICON('dk-crop'), action: () => c.image.shape(a.ratio, a.shape ?? 'rect') }));
    context.push(c.image.cropping ? [
      { id: 'dk-cropdone', title: 'Keep the crop (Enter)', icon: 'Done', action: () => c.image.done(true), active: true },
      { id: 'dk-cropcancel', title: 'Leave the picture as it was (Esc)', icon: 'Cancel', action: () => c.image.done(false) },
      { id: 'dk-cropaspect', title: 'Frame shape', icon: 'dk-crop', palette: { title: 'Crop to', list: true, cols: 1, items: shapes } },
    ] : [
      { id: 'dk-crop', title: 'Crop — drag the picture inside the frame to choose what shows (double-click a picture)', icon: 'dk-crop', action: c.image.crop },
      { id: 'dk-cropshape', title: 'Crop to a shape or an aspect ratio', icon: 'dk-radius',
        palette: { title: 'Crop to', list: true, cols: 1, items: [...shapes, ...(im?.cropped ? [{ label: 'Reset crop', html: ICON('dk-crop'), action: c.image.resetCrop }] : [])] } },
      { id: 'dk-nobg', title: 'Remove background', icon: 'dk-nobg', action: c.image.removeBackground },
      { id: 'dk-replace', title: 'Replace picture…', icon: 'dk-replace', action: c.image.replace },
    ]);
  }

  if (sel.length) {
    const st = one?.style;
    const locked = sel.every(s => s.locked);
    const isGroup = sel.some(s => s.kind === 'group');
    context.push([
      { id: 'dk-arrange', title: 'Arrange: order, align, rotate, group', icon: 'dk-arrange',
        palette: { title: 'Arrange', list: true, cols: 1, items: [
          { label: 'Bring to front (Ctrl+Shift+↑)', html: ICON('dk-arrange'), action: () => c.arrange('front') },
          { label: 'Bring forward (Ctrl+↑)', html: ICON('dk-arrange'), action: () => c.arrange('forward') },
          { label: 'Send backward (Ctrl+↓)', html: ICON('dk-arrange'), action: () => c.arrange('backward') },
          { label: 'Send to back (Ctrl+Shift+↓)', html: ICON('dk-arrange'), action: () => c.arrange('back') },
          { label: sel.length > 1 ? 'Align left edges' : 'Align left on the slide', html: ICON('dk-align'), action: () => c.arrange('align-left') },
          { label: 'Align centres', html: ICON('dk-align'), action: () => c.arrange('align-center') },
          { label: 'Align right edges', html: ICON('dk-align'), action: () => c.arrange('align-right') },
          { label: 'Align tops', html: ICON('dk-align'), action: () => c.arrange('align-top') },
          { label: 'Align middles', html: ICON('dk-align'), action: () => c.arrange('align-middle') },
          { label: 'Align bottoms', html: ICON('dk-align'), action: () => c.arrange('align-bottom') },
          { label: 'Centre on the slide horizontally', html: ICON('dk-align'), action: () => c.arrange('center-h') },
          { label: 'Centre on the slide vertically', html: ICON('dk-align'), action: () => c.arrange('center-v') },
          ...(sel.length >= 3 ? [
            { label: 'Distribute horizontally', html: ICON('dk-align'), action: () => c.arrange('distribute-h') },
            { label: 'Distribute vertically', html: ICON('dk-align'), action: () => c.arrange('distribute-v') },
          ] : []),
          { label: 'Rotate 90° clockwise', html: ICON('dk-rotate'), action: () => c.arrange('rotate-cw') },
          { label: 'Rotate 90° counter-clockwise', html: ICON('dk-rotate'), action: () => c.arrange('rotate-ccw') },
          ...(sel.some(s => s.style.rotate) ? [{ label: 'Reset rotation', html: ICON('dk-rotate'), action: () => c.arrange('rotate-reset') }] : []),
          { label: 'Flip horizontally', html: ICON('dk-flip'), action: () => c.arrange('flip-h') },
          { label: 'Flip vertically', html: ICON('dk-flip'), action: () => c.arrange('flip-v') },
          ...(sel.length > 1 ? [{ label: 'Group (Ctrl+G)', html: ICON('dk-group'), action: () => c.arrange('group') }] : []),
          ...(isGroup ? [{ label: 'Ungroup (Ctrl+Shift+G)', html: ICON('dk-group'), action: () => c.arrange('ungroup') }] : []),
        ] } },
      ...(sel.some(s => s.kind === 'shape' || s.kind === 'svg' || s.kind === 'svgpart' || s.kind === 'line') ? [{
        id: 'dk-path', title: 'Path: union, difference, intersection, combine, object to path, edit points…', icon: 'dk-path',
        palette: { title: 'Path', list: true, cols: 1, items: pathItems(c, sel) } } as ToolButton] : []),
      { id: 'dk-opacity', title: 'Opacity', icon: 'dk-opacity',
        palette: { title: 'Opacity', render: () => <Slider label="Opacity" value={Math.round((st ? Number(st.opacity) : 1) * 100)} onSet={v => c.paint({ opacity: v / 100 })} /> } },
      { id: 'dk-shadow', title: 'Shadow', icon: 'dk-shadow', active: !!st?.shadow, action: () => c.paint({ shadow: !st?.shadow }) },
      { id: 'dk-lock', title: locked ? 'Unlock (it can be moved again)' : 'Lock (selected, not moved or resized)', icon: 'dk-lock', active: locked, action: () => c.arrange(locked ? 'unlock' : 'lock') },
      { id: 'dk-delete', title: 'Delete (Del)', icon: 'dk-delete', action: c.remove, disabled: locked },
    ]);
  } else if (c.kind !== 'page') {
    const v = c.canvas.view;
    context.push([
      { id: 'dk-bg', title: 'Slide background colour', icon: 'dk-background',
        palette: { title: 'Slide background', render: close => <ColorGrid current={null} close={close} none="As the design has it" onPick={col => c.slideBackground(col)} /> } },
      { id: 'dk-canvas', title: 'Canvas: its colour, transparency checkerboards (also: right-click the canvas)', icon: 'dk-canvas',
        palette: { title: 'Canvas', render: close => (
          <div class="dk-canvas-pal">
            <label class="dk-check"><input type="checkbox" checked={v.deskChecker} onChange={e => c.canvas.set({ deskChecker: (e.target as HTMLInputElement).checked })} /> Checkerboard canvas</label>
            <label class="dk-check"><input type="checkbox" checked={v.pageChecker} onChange={e => c.canvas.set({ pageChecker: (e.target as HTMLInputElement).checked })} /> Checkerboard under the slides (shows transparency)</label>
            <div class="dk-pal-title">Canvas colour</div>
            <ColorGrid current={v.desk} close={close} none="Same as the page" onPick={col => c.canvas.set({ desk: col, deskChecker: false })} />
          </div>
        ) } },
      { id: 'dk-newslide', title: 'New slide (Ctrl+M)', icon: '+ Slide', action: c.newSlide },
    ]);
  }
  return { tools, context };
}

function weightBtn(id: string, title: string, cur: number, set: (w: number) => void): ToolButton {
  return { id, title, icon: 'dk-weight', palette: { title, list: true, cols: 1, items: [0, 1, 2, 3, 4, 6, 8, 12, 16].map(w => ({ label: w ? `${w} px` : 'None', html: w ? `<svg viewBox="0 0 40 16" width="40"><path d="M2 8h36" stroke="currentColor" stroke-width="${Math.min(w, 12)}"/></svg>` : undefined, active: Math.round(cur) === w, action: () => set(w) })) } };
}

function dashBtn(id: string, title: string, cur: string, set: (d: 'solid' | 'dashed' | 'dotted') => void): ToolButton {
  const row = (d: string) => `<svg viewBox="0 0 40 16" width="40"><path d="M2 8h36" stroke="currentColor" stroke-width="2.4" stroke-linecap="${d === 'dotted' ? 'round' : 'butt'}" ${d === 'dashed' ? 'stroke-dasharray="7 4"' : d === 'dotted' ? 'stroke-dasharray="0.1 5"' : ''}/></svg>`;
  return { id, title, icon: 'dk-dash', palette: { title, list: true, cols: 1, items: (['solid', 'dashed', 'dotted'] as const).map(d => ({ label: d[0].toUpperCase() + d.slice(1), html: row(d), active: cur === d, action: () => set(d) })) } };
}

const lineSpacing = (st: SelItem['style'] | undefined) => {
  if (!st) return '';
  const lh = parseFloat(st.lineHeight), fs = parseFloat(st.fontSize);
  if (!lh || !fs) return '';
  const r = Math.round(lh / fs * 100) / 100;
  return ['1', '1.15', '1.5', '2'].find(v => Math.abs(Number(v) - r) < 0.03) ?? '';
};

const escHtml = (s: string) => s.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]!));
const escAttr = (s: string) => s.replace(/"/g, '&quot;');

import { ICONS } from '../app/Toolbar';
import { LYX_ICONS } from '../app/lyxicons';
/** an icon as markup for palette items */
function ICON(name: string): string {
  if (LYX_ICONS[name]) return `<img src="${LYX_ICONS[name]}" alt="" width="16" height="16" style="vertical-align:middle">`;
  return ICONS[name] ? `<span class="dk-ico">${ICONS[name]}</span>` : '';
}
const ICONSVG = {
  fill: '<path d="M3 7.5l4.5-4.5 4.5 4.5-4.5 4.5z" fill="currentColor" fill-opacity="0.25" stroke="currentColor" stroke-width="1.1"/><path d="M13 8.8c.6 1 1 1.6 1 2a1 1 0 0 1-2 0c0-.4.4-1 1-2z" fill="currentColor"/>',
  stroke: '<path d="M10.5 1.8l2.4 2.4-6.6 6.6-2.9.5.5-2.9z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>',
  highlight: '<path d="M4 9.5l5.5-5.5 2.3 2.3-5.5 5.5H4z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>',
};
