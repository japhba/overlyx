/**
 * The Modern interface's icons (uimode.ts): Material Design Icons (@mdi/js, Apache-2.0) in Google's
 * monochrome outline style, by toolbar button id (or icon name). The Classic interface keeps LyX's
 * icons; a button without an entry here keeps its own in both.
 */
import * as M from '@mdi/js';

export const MODERN_ICONS: Record<string, string> = {
  // the standard row
  undo: M.mdiUndo, redo: M.mdiRedo, spellcheck: M.mdiSpellcheck, cut: M.mdiContentCut, copy: M.mdiContentCopy, paste: M.mdiContentPaste,
  find: M.mdiMagnify, navback: M.mdiArrowLeft, emph: M.mdiFormatTextVariantOutline, noun: M.mdiFormatLetterCaseUpper, italic: M.mdiFormatItalic,
  bold: M.mdiFormatBold, underline: M.mdiFormatUnderline, strikeout: M.mdiFormatStrikethroughVariant, charstyles: M.mdiFormatQuoteOpen,
  math: M.mdiSigma, dmath: M.mdiFunctionVariant, graphics: M.mdiImageOutline, table: M.mdiTable, flex: M.mdiCodeBraces,
  margin: M.mdiPageLayoutSidebarRight, 'tb-math': M.mdiSquareRoot, 'tb-table': M.mdiTableCog, 'tb-review': M.mdiFileDocumentEditOutline,
  pdf: M.mdiFilePdfBox, update: M.mdiRefresh, outputsync: M.mdiSync, 'font-clear': M.mdiFormatClear, 'modern-more': M.mdiDotsVertical,
  'modern-search': M.mdiMagnify, ink: M.mdiDraw, outline: M.mdiFormatListText, new: M.mdiFileOutline, open: M.mdiFolderOutline,
  // the extra row
  'l-standard': M.mdiFormatPilcrow, 'l-itemize': M.mdiFormatListBulleted, 'l-enumerate': M.mdiFormatListNumbered, 'l-labeling': M.mdiFormatListChecks,
  'l-description': M.mdiFormatListText, 'l-section': M.mdiFormatHeader1, depthin: M.mdiFormatIndentIncrease, depthout: M.mdiFormatIndentDecrease,
  float: M.mdiImageFrame, tablefloat: M.mdiTableLarge, label: M.mdiLabelOutline, ref: M.mdiBookmarkOutline, cite: M.mdiFormatQuoteClose,
  index: M.mdiFormatListGroup, footnote: M.mdiNoteTextOutline, marginal: M.mdiTextBoxOutline, note: M.mdiNoteOutline, comment: M.mdiCommentPlusOutline,
  boxinset: M.mdiSquareOutline, href: M.mdiLink, ert: M.mdiCodeTags, macro: M.mdiFunction, include: M.mdiFileDocumentMultipleOutline,
  textstyle: M.mdiFormatColorText, paragraph: M.mdiFormatParagraph,
  // math
  'm-sub': M.mdiFormatSubscript, 'm-sup': M.mdiFormatSuperscript, 'm-sqrt': M.mdiSquareRoot,
  // table
  addrow: M.mdiTableRowPlusAfter, delrow: M.mdiTableRowRemove, addcol: M.mdiTableColumnPlusAfter, delcol: M.mdiTableColumnRemove,
  // review
  'r-accept': M.mdiCheck, 'r-reject': M.mdiClose, 'r-acceptall': M.mdiCheckAll, 'r-rejectall': M.mdiCloseBoxMultipleOutline,
  'r-next': M.mdiChevronDown, 'r-prev': M.mdiChevronUp, 'r-note': M.mdiNoteOutline, 'r-comment': M.mdiCommentPlusOutline,
  // the deck toolbar (deliverable/decktoolbar.tsx)
  'dk-select': M.mdiCursorDefaultOutline, 'dk-text': M.mdiTextBoxEditOutline, 'dk-shapes': M.mdiShapeOutline, 'dk-lines': M.mdiVectorLine,
  'dk-image': M.mdiImageOutline, 'dk-formula': M.mdiSigma, 'dk-b': M.mdiFormatBold, 'dk-i': M.mdiFormatItalic, 'dk-u': M.mdiFormatUnderline,
  'dk-ul': M.mdiFormatListBulleted, 'dk-ol': M.mdiFormatListNumbered, 'dk-more-text': M.mdiFormatLineSpacing, 'dk-weight': M.mdiFormatLineWeight,
  'dk-dash': M.mdiFormatLineStyle, 'dk-lineweight': M.mdiFormatLineWeight, 'dk-linedash': M.mdiFormatLineStyle, 'dk-tips': M.mdiArrowRight,
  'dk-radius': M.mdiVectorSquare, 'dk-opacity': M.mdiOpacity, 'dk-shadow': M.mdiBoxShadow, 'dk-arrange': M.mdiArrangeBringForward,
  'dk-lock': M.mdiLockOutline, 'dk-delete': M.mdiDeleteOutline, 'dk-crop': M.mdiCrop, 'dk-cropshape': M.mdiVectorSquare, 'dk-nobg': M.mdiAutoFix,
  'dk-replace': M.mdiFileReplaceOutline, 'dk-bg': M.mdiImageArea, 'dk-canvas': M.mdiCheckerboard, 'dk-undo': M.mdiUndo, 'dk-redo': M.mdiRedo,
  'dk-cropaspect': M.mdiVectorSquare,
};

/** an icon as markup (for palette items) */
export const mdiSvg = (path: string, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
