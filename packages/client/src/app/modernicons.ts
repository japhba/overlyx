/**
 * The Modern interface's icons (uimode.ts): Lucide (ISC licence, licenses/lucide.txt) — one
 * consistent geometric line set on a 24-unit grid, drawn with a hairline-ish 1.6 stroke, by toolbar
 * button id (or icon name). The Classic interface keeps LyX's icons; a button without an entry here
 * keeps its own in both. Each entry is the inside of an <svg viewBox="0 0 24 24"> (iconSvg wraps it).
 */
import {
  Undo2, Redo2, SpellCheck, Scissors, Copy, ClipboardPaste, Search, ArrowLeft, Italic, Bold, Underline, Strikethrough, Quote,
  Sigma, SquareFunction, Image, Table, Braces, PanelRight, SquareRadical, TableProperties, FilePenLine, FileText, RefreshCw,
  RefreshCcwDot, RemoveFormatting, EllipsisVertical, PenTool, ListTree, File, FolderOpen, Pilcrow, List, ListOrdered, ListChecks,
  ListIndentIncrease, ListIndentDecrease, Heading1, Frame, Tag, Bookmark, TextQuote, StickyNote, MessageSquarePlus, Square, Link,
  CodeXml, Variable, Files, Baseline, Subscript, Superscript, BetweenHorizontalEnd, TableRowsSplit, BetweenVerticalEnd,
  TableColumnsSplit, Check, X, CheckCheck, ListX, ChevronDown, ChevronUp, MousePointer2, TextCursorInput, Shapes, Spline,
  Crop, WandSparkles, Replace, Grid2x2, Blend, Lock, Trash, SquareDashed, Layers, BringToFront, ArrowUpRight,
  SquareRoundCorner, Minus, MessageSquare, History, Sparkles, FileCode, Highlighter, PaintBucket, CaseUpper, CaseSensitive,
  Presentation, Heading, SquareCode, SquareSigma, Type, Droplet, Scan, Ruler, PencilLine, Hash, Book, Sheet,
  SplinePointer, SquaresUnite, SquaresSubtract, SquaresIntersect, SquaresExclude, Combine, Split, VectorPolygon, VectorSquare,
  ArrowRightLeft, DiamondPlus, DiamondMinus, Diamond, CircleDot, Slash, Unlink, Link2, Pentagon, ChartSpline,
  LassoSelect, Pen, Eraser, Hand, Maximize2, Focus,
} from 'lucide';

type IconNode = [string, Record<string, string | number | undefined>][];

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** a Lucide icon's elements as markup */
function inner(node: IconNode): string {
  return node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k, v]) => v !== undefined && k !== 'key').map(([k, v]) => `${k}="${esc(String(v))}"`).join(' ')}/>`).join('');
}

const N = (node: unknown): string => inner(node as IconNode);

export const MODERN_ICONS: Record<string, string> = {
  // the standard row
  undo: N(Undo2), redo: N(Redo2), spellcheck: N(SpellCheck), cut: N(Scissors), copy: N(Copy), paste: N(ClipboardPaste),
  find: N(Search), navback: N(ArrowLeft), emph: N(Type), noun: N(CaseUpper), italic: N(Italic),
  bold: N(Bold), underline: N(Underline), strikeout: N(Strikethrough), strike: N(Strikethrough), charstyles: N(CaseSensitive),
  math: N(Sigma), dmath: N(SquareSigma), graphics: N(Image), table: N(Table), flex: N(Braces),
  margin: N(PanelRight), 'tb-math': N(SquareRadical), 'tb-table': N(TableProperties), 'tb-review': N(FilePenLine),
  pdf: N(FileText), update: N(RefreshCw), outputsync: N(RefreshCcwDot), 'font-clear': N(RemoveFormatting), 'modern-more': N(EllipsisVertical),
  'modern-search': N(Search), ink: N(PenTool), outline: N(ListTree), new: N(File), open: N(FolderOpen),
  code: N(CodeXml), 'md-h': N(Heading), 'md-quote': N(TextQuote), 'md-codeblock': N(SquareCode),
  // the extra row
  'l-standard': N(Pilcrow), 'l-itemize': N(List), 'l-enumerate': N(ListOrdered), 'l-labeling': N(ListChecks),
  'l-description': N(ListTree), 'l-section': N(Heading1), depthin: N(ListIndentIncrease), depthout: N(ListIndentDecrease),
  float: N(Frame), tablefloat: N(Sheet), label: N(Tag), ref: N(Bookmark), cite: N(Quote),
  index: N(Hash), footnote: N(StickyNote), marginal: N(PanelRight), note: N(StickyNote), comment: N(MessageSquarePlus),
  boxinset: N(Square), href: N(Link), ert: N(CodeXml), macro: N(Variable), include: N(Files), nomencl: N(Book),
  textstyle: N(Baseline), paragraph: N(Pilcrow),
  // math
  'm-sub': N(Subscript), 'm-sup': N(Superscript), 'm-sqrt': N(SquareRadical), 'm-sum': N(Sigma),
  // table
  addrow: N(BetweenHorizontalEnd), delrow: N(TableRowsSplit), addcol: N(BetweenVerticalEnd), delcol: N(TableColumnsSplit),
  // review
  'r-accept': N(Check), 'r-reject': N(X), 'r-acceptall': N(CheckCheck), 'r-rejectall': N(ListX),
  'r-next': N(ChevronDown), 'r-prev': N(ChevronUp), 'r-note': N(StickyNote), 'r-comment': N(MessageSquarePlus),
  // the deck toolbar (deliverable/decktoolbar.tsx)
  'dk-select': N(MousePointer2), 'dk-text': N(TextCursorInput), 'dk-shapes': N(Shapes), 'dk-lines': N(Spline),
  'dk-image': N(Image), 'dk-formula': N(Sigma), 'dk-b': N(Bold), 'dk-i': N(Italic), 'dk-u': N(Underline),
  'dk-ul': N(List), 'dk-ol': N(ListOrdered), 'dk-more-text': N(Pilcrow), 'dk-weight': N(Minus),
  'dk-dash': N(Ruler), 'dk-lineweight': N(Minus), 'dk-linedash': N(Ruler), 'dk-tips': N(ArrowUpRight),
  'dk-radius': N(SquareRoundCorner), 'dk-opacity': N(Blend), 'dk-shadow': N(Layers), 'dk-arrange': N(BringToFront),
  'dk-lock': N(Lock), 'dk-delete': N(Trash), 'dk-crop': N(Crop), 'dk-cropshape': N(Scan), 'dk-nobg': N(WandSparkles),
  'dk-replace': N(Replace), 'dk-bg': N(PaintBucket), 'dk-canvas': N(Grid2x2), 'dk-undo': N(Undo2), 'dk-redo': N(Redo2),
  'dk-cropaspect': N(SquareDashed), 'dk-highlight': N(Highlighter), 'dk-fill': N(Droplet), 'dk-pen': N(PencilLine),
  'dk-duplicate': N(Copy), 'dk-present': N(Presentation), 'dk-code': N(FileCode),
  // paths: the Bézier pen, Path ▸ (booleans, combine, object to path, simplify, reverse), editing nodes
  'dk-bezier': N(PenTool), 'dk-path': N(SplinePointer), 'dk-union': N(SquaresUnite), 'dk-difference': N(SquaresSubtract),
  'dk-intersection': N(SquaresIntersect), 'dk-exclusion': N(SquaresExclude), 'dk-combine': N(Combine), 'dk-breakapart': N(Split),
  'dk-topath': N(VectorSquare), 'dk-nodes': N(VectorPolygon), 'dk-simplify': N(ChartSpline), 'dk-reverse': N(ArrowRightLeft),
  'dk-node-add': N(DiamondPlus), 'dk-node-del': N(DiamondMinus), 'dk-node-corner': N(Diamond), 'dk-node-smooth': N(CircleDot),
  'dk-seg-line': N(Slash), 'dk-seg-curve': N(Spline), 'dk-node-break': N(Unlink), 'dk-node-join': N(Link2), 'dk-path-close': N(Pentagon),
  // the whiteboard's palette (BoardEditor.tsx)
  'bd-select': N(MousePointer2), 'bd-lasso': N(LassoSelect), 'bd-pen': N(Pen), 'bd-highlighter': N(Highlighter), 'bd-eraser': N(Eraser),
  'bd-laser': N(Focus), 'bd-note': N(StickyNote), 'bd-image': N(Image), 'bd-finger': N(Hand), 'bd-fit': N(Maximize2),
  // the side rails (modern.css draws them as masks from these)
  'rail-comments': N(MessageSquare), 'rail-versions': N(History), 'rail-agent': N(Sparkles), 'rail-pdf': N(FileText),
  'rail-source': N(CodeXml), 'rail-outline': N(ListTree),
};

/** an icon (an entry of MODERN_ICONS) as markup, for palette items and buttons drawn as HTML */
export const iconSvg = (icon: string, size = 18) =>
  `<svg class="tb-mdi" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
/** (the name toolbars.tsx knows it by) */
export const mdiSvg = iconSvg;
