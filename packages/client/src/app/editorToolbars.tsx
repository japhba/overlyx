/** One toolbar definition for browser and VS Code; hosts supply document and navigation actions. */
import type { EditorView } from 'prosemirror-view';
import type { Command } from 'prosemirror-state';
import { undo, redo } from 'y-prosemirror';
import type { DocMeta } from '../api';
import { setPref, type Prefs } from '../prefs';
import { editorContext } from '../editor/context';
import { activeMathField, type LyxMathField } from '../editor/lyxmath/field';
import { ColorPalette, colorIcon, DelimPalette, TableSizePicker, mathPanelPalettes, mathPreview, type ToolButton, type DelimChoice, type Palette } from './Toolbar';
import * as C from '../editor/commands';
import * as T from '../editor/tablecommands';
import { acceptAllChanges, rejectAllChanges, gotoChange, resolveSelectionChanges, changesFilterKey, setChangesFilter } from '../editor/plugins/changes';

export type ToolbarId = 'standard' | 'viewupdate' | 'extra' | 'math' | 'mathpanels' | 'table' | 'review';
export type ToolbarMode = 'on' | 'off' | 'auto';
export interface EditorToolbarContext {
  view: EditorView | null; meta: DocMeta | null; prefs: Prefs; mathField: LyxMathField | null;
  aiComplete: boolean; inkMode: boolean; marginMode: boolean; outputChanges: boolean; tracking: boolean;
  showFiles: boolean; showMath: boolean; showReview: boolean; showTable: boolean;
  textColor: string | null; outlineTitle: string;
  run(command: Command): void; runView(command: (view: EditorView) => boolean): void;
  build(opts?: { open?: boolean }): void; syncToPdf(): void; toggleOutputChanges(): void;
  toggleMargin(): void; toggleTracking(): void; navBack(): void; openInTab(id: string): void;
  setDialog(dialog: { name: string; arg?: unknown }): void; setFindOpen(open: boolean): void;
  setInkMode(next: (current: boolean) => boolean): void; setShowFiles(next: boolean | ((current: boolean) => boolean)): void;
  notify(text: string, kind?: 'info' | 'error'): void; clipboard(op: 'cut' | 'copy' | 'paste'): void;
  insertDelim(choice: DelimChoice): void; mathExec(command: string, ...args: unknown[]): void;
  layoutBtn(id: string, name: string, title: string, icon: string): ToolButton;
  markActive(name: string, value: string): boolean;
  tbMode(id: ToolbarId): ToolbarMode; tbTogglePalette(id: ToolbarId, title: string): Palette;
  textStylesPalette: Palette; mathPanels: ReturnType<typeof mathPanelPalettes>;
  tableSt: ReturnType<typeof T.tableToolbarState> | null; changesFilterSt: ReturnType<typeof changesFilterKey.getState> | null;
}

const MATH_PANEL_PREVIEW: Record<string, string> = {
  functions: '\\sin', space: '\\square\\,\\square', 'sqrt-square': '\\sqrt{x}', style: '\\displaystyle\\textstyle', 'frac-square': '\\frac{a}{b}', font: '\\mathbb{R}', latex_dots: '\\cdots', latex_deco: '\\hat{a}',
  latex_arrow: '\\rightarrow', latex_bop: '\\otimes', latex_brel: '\\leq', latex_greek: '\\alpha', latex_misc: '\\infty', latex_varsz: '\\sum', latex_ams_misc: '\\square', latex_ams_arrows: '\\rightrightarrows',
  latex_ams_rel: '\\leqslant', latex_ams_nrel: '\\nleq', latex_ams_ops: '\\boxtimes', latex_delim: '\\lfloor\\rfloor',
};
const MATH_PANEL_ICONS: Record<string, string> = { style: 'Style' };

export function editorToolbars({ aiComplete, build, changesFilterSt, clipboard, inkMode, insertDelim, layoutBtn, marginMode, markActive, mathExec, mathField, mathPanels, meta, navBack, notify, openInTab, outputChanges, prefs, run, runView, setDialog, setFindOpen, setInkMode, setShowFiles, showFiles, showMath, showReview, showTable, syncToPdf, tableSt, tbMode, tbTogglePalette, textColor, textStylesPalette, toggleMargin, toggleTracking, tracking, view, outlineTitle, toggleOutputChanges }: EditorToolbarContext) {
  const standardGroups: ToolButton[][] = [
    [
      { id: 'new', title: 'New document (Ctrl+N)', icon: 'new', action: () => editorContext.ui?.newFile() },
      { id: 'open', title: 'Open (Ctrl+O)', icon: 'open', action: () => setShowFiles(true) },
    ],
    [
      { id: 'spellcheck', title: prefs.spellcheck ? 'Spell checking is on — click to switch it off' : 'Spell checking is off — click to switch it on', icon: 'spellcheck', action: () => setPref('spellcheck', !prefs.spellcheck), active: prefs.spellcheck },
    ],
    [
      { id: 'undo', title: 'Undo (Ctrl+Z)', icon: 'undo', action: () => run(undo) },
      { id: 'redo', title: 'Redo (Ctrl+Y)', icon: 'redo', action: () => run(redo) },
      { id: 'cut', title: 'Cut (Ctrl+X)', icon: 'cut', action: () => clipboard('cut') },
      { id: 'copy', title: 'Copy (Ctrl+C)', icon: 'copy', action: () => clipboard('copy') },
      { id: 'paste', title: 'Paste (Ctrl+V)', icon: 'paste', action: () => clipboard('paste') },
      { id: 'find', title: 'Find & replace (Ctrl+F)', icon: 'find', action: () => setFindOpen(true) },
      { id: 'navback', title: 'Navigate back (Ctrl+Alt+←)', icon: 'navback', action: navBack },
    ],
    [
      { id: 'emph', title: 'Emphasis (Ctrl+E)', icon: 'emph', action: () => run(C.fontCommands.emph), active: markActive('emph', 'on') },
      { id: 'noun', title: 'Noun / small caps (Ctrl+Shift+N)', icon: 'noun', action: () => run(C.fontCommands.noun), active: markActive('noun', 'on') },
      { id: 'charstyles', title: 'Custom text styles', icon: 'charstyles', palette: textStylesPalette },
      { id: 'italic', title: 'Italic (Ctrl+I)', icon: 'italic', action: () => run(C.fontCommands.italic), active: markActive('shape', 'italic') },
      { id: 'textcolor', title: textColor ? `Text colour: ${textColor}` : 'Text colour', icon: 'textcolor', html: colorIcon(textColor), active: !!textColor,
        palette: { title: 'Text colour', render: close => <ColorPalette current={textColor} close={close} onPick={c => run(C.setValueMark('color', c))} /> } },
    ],
    [
      { id: 'math', title: 'Inline formula (Ctrl+M)', icon: 'math', action: () => runView(C.insertMath(false)) },
      { id: 'dmath', title: 'Display formula (Ctrl+Shift+M)', icon: 'dmath', action: () => runView(C.insertMath(true)) },
      { id: 'graphics', title: 'Insert graphics (Ctrl+Shift+G)', icon: 'graphics', action: () => setDialog({ name: 'graphics' }) },
      { id: 'table', title: 'Insert table (Ctrl+Alt+T)', icon: 'table', palette: { title: 'Insert table', render: close => <TableSizePicker close={close} onPick={(r, c) => run(C.insertTable(r, c))} /> } },
      { id: 'flex', title: 'Custom insets (Flex)', icon: 'box', palette: { title: 'Custom insets of this document class', list: true, cols: 1, items: (meta?.flexInsets ?? []).map(n => ({ label: n, action: () => run(C.insertFlex(n)) })).concat([{ label: 'Other…', action: () => { const n = prompt('Flex inset name:', meta?.flexInsets?.[0] ?? 'Code'); if (n) run(C.insertFlex(n)); } }]) } },
    ],
    [
      { id: 'outline', title: outlineTitle, icon: 'outline', action: () => setShowFiles(s => !s), active: showFiles },
      { id: 'margin', title: 'Show notes & comments in the margin', icon: 'margin', action: toggleMargin, active: marginMode },
      { id: 'ink', title: inkMode ? 'Margin drawing is on — click to put the pen away' : 'Draw in the margins (pen, highlighter; pans sideways for more space)', icon: 'ink', action: () => setInkMode(m => !m), active: inkMode },
      // the ✦ button exists only once it is enabled in the preferences; it switches autocomplete (text + formulas) on and off
      ...(prefs.aiButton ? [{ id: 'ai', title: aiComplete ? 'AI autocomplete is on — click to switch it off' : 'AI autocomplete is off — click to switch it on (ghost text after a pause while typing; Tab inserts it)', icon: 'ai', action: () => { setPref('aiCompleteText', !aiComplete); setPref('aiCompleteMath', !aiComplete); notify(!aiComplete ? 'AI autocomplete on' : 'AI autocomplete off'); }, active: aiComplete } as ToolButton] : []),
      { id: 'tb-math', title: 'Show math toolbar', icon: 'mathtb', active: showMath, palette: tbTogglePalette('math', 'Show math toolbar') },
      { id: 'tb-table', title: 'Show table toolbar', icon: 'tabletb', active: showTable, palette: tbTogglePalette('table', 'Show table toolbar') },
      { id: 'tb-review', title: 'Show review toolbar', icon: 'reviewtb', active: showReview, palette: tbTogglePalette('review', 'Show review toolbar') },
    ],
  ];
  // The LyX View/Update toolbar: view / update the PDF (and the master's), SyncTeX forward search.
  const viewUpdateGroups: ToolButton[][] = [
    [
      { id: 'pdf', title: 'View PDF (Ctrl+R)', icon: 'view', action: () => build() },
      { id: 'update', title: 'Update the PDF without switching to the viewer', icon: 'update', action: () => { void build({ open: false }); } },
      ...(meta?.master ? [{ id: 'pdfmaster', title: `View master document (${meta.master.split('/').pop()})`, icon: 'viewmaster', action: () => openInTab(meta.master!) } as ToolButton] : []),
    ],
    [
      { id: 'outputsync', title: "Sync to PDF — show the cursor's place in the built PDF (Ctrl+Alt+J)", icon: 'outputsync', action: () => { void syncToPdf(); } },
    ],
  ];
  const extraGroups: ToolButton[][] = [
    [
      layoutBtn('l-standard', 'Standard', 'Default paragraph (Standard)', 'layout'),
      layoutBtn('l-enumerate', 'Enumerate', 'Numbered list (Alt+P E)', 'enumerate'),
      layoutBtn('l-itemize', 'Itemize', 'Itemized list (Alt+P I)', 'itemize'),
      layoutBtn('l-labeling', 'Labeling', 'Labeled list (Alt+P L)', 'labeling'),
      layoutBtn('l-description', 'Description', 'Description (Alt+P D)', 'description'),
      layoutBtn('l-section', 'Section', 'Section (Ctrl+2 · Alt+P 2)', 'section'),
      { id: 'depthin', title: 'Increase depth (Alt+Shift+→)', icon: 'depthin', action: () => run(C.changeDepth(1)) },
      { id: 'depthout', title: 'Decrease depth (Alt+Shift+←)', icon: 'depthout', action: () => run(C.changeDepth(-1)) },
    ],
    [
      { id: 'float', title: 'Insert figure float', icon: 'float', action: () => run(C.insertFloat('figure')) },
      { id: 'tablefloat', title: 'Insert table float', icon: 'tablefloat', action: () => run(C.insertFloat('table')) },
      { id: 'label', title: 'Label (Ctrl+Alt+L)', icon: 'label', action: () => setDialog({ name: 'label' }) },
      { id: 'ref', title: 'Cross-reference (Ctrl+Shift+I)', icon: 'ref', action: () => setDialog({ name: 'ref' }) },
      { id: 'cite', title: 'Citation (Ctrl+Shift+C)', icon: 'cite', action: () => setDialog({ name: 'cite' }) },
      { id: 'index', title: 'Index entry', icon: 'index', action: () => run(C.insertIndex) },
      { id: 'nomencl', title: 'Nomenclature entry', icon: 'nomencl', action: () => { const sym = prompt('Nomenclature symbol:'); if (!sym) return; const desc = prompt('Description:', '') ?? ''; run(C.insertCommand('nomenclature', ['LatexCommand nomenclature', 'prefix ""', `symbol "${sym.replace(/"/g, '\\"')}"`, `description "${desc.replace(/"/g, '\\"')}"`, 'literal "false"'])); } },
    ],
    [
      { id: 'footnote', title: 'Footnote (Ctrl+Alt+F)', icon: 'footnote', action: () => run(C.insertFootnote) },
      { id: 'marginal', title: 'Margin note (Ctrl+Alt+M)', icon: 'marginal', action: () => run(C.insertMarginal) },
      { id: 'note', title: 'LyX note (Ctrl+Alt+Shift+N)', icon: 'note', action: () => run(C.insertNote('Note')) },
      { id: 'comment', title: 'Comment thread (Ctrl+Alt+C)', icon: 'comment', action: () => run(C.insertComment) },
      { id: 'boxinset', title: 'Insert box', icon: 'boxinset', action: () => run(C.insertBox) },
      { id: 'href', title: 'Hyperlink (Ctrl+Alt+K)', icon: 'href', action: () => setDialog({ name: 'href' }) },
      { id: 'ert', title: 'TeX code (Ctrl+L)', icon: 'ert', action: () => run(C.insertERT) },
      { id: 'macro', title: 'Math macro definition', icon: 'macro', action: () => { const n = prompt('Macro name (without backslash):'); if (n) run(C.insertMacroDef(n, Number(prompt('Number of arguments:', '0') || 0), '')); } },
      { id: 'include', title: 'Include file (child document)', icon: 'include', action: () => { const fn = prompt('Child document file name (relative):', 'chapter1.tex'); if (fn) run(C.insertInclude(fn, 'include')); } },
    ],
    [
      { id: 'textstyle', title: 'Text properties', icon: 'textstyle', palette: textStylesPalette },
      { id: 'paragraph', title: 'Paragraph settings (Ctrl+Alt+P)', icon: 'paragraph', action: () => setDialog({ name: 'paragraph' }) },
    ],
  ];
  const mf = () => activeMathField();
  const mathGroups: ToolButton[][] = [
    [{ id: 'm-display', title: 'Toggle display / inline formula (Ctrl+Shift+M)', icon: 'display', active: !!mathField?.display, action: () => { const f = mf() as any; if (f?._toggleDisplay) f._toggleDisplay(); else run(C.toggleMathDisplay); } }],
    [
      { id: 'm-sub', title: 'Subscript (Alt+M X, _)', icon: 'sub', action: () => mathExec('moveToSubscript') },
      { id: 'm-sup', title: 'Superscript (Alt+M E, ^)', icon: 'sup', action: () => mathExec('moveToSuperscript') },
      { id: 'm-sqrt', title: 'Square root (Alt+M S)', icon: 'msqrt', action: () => mathExec('insert', '\\sqrt{#0}') },
      { id: 'm-root', title: 'Root (Alt+M R)', icon: 'mroot', action: () => mathExec('insert', '\\sqrt[]{#0}') },
      { id: 'm-frac', title: 'Fraction (Alt+M F)', icon: 'mfrac', action: () => mathExec('insert', '\\frac{#0}{}') },
      { id: 'm-sum', title: 'Sum (Alt+M U)', icon: 'msum', action: () => mathExec('insert', '\\sum') },
      { id: 'm-int', title: 'Integral (Alt+M I)', icon: 'mint', action: () => mathExec('insert', '\\int') },
      { id: 'm-prod', title: 'Product', icon: 'mprod', action: () => mathExec('insert', '\\prod') },
    ],
    [
      { id: 'm-paren', title: 'Insert ( ) (Alt+M ()', icon: '( )', html: mathPreview('\\left(\\square\\right)') ?? undefined, action: () => mathExec('delim', '(', ')') },
      { id: 'm-bracket', title: 'Insert [ ] (Alt+M [)', icon: '[ ]', html: mathPreview('\\left[\\square\\right]') ?? undefined, action: () => mathExec('delim', '[', ']') },
      { id: 'm-brace', title: 'Insert { } (Alt+M {)', icon: '{ }', html: mathPreview('\\left\\{\\square\\right\\}') ?? undefined, action: () => mathExec('delim', '\\{', '\\}') },
      { id: 'm-abs', title: 'Insert | | (Alt+M |)', icon: '| |', html: mathPreview('\\left|\\square\\right|') ?? undefined, action: () => mathExec('delim', '|', '|') },
      { id: 'm-angle', title: 'Insert ⟨ ⟩ (Alt+M <)', icon: '⟨ ⟩', html: mathPreview('\\left\\langle\\square\\right\\rangle') ?? undefined, action: () => mathExec('delim', '\\langle', '\\rangle') },
      { id: 'm-dangle', title: 'Insert ⟪ ⟫ (adds the \\llangle macro to the preamble)', icon: '⟪ ⟫', html: mathPreview('\\left\\langle\\mkern-4.5mu\\left\\langle\\square\\right\\rangle\\mkern-4.5mu\\right\\rangle') ?? undefined, action: () => insertDelim({ pair: { label: '⟪ ⟫', left: '\\llangle', right: '\\rrangle', title: '' }, size: '' }) },
      { id: 'm-delims', title: 'Delimiters of all sizes (\\left…\\right, \\big … \\Bigg)', icon: 'delimsize', palette: { title: 'Delimiters — rows: pair, columns: size', render: close => <DelimPalette close={close} onPick={insertDelim} onDialog={() => setDialog({ name: 'delimiters' })} /> } },
    ],
    [
      { id: 'm-matrix', title: 'Insert matrix…', icon: 'matrix', html: mathPreview('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}') ?? undefined, action: () => setDialog({ name: 'matrix' }) },
      { id: 'm-cases', title: 'Insert cases environment (Alt+M C)', icon: 'cases', html: mathPreview('\\cases') ?? undefined, action: () => mathExec('insert', '\\cases') },
      { id: 'm-addrow', title: 'Add row (matrix / align)', icon: 'addrow', disabled: !!mathField && !mathField.cursor.gridRowsOK(), action: () => mathExec('appendRow') },
      { id: 'm-addcol', title: 'Add column (matrix / align)', icon: 'addcol', disabled: !!mathField && !mathField.cursor.gridColsOK(), action: () => mathExec('appendColumn') },
      { id: 'm-delrow', title: 'Delete row', icon: 'delrow', disabled: !!mathField && !mathField.cursor.gridRowsOK(), action: () => mathExec('deleteRow') },
      { id: 'm-delcol', title: 'Delete column', icon: 'delcol', disabled: !!mathField && !mathField.cursor.gridColsOK(), action: () => mathExec('deleteColumn') },
    ],
    [
      { id: 'm-limits', title: 'Toggle limits placement (\\limits)', icon: 'lim', html: mathPreview('\\sum\\limits_{i}') ?? undefined, action: () => mathExec('limits') },
      { id: 'm-text', title: 'Text in formula (Ctrl+M)', icon: 'Tx', action: () => mathExec('text') },
      { id: 'tb-mathpanels', title: 'Show math panels', icon: 'mathpanelstb', active: tbMode('mathpanels') !== 'off', palette: tbTogglePalette('mathpanels', 'Show math panels') },
    ],
  ];
  const mathPanelGroups: ToolButton[][] = [mathPanels.map(p => ({ id: 'mp-' + p.id, title: p.title, icon: MATH_PANEL_ICONS[p.id] ?? p.title, html: MATH_PANEL_PREVIEW[p.id] ? mathPreview(MATH_PANEL_PREVIEW[p.id]) ?? undefined : undefined, palette: p.palette }))];
  const tableGroups: ToolButton[][] = [
    [
      { id: 't-addrow', title: 'Add row', icon: 'addrow', action: () => run(T.appendRow) },
      { id: 't-addcol', title: 'Add column', icon: 'addcol', action: () => run(T.appendColumn) },
      { id: 't-delrow', title: 'Delete row', icon: 'delrow', action: () => run(T.deleteRow) },
      { id: 't-delcol', title: 'Delete column', icon: 'delcol', action: () => run(T.deleteColumn) },
      { id: 't-rowup', title: 'Move row up', icon: 'rowup', action: () => run(T.moveRowUp) },
      { id: 't-colleft', title: 'Move column left', icon: 'colleft', action: () => run(T.moveColumnLeft) },
      { id: 't-rowdown', title: 'Move row down', icon: 'rowdown', action: () => run(T.moveRowDown) },
      { id: 't-colright', title: 'Move column right', icon: 'colright', action: () => run(T.moveColumnRight) },
    ],
    [
      { id: 't-top', title: 'Toggle top line', icon: 'linetop', active: !!tableSt?.lines.top, action: () => run(T.toggleLine('top')) },
      { id: 't-bottom', title: 'Toggle bottom line', icon: 'linebottom', active: !!tableSt?.lines.bottom, action: () => run(T.toggleLine('bottom')) },
      { id: 't-left', title: 'Toggle left line', icon: 'lineleft', active: !!tableSt?.lines.left, action: () => run(T.toggleLine('left')) },
      { id: 't-right', title: 'Toggle right line', icon: 'lineright', active: !!tableSt?.lines.right, action: () => run(T.toggleLine('right')) },
      { id: 't-border', title: 'Toggle border lines', icon: 'lineborder', action: () => run(T.toggleBorderLines) },
      { id: 't-inner', title: 'Toggle inner lines', icon: 'lineinner', action: () => run(T.toggleInnerLines) },
      { id: 't-all', title: 'Toggle all lines', icon: 'lineall', action: () => run(T.toggleAllLines) },
      { id: 't-none', title: 'Unset all lines', icon: 'linenone', action: () => run(T.unsetAllLines) },
      { id: 't-formal', title: 'Reset formal default lines (booktabs style)', icon: 'lineformal', action: () => run(T.resetFormalDefault) },
    ],
    [
      { id: 't-al', title: 'Align left', icon: 'alignleft', active: tableSt?.align === 'left', action: () => run(T.setAlignment('left')) },
      { id: 't-ac', title: 'Align center', icon: 'aligncenter', active: tableSt?.align === 'center', action: () => run(T.setAlignment('center')) },
      { id: 't-ar', title: 'Align right', icon: 'alignright', active: tableSt?.align === 'right', action: () => run(T.setAlignment('right')) },
      { id: 't-ad', title: 'Align on decimal', icon: 'aligndecimal', active: tableSt?.align === 'decimal', action: () => run(T.setAlignment('decimal')) },
    ],
    [
      { id: 't-vt', title: 'Align top', icon: 'valigntop', active: tableSt?.valign === 'top', action: () => run(T.setVAlignment('top')) },
      { id: 't-vm', title: 'Align middle', icon: 'valignmiddle', active: tableSt?.valign === 'middle', action: () => run(T.setVAlignment('middle')) },
      { id: 't-vb', title: 'Align bottom', icon: 'valignbottom', active: tableSt?.valign === 'bottom', action: () => run(T.setVAlignment('bottom')) },
    ],
    [
      { id: 't-rotcell', title: 'Rotate cell by 90° or unset rotation', icon: 'rotatecell', active: !!tableSt?.rotateCell, action: () => run(T.toggleRotateCell) },
      { id: 't-rottable', title: 'Rotate table by 90° or unset rotation', icon: 'rotatetable', active: !!tableSt?.rotateTable, action: () => run(T.toggleRotateTable) },
      { id: 't-mc', title: 'Set multi-column', icon: 'multicolumn', active: !!tableSt?.multicolumn, action: () => run(T.toggleMultiColumn) },
      { id: 't-mr', title: 'Set multi-row', icon: 'multirow', active: !!tableSt?.multirow, action: () => run(T.toggleMultiRow) },
      { id: 't-settings', title: 'Table settings…', icon: 'tablesettings', action: () => setDialog({ name: 'tablesettings' }) },
    ],
  ];
  const reviewGroups: ToolButton[][] = [
    [
      { id: 'r-track', title: 'Track changes (Ctrl+Shift+E)', icon: 'track', action: toggleTracking, active: tracking },
      { id: 'r-output', title: 'Show changes in output (\\output_changes)', icon: 'changesoutput', active: outputChanges, action: () => { toggleOutputChanges(); } },
    ],
    [
      { id: 'r-show-ins', title: 'Show insertions', icon: 'showinsertions', active: changesFilterSt?.showInsertions ?? true, action: () => view && setChangesFilter(view, { showInsertions: !(changesFilterSt?.showInsertions ?? true) }) },
      { id: 'r-show-del', title: 'Show deletions', icon: 'showdeletions', active: changesFilterSt?.showDeletions ?? true, action: () => view && setChangesFilter(view, { showDeletions: !(changesFilterSt?.showDeletions ?? true) }) },
    ],
    [
      { id: 'r-prev', title: 'Previous change', icon: 'changeprev', action: () => run(gotoChange(-1)) },
      { id: 'r-next', title: 'Next change', icon: 'changenext', action: () => run(gotoChange(1)) },
      { id: 'r-accept', title: 'Accept change inside selection / at cursor', icon: 'accept', action: () => run(resolveSelectionChanges(true)) },
      { id: 'r-reject', title: 'Reject change inside selection / at cursor', icon: 'reject', action: () => run(resolveSelectionChanges(false)) },
    ],
    [
      { id: 'r-acceptall', title: 'Accept all changes', icon: 'acceptall', action: () => { if (confirm('Accept all tracked changes?')) run(acceptAllChanges()); } },
      { id: 'r-rejectall', title: 'Reject all changes', icon: 'rejectall', action: () => { if (confirm('Reject all tracked changes?')) run(rejectAllChanges()); } },
    ],
    [
      { id: 'r-note', title: 'Insert note (Ctrl+Alt+Shift+N)', icon: 'note', action: () => run(C.insertNote('Note')) },
      { id: 'r-comment', title: 'Comment thread (Ctrl+Alt+C)', icon: 'comment', action: () => run(C.insertComment) },
    ],
  ];
  return { standardGroups, viewUpdateGroups, extraGroups, mathGroups, mathPanelGroups, tableGroups, reviewGroups };
}
