/**
 * The Modern interface's icons (uimode.ts): Lucide (ISC licence, licenses/lucide.txt) — one
 * consistent geometric line set on a 24-unit grid, drawn with a hairline-ish 1.6 stroke, by toolbar
 * button id (or icon name). The Classic interface keeps LyX's icons; a button without an entry here
 * keeps its own in both. Each entry is the inside of an <svg viewBox="0 0 24 24"> (iconSvg wraps it).
 */
import {
  LibraryBig, GalleryVerticalEnd, Undo2, Redo2, SpellCheck, Scissors, Copy, ClipboardPaste, Search, ArrowLeft, Italic, Bold, Underline, Strikethrough, Quote,
  Sigma, SquareFunction, Image, Table, Braces, PanelRight, SquareRadical, TableProperties, FilePenLine, FileText, RefreshCw,
  RefreshCcwDot, RemoveFormatting, EllipsisVertical, PenTool, ListTree, File, FolderOpen, Pilcrow, List, ListOrdered, ListChecks,
  ListIndentIncrease, ListIndentDecrease, Heading1, Frame, Tag, Bookmark, TextQuote, StickyNote, MessageSquarePlus, Square, Link,
  CodeXml, Variable, Files, Baseline, Subscript, Superscript, BetweenHorizontalEnd, TableRowsSplit, BetweenVerticalEnd,
  TableColumnsSplit, Check, X, CheckCheck, ListX, ChevronDown, ChevronUp, MousePointer2, TextCursorInput, Shapes, Spline,
  Crop, WandSparkles, Replace, Blend, Lock, Trash, SquareDashed, Layers, BringToFront, ArrowUpRight,
  SquareRoundCorner, Minus, MessageSquare, History, Sparkles, FileCode, Highlighter, CaseUpper, CaseSensitive,
  Presentation, Heading, SquareCode, SquareSigma, Type, Droplet, Scan, Ruler, PencilLine, Hash, Book, Sheet,
  SplinePointer, SquaresUnite, SquaresSubtract, SquaresIntersect, SquaresExclude, Combine, Split, VectorPolygon, VectorSquare,
  ArrowRightLeft, DiamondPlus, DiamondMinus, Diamond, CircleDot, Slash, Unlink, Link2, Pentagon, ChartSpline,
  LassoSelect, Pen, Eraser, Hand, Maximize2, Focus, SquareStack, LockOpen, Maximize, Minimize,
  FileType, FileType2, PanelsTopLeft, Globe, Brush, BookMarked, FileImage, Folder, Asterisk, Group, Ungroup, Layers2,
  TextAlignStart, TextAlignCenter, TextAlignEnd, TextAlignJustify, AlignCenterVertical, AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, Grid3x3, SquareDashedTopSolid, RotateCwSquare, RotateCw,
  ArrowUpToLine, ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, TableConfig, Parentheses, Pi, Radical, Omega,
  FilePen, FileDiff, GitCompare, GitBranch, GitCommitVertical, Eye, BookA, Shrink, SquareDot, Circle, Triangle, Star,
  Hexagon, MoveUpRight, RectangleHorizontal, SendToBack, ArrowUp, ArrowDown, SquarePlus, PaintBucket, AlignHorizontalJustifyCenter,
  FlipHorizontal2, Pencil, Grid2x2,
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
  index: N(Hash), footnote: N(Asterisk), marginal: N(PanelRight), note: N(StickyNote), comment: N(MessageSquarePlus),
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
  'dk-lock': N(Lock), 'dk-unlock': N(LockOpen), 'dk-fullscreen': N(Maximize), 'dk-fullscreen-exit': N(Minimize), 'dk-delete': N(Trash), 'dk-crop': N(Crop), 'dk-cropshape': N(Scan), 'dk-nobg': N(WandSparkles),
  // (the slide's Background and Layout are words, as Google Slides' are)
  'dk-replace': N(Replace), 'dk-undo': N(Undo2), 'dk-redo': N(Redo2), 'dk-master': N(SquareStack),
  'dk-cropaspect': N(SquareDashed), 'dk-highlight': N(Highlighter), 'dk-fill': N(Droplet), 'dk-pen': N(PencilLine), 'dk-draw': N(Pen), 'dk-ink-pen': N(Pen), 'dk-ink-hl': N(Highlighter), 'dk-ink-eraser': N(Eraser),
  'dk-duplicate': N(Copy), 'dk-present': N(Presentation), 'dk-code': N(FileCode),
  // LaTeX on slides: the list of references, steps (beamer's overlays)
  'dk-references': N(LibraryBig), 'dk-step': N(GalleryVerticalEnd), 'dk-group': N(Group), 'dk-ungroup': N(Ungroup), 'dk-objects': N(Layers2),
  // paths: the Bézier pen, Path ▸ (booleans, combine, object to path, simplify, reverse), editing nodes
  'dk-bezier': N(PenTool), 'dk-path': N(SplinePointer), 'dk-union': N(SquaresUnite), 'dk-difference': N(SquaresSubtract),
  'dk-intersection': N(SquaresIntersect), 'dk-exclusion': N(SquaresExclude), 'dk-combine': N(Combine), 'dk-breakapart': N(Split),
  'dk-topath': N(VectorSquare), 'dk-nodes': N(VectorPolygon), 'dk-simplify': N(ChartSpline), 'dk-reverse': N(ArrowRightLeft),
  'dk-node-add': N(DiamondPlus), 'dk-node-del': N(DiamondMinus), 'dk-node-corner': N(Diamond), 'dk-node-smooth': N(CircleDot),
  'dk-seg-line': N(Slash), 'dk-seg-curve': N(Spline), 'dk-node-break': N(Unlink), 'dk-node-join': N(Link2), 'dk-path-close': N(Pentagon),
  // the quick menu's Fit and Centre in the box (a text box or formula bigger than what it shows)
  'dk-fit': N(Shrink), 'dk-centre': N(SquareDot), 'dk-comment': N(MessageSquarePlus), 'dk-guides': N(Grid3x3), 'dk-placeholder': N(SquareDashed),
  // the shapes and lines (Shapes / Lines palettes, Draw's shapes) and the arrange palettes' items
  'dk-rect': N(RectangleHorizontal), 'dk-roundrect': '<rect x="2" y="5" width="20" height="14" rx="5"/>', 'dk-ellipse': '<ellipse cx="12" cy="12" rx="10" ry="7"/>',
  'dk-triangle': N(Triangle), 'dk-diamond': N(Diamond), 'dk-star': N(Star), 'dk-hexagon': N(Hexagon), 'dk-line': N(Slash), 'dk-arrow': N(MoveUpRight),
  'dk-align-objects': N(AlignHorizontalJustifyCenter), 'dk-rotate': N(RotateCw), 'dk-flip': N(FlipHorizontal2), 'dk-strike': N(Strikethrough), 'dk-clear': N(RemoveFormatting),
  // the Layout toolbar of beamer layout documents (layouttoolbar.tsx): as the deck's
  'ol-select': N(MousePointer2), 'ol-text': N(TextCursorInput), 'ol-shape': N(Shapes), 'ol-line': N(Slash), 'ol-arrow': N(MoveUpRight),
  'ol-pen': N(PenTool), 'ol-pencil': N(Pencil), 'ol-nodes': N(VectorPolygon), 'ol-crop': N(Crop), 'ol-image': N(Image), 'ol-tex': N(CodeXml),
  'ol-front': N(BringToFront), 'ol-forward': N(ArrowUp), 'ol-backward': N(ArrowDown), 'ol-back': N(SendToBack), 'ol-align': N(AlignHorizontalJustifyCenter),
  'ol-group': N(Group), 'ol-ungroup': N(Ungroup), 'ol-rotate': N(RotateCw), 'ol-lock': N(Lock), 'ol-fill': N(PaintBucket), 'ol-stroke': N(PencilLine),
  'ol-width': N(Minus), 'ol-dash': N(Ruler), 'ol-tips': N(ArrowUpRight), 'ol-boxstyle': N(SquareRoundCorner), 'ol-anim': N(GalleryVerticalEnd),
  'ol-page-add': N(SquarePlus), 'ol-page': N(RectangleHorizontal), 'ol-notes': N(StickyNote), 'ol-present': N(Presentation), 'ol-grid': N(Grid2x2), 'ol-objects': N(Layers2),
  // LyX's icon names (lyxicons.ts) that buttons and palettes still name — in Modern never LyX's drawings
  alignleft: N(TextAlignStart), aligncenter: N(TextAlignCenter), alignright: N(TextAlignEnd), alignjustify: N(TextAlignJustify), aligndecimal: N(AlignCenterVertical),
  valigntop: N(AlignVerticalJustifyStart), valignmiddle: N(AlignVerticalJustifyCenter), valignbottom: N(AlignVerticalJustifyEnd),
  lineall: N(Grid3x3), lineborder: '<rect x="3" y="3" width="18" height="18" rx="2"/>', linenone: N(SquareDashed), linetop: N(SquareDashedTopSolid),
  linebottom: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="2 3"/><path d="M3 21h18"/>',
  lineleft: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="2 3"/><path d="M3 3v18"/>',
  lineright: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="2 3"/><path d="M21 3v18"/>',
  lineinner: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="2 3"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  lineformal: '<path d="M3 4.5h18M3 9h18M3 19.5h18"/>',
  alllines: N(Grid3x3), borderlines: '<rect x="3" y="3" width="18" height="18" rx="2"/>', nolines: N(SquareDashed), formallines: '<path d="M3 4.5h18M3 9h18M3 19.5h18"/>',
  innerlines: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="2 3"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  multicolumn: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18M12 12v9"/>',
  multirow: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M12 12h9"/>',
  rotatecell: N(RotateCwSquare), rotatetable: N(RotateCw), rowup: N(ArrowUpToLine), rowdown: N(ArrowDownToLine),
  colleft: N(ArrowLeftToLine), colright: N(ArrowRightToLine), tablesettings: N(TableConfig), tabletb: N(TableProperties),
  mfrac: '<rect x="8" y="2.5" width="8" height="6" rx="1"/><path d="M4 12h16"/><rect x="8" y="15.5" width="8" height="6" rx="1"/>',
  mint: '<path d="M15.5 3.5c-1.8-1.2-3.8-.4-4 2l-1 13c-.2 2.4-2.2 3.2-4 2"/>',
  matrix: '<path d="M6 3.5H4v17h2M18 3.5h2v17h-2"/><rect x="8" y="7" width="3" height="3" rx=".5"/><rect x="13" y="7" width="3" height="3" rx=".5"/><rect x="8" y="14" width="3" height="3" rx=".5"/><rect x="13" y="14" width="3" height="3" rx=".5"/>',
  cases: N(Braces), delimsize: N(Parentheses), display: N(SquareSigma), mprod: N(Pi), msum: N(Sigma), mroot: N(Radical), msqrt: N(SquareRadical),
  mathtb: N(SquareRadical), mathpanelstb: N(Omega), sub: N(Subscript), sup: N(Superscript),
  itemize: N(List), enumerate: N(ListOrdered), description: N(ListTree), labeling: N(ListChecks), section: N(Heading1), layout: N(Pilcrow),
  accept: N(Check), acceptall: N(CheckCheck), reject: N(X), rejectall: N(ListX), changenext: N(ChevronDown),
  track: N(FilePen), changesoutput: N(FileDiff), reviewtb: N(FilePenLine), showdeletions: N(Strikethrough), showinsertions: N(Underline),
  vccompare: N(GitCompare), vcregister: N(GitBranch), vclog: N(GitCommitVertical), vccheckin: N(GitCommitVertical), vcrepoupdate: N(RefreshCw), view: N(Eye), viewmaster: N(Eye), updatemaster: N(RefreshCw),
  thesaurus: N(BookA), textcolor: N(Baseline), tt: N(CodeXml), hrule: N(Minus), inklaser: N(Focus), ai: N(Sparkles),
  // the whiteboard's palette (BoardEditor.tsx)
  'bd-select': N(MousePointer2), 'bd-lasso': N(LassoSelect), 'bd-pen': N(Pen), 'bd-highlighter': N(Highlighter), 'bd-eraser': N(Eraser),
  'bd-laser': N(Focus), 'bd-note': N(StickyNote), 'bd-image': N(Image), 'bd-finger': N(Hand), 'bd-fit': N(Maximize2),
  // the side rails (modern.css draws them as masks from these)
  'rail-comments': N(MessageSquare), 'rail-versions': N(History), 'rail-agent': N(Sparkles), 'rail-pdf': N(FileText),
  'rail-source': N(CodeXml), 'rail-outline': N(ListTree),
};

/** what a file or a project is, in the file tree and on the start page (FileBrowser's .ficon, Home's .hglyph) */
export const KIND_ICONS: Record<string, string> = {
  doc: N(FileText), tex: N(FileText), lyx: N(FileText), md: N(FileType), deck: N(Presentation), poster: N(PanelsTopLeft),
  page: N(Globe), html: N(Globe), board: N(Brush), bib: N(BookMarked), image: N(FileImage), pdf: N(FileType2), other: N(File),
  project: N(Folder), hello: N(Folder), group: N(Files),
};

/** an icon (an entry of MODERN_ICONS) as markup, for palette items and buttons drawn as HTML */
export const iconSvg = (icon: string, size = 18) =>
  `<svg class="tb-mdi" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
/** (the name toolbars.tsx knows it by) */
export const mdiSvg = iconSvg;
