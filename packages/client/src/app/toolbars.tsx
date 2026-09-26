/**
 * The LyX toolbars of the OverLyX editor — standard, view/update, extra, math, math panels, table
 * and review (lib/ui/stdtoolbars.inc: LyX's items, order and icons; OverLyX's own buttons close
 * their groups) — built from a ToolbarContext the shell supplies. One definition for the web
 * client's Workspace (App.tsx) and the VS Code webview's EditorShell (packages/vscode): a button
 * added here appears in both. What only one shell has (its file browser, navigation history,
 * margin ink, the comments panel) goes into the slots. tests/parity.test.ts checks that no shell
 * keeps toolbar definitions of its own.
 */
import { useMemo } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { undo, redo } from 'y-prosemirror';
import { llanglePreamble, hasLlangleSnippet, definesLlangle } from '@overlyx/core';
import { api, type DocMeta } from '../api';
import { setPref, type Prefs } from '../prefs';
import { ColorPalette, colorIcon, DelimPalette, TableSizePicker, mathPanelPalettes, mathPreview, type ToolButton, type DelimChoice, type Palette } from './Toolbar';
import { activeMathField, type LyxMathField } from '../editor/lyxmath/field';
import { useMathRendererVersion } from '../editor/lyxmath/usemath';
import * as C from '../editor/commands';
import * as T from '../editor/tablecommands';
import { acceptAllChanges, rejectAllChanges, gotoChange, resolveSelectionChanges, hasChanges, changesFilterKey, setChangesFilter } from '../editor/plugins/changes';
import { pasteFromClipboard } from '../editor/clipmenu';
import { openLinkBoxFor, LINK_KEY } from '../editor/links';

export type ToolbarId = 'standard' | 'viewupdate' | 'extra' | 'vcs' | 'math' | 'mathpanels' | 'table' | 'review';
export type ToolbarMode = 'on' | 'off' | 'auto';
export type ToolbarPrefs = Partial<Record<ToolbarId, ToolbarMode>>;
/** LyX's default.ui: standard, view/update and extra on top, vcs off, the contextual rows automatic (docked at the bottom). */
export const DEFAULT_TOOLBARS: ToolbarPrefs = { standard: 'on', viewupdate: 'on', extra: 'on', vcs: 'off', math: 'auto', mathpanels: 'on', table: 'auto', review: 'auto' };
/** The toolbar modes kept in this browser (`ol.toolbars`), over the defaults. */
export function loadToolbarPrefs(): ToolbarPrefs {
  try { return { ...DEFAULT_TOOLBARS, ...JSON.parse(localStorage.getItem('ol.toolbars') || '{}') }; } catch { return { ...DEFAULT_TOOLBARS }; }
}

/** Button faces of the math panels (LyX shows a representative symbol) */
export const MATH_PANEL_PREVIEW: Record<string, string> = {
  functions: '\\sin', space: '\\square\\,\\square', 'sqrt-square': '\\sqrt{x}', style: '\\displaystyle\\textstyle', 'frac-square': '\\frac{a}{b}', font: '\\mathbb{R}', latex_dots: '\\cdots', latex_deco: '\\hat{a}',
  latex_arrow: '\\rightarrow', latex_bop: '\\otimes', latex_brel: '\\leq', latex_greek: '\\alpha', latex_misc: '\\infty', latex_varsz: '\\sum', latex_ams_misc: '\\square', latex_ams_arrows: '\\rightrightarrows',
  latex_ams_rel: '\\leqslant', latex_ams_nrel: '\\nleq', latex_ams_ops: '\\boxtimes', latex_delim: '\\lfloor\\rfloor',
};
export const MATH_PANEL_ICONS: Record<string, string> = { style: 'Style' };

export type EditorCommand = (state: any, dispatch: any, view?: any) => boolean;
export type Notify = (text: string, kind?: 'info' | 'error') => void;
export type MathPanel = { id: string; title: string; palette: Palette };

/** Buttons that exist in one shell only, placed where LyX's toolbars have their counterparts. */
export interface ToolbarSlots {
  /** the first group of the standard toolbar (the web client: new document, open) */
  leading?: ToolButton[];
  /** after Find in the editing group (the web client: navigate back) */
  navigation?: ToolButton[];
  /** before the margin button (the web client: the document / outline sidebar) */
  sidebars?: ToolButton[];
  /** after the margin button (the web client: ink, AI autocomplete; VS Code: the comments panel) */
  tools?: ToolButton[];
  /** after View / Update in the view/update toolbar (the web client: view the master document) */
  pdf?: ToolButton[];
}

export interface ToolbarContext {
  /** the editor the toolbars act on (the master, or a child of the combined view) */
  view: EditorView | null;
  docId: string | null;
  meta: DocMeta | null;
  headerLines: string[];
  prefs: Prefs;
  /** layout of the paragraph at the cursor */
  layout: string;
  /** the focused formula, if any */
  mathField: LyxMathField | null;
  tracking: boolean;
  marginMode: boolean;
  tbMode(id: ToolbarId): ToolbarMode;
  setToolbar(id: ToolbarId, mode: ToolbarMode): void;
  run(cmd: EditorCommand): void;
  runView(fn: (v: EditorView) => boolean): void;
  mathExec(cmd: string, ...args: unknown[]): void;
  mathPanels: MathPanel[];
  clipboard(op: 'cut' | 'copy' | 'paste'): void;
  setDialog(d: { name: string; arg?: unknown }): void;
  openFind(): void;
  notify: Notify;
  toggleTracking(): void;
  toggleMargin(): void;
  /** View: build the PDF and show it */
  build(): void;
  /** Update: rebuild without switching to the viewer (LyX's second button); absent where the viewer is its own panel anyway */
  updatePdf?: () => void;
  syncToPdf(): void;
  /** the document header changed on the server (Show changes in output) */
  onHeaderLines?: (lines: string[]) => void;
  slots?: ToolbarSlots;
}

export interface Toolbars {
  standard: ToolButton[][];
  viewUpdate: ToolButton[][];
  extra: ToolButton[][];
  math: ToolButton[][];
  mathPanels: ToolButton[][];
  table: ToolButton[][];
  review: ToolButton[][];
  /** the contextual toolbars' visibility: their mode, or (automatic) the cursor's context */
  showMath: boolean;
  showTable: boolean;
  showReview: boolean;
}

/* ---------------------------------------------------------------- helpers the shells share */

/** The font marks the toolbar reports: stored marks / marks at the caret, or the marks of the first selected text. */
export function cursorMarks(view: EditorView | null): readonly Mark[] {
  if (!view) return [];
  const { $from, empty } = view.state.selection;
  if (empty) return view.state.storedMarks ?? $from.marks();
  return $from.nodeAfter?.marks ?? $from.marks();
}
/** The value of a font mark at the cursor (null when unset). */
export function markValue(view: EditorView | null, name: string): string | null {
  return (cursorMarks(view).find(m => m.type.name === name)?.attrs.value as string | undefined) ?? null;
}

/** Run a math command in the focused formula, or open a new inline formula and run it there. */
export function mathExecutor(getView: () => EditorView | null | undefined): ToolbarContext['mathExec'] {
  return (cmd, ...args) => {
    const f = activeMathField();
    if (f) { f.execute(cmd, ...args); f.focus(); return; }
    const v = getView();
    if (v) { C.insertMath(false)(v); setTimeout(() => activeMathField()?.execute(cmd, ...args), 60); }
  };
}

/**
 * The math panel palettes (Toolbar.tsx), inserting through `mathExec`; memoised, like any palette
 * set — and made again with another math font, when the shell calling this re-renders (so do the
 * formula previews on its toolbar buttons).
 */
export function useMathPanels(mathExec: ToolbarContext['mathExec']): MathPanel[] {
  const version = useMathRendererVersion();
  return useMemo(() => mathPanelPalettes(it => { if (it.kind === 'size') mathExec('style', it.latex); else mathExec('insert', it.latex); }), [version]);
}

/** ⟪ ⟫ are no LaTeX / LyX delimiters: add the macro (once) to the preamble of the document (or its master). */
export async function ensureLlangle(o: Pick<ToolbarContext, 'docId' | 'meta' | 'headerLines' | 'notify'>): Promise<void> {
  if (!o.docId) return;
  try {
    const target = o.meta?.master ?? o.docId;
    let lines = o.headerLines;
    if (target !== o.docId) lines = (await api.header(target)).headerLines;
    const a = lines.indexOf('\\begin_preamble'), b = lines.indexOf('\\end_preamble');
    const preamble = a >= 0 && b > a ? lines.slice(a + 1, b).join('\n') : '';
    if (hasLlangleSnippet(preamble)) return;
    const defined = definesLlangle(preamble, Object.keys(o.meta?.macros ?? {}));
    await api.setHeader(target, { preamble: (preamble ? preamble.replace(/\s+$/, '') + '\n' : '') + llanglePreamble(defined) });
    o.notify(`Added the \\llangle / \\rrangle macro to the preamble of ${target.split('/').pop()}`);
  } catch (e) { o.notify('Could not add the \\llangle macro to the preamble: ' + (e as Error).message, 'error'); }
}

/** Insert a delimiter pair from the palette: plain, \left…\right, or a \big… size. */
export function insertDelimiter(o: Pick<ToolbarContext, 'mathExec' | 'docId' | 'meta' | 'headerLines' | 'notify'>, c: DelimChoice): void {
  if (c.pair.left === '\\llangle') void ensureLlangle(o);
  if (c.size === '') o.mathExec('delim', c.pair.left, c.pair.right);
  else if (c.size === 'none') o.mathExec('pair', c.pair.left, c.pair.right);
  else o.mathExec('bigdelim', `${c.size}l`, c.pair.left, `${c.size}r`, c.pair.right);
}

/** Cut / copy / paste from the toolbar: the formula's selection when a formula is focused, else the editor's; pasted images become graphics insets, table cells go in as with Ctrl+V. */
export function toolbarClipboard(getView: () => EditorView | null | undefined, notify: Notify): ToolbarContext['clipboard'] {
  return (op) => {
    const v = getView();
    if (!v) return;
    const f = activeMathField();
    if (op === 'paste') {
      const fallback = () => notify('Paste with Ctrl+V (the toolbar is not allowed to read the clipboard here)', 'error');
      // in a formula: the text, rows / cells copied from a grid cell by cell (the field's paste)
      if (f) { navigator.clipboard?.readText?.().then(t => { if (t) f.execute('paste', t); }).catch(fallback) ?? fallback(); return; }
      pasteFromClipboard(v).then(ok => { if (!ok) fallback(); }).catch(fallback);
      return;
    }
    if (f) { const c = f.cursor; const sel = c.selection ? c.grabSelection() : f.latex; void navigator.clipboard?.writeText(sel); if (op === 'cut' && c.selection) f.execute('insert', ''); return; }
    v.focus();
    document.execCommand(op);
  };
}

/** Text properties (LyX's custom text styles / Text Properties dialog): shared by the standard and extra toolbars. */
export function textStylesPalette(run: ToolbarContext['run']): Palette {
  return { title: 'Text properties', list: true, cols: 2, items: [
    ['Emphasis', 'emph'], ['Bold', 'bold'], ['Noun (small caps)', 'noun'], ['Underline', 'underline'], ['Strikeout', 'strikeout'], ['Typewriter', 'typewriter'], ['Sans serif', 'sans'], ['Italic', 'italic'], ['Slanted', 'slanted'], ['Small caps', 'smallcaps'], ['Double underline', 'uuline'], ['Wavy underline', 'uwave'], ['Crossed out', 'xout'],
  ].map(([l, k]) => ({ label: l, action: () => run((C.fontCommands as Record<string, any>)[k]) })).concat(
    [['Tiny', 'tiny'], ['Small', 'small'], ['Normal size', 'normal'], ['Large', 'large'], ['Huge', 'huge']].map(([l, v]) => ({ label: `Size: ${l}`, action: () => run(C.setValueMark('size', v === 'normal' ? null : v)) })),
    [{ label: 'Reset to default (Alt+C Space)', action: () => run(C.fontDefault) }]) };
}

/** LyX's toolbar-toggle popup (On / Off / Automatic) for a contextual toolbar. */
export function tbTogglePalette(ctx: Pick<ToolbarContext, 'tbMode' | 'setToolbar'>, id: ToolbarId, title: string): Palette {
  return {
    title, list: true, cols: 1, items: [
      { label: 'On', action: () => ctx.setToolbar(id, 'on'), active: ctx.tbMode(id) === 'on' },
      { label: 'Off', action: () => ctx.setToolbar(id, 'off'), active: ctx.tbMode(id) === 'off' },
      { label: 'Automatic', action: () => ctx.setToolbar(id, 'auto'), active: ctx.tbMode(id) === 'auto' },
    ],
  };
}

// whether a document has tracked changes: a linear scan, remembered per document version
const changesByDoc = new WeakMap<PMNode, boolean>();
export function docHasChanges(doc: PMNode): boolean {
  let v = changesByDoc.get(doc);
  if (v === undefined) { v = hasChanges(doc); changesByDoc.set(doc, v); }
  return v;
}

/* ---------------------------------------------------------------- the toolbars */

export function buildToolbars(ctx: ToolbarContext): Toolbars {
  const { view, docId, meta, prefs, layout, mathField, tracking, marginMode, tbMode, run, runView, mathExec, setDialog, notify } = ctx;
  const slots = ctx.slots ?? {};
  const markActive = (name: string, value: string) => cursorMarks(view).some(m => m.type.name === name && m.attrs.value === value);
  const textColor = markValue(view, 'color');
  const insertDelim = (c: DelimChoice) => insertDelimiter(ctx, c);
  const layoutBtn = (id: string, name: string, title: string, icon: string): ToolButton => ({ id, title, icon, action: () => run(C.setLayout(layout === name && name !== 'Standard' ? 'Standard' : name)), active: layout === name });
  const styles = textStylesPalette(run);
  const toggle = (id: ToolbarId, title: string) => tbTogglePalette(ctx, id, title);

  const inTable = !!view && !!C.tableContext(view.state);
  const tableSt = view ? T.tableToolbarState(view.state) : null;
  const changesFilterSt = view ? changesFilterKey.getState(view.state) : null;
  const showMath = tbMode('math') === 'on' || (tbMode('math') === 'auto' && !!mathField);
  const showTable = tbMode('table') === 'on' || (tbMode('table') === 'auto' && inTable);
  const showReview = tbMode('review') === 'on' || (tbMode('review') === 'auto' && (tracking || (!!view && docHasChanges(view.state.doc))));
  const outputChanges = ctx.headerLines.some(l => l === '\\output_changes true');

  const standard: ToolButton[][] = [
    ...(slots.leading?.length ? [slots.leading] : []),
    [
      { id: 'spellcheck', title: prefs.spellcheck ? 'Spell checking is on — click to switch it off' : 'Spell checking is off — click to switch it on', icon: 'spellcheck', action: () => setPref('spellcheck', !prefs.spellcheck), active: prefs.spellcheck },
    ],
    [
      { id: 'undo', title: 'Undo (Ctrl+Z)', icon: 'undo', action: () => run(undo) },
      { id: 'redo', title: 'Redo (Ctrl+Y)', icon: 'redo', action: () => run(redo) },
      { id: 'cut', title: 'Cut (Ctrl+X)', icon: 'cut', action: () => ctx.clipboard('cut') },
      { id: 'copy', title: 'Copy (Ctrl+C)', icon: 'copy', action: () => ctx.clipboard('copy') },
      { id: 'paste', title: 'Paste (Ctrl+V)', icon: 'paste', action: () => ctx.clipboard('paste') },
      { id: 'find', title: 'Find & replace (Ctrl+F)', icon: 'find', action: () => ctx.openFind() },
      ...(slots.navigation ?? []),
    ],
    [
      { id: 'emph', title: 'Emphasis (Ctrl+E)', icon: 'emph', action: () => run(C.fontCommands.emph), active: markActive('emph', 'on') },
      { id: 'noun', title: 'Noun / small caps (Ctrl+Shift+N)', icon: 'noun', action: () => run(C.fontCommands.noun), active: markActive('noun', 'on') },
      { id: 'charstyles', title: 'Custom text styles', icon: 'charstyles', palette: styles },
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
      ...(slots.sidebars ?? []),
      { id: 'margin', title: 'Show notes & comments in the margin', icon: 'margin', action: () => ctx.toggleMargin(), active: marginMode },
      ...(slots.tools ?? []),
      { id: 'tb-math', title: 'Show math toolbar', icon: 'mathtb', active: showMath, palette: toggle('math', 'Show math toolbar') },
      { id: 'tb-table', title: 'Show table toolbar', icon: 'tabletb', active: showTable, palette: toggle('table', 'Show table toolbar') },
      { id: 'tb-review', title: 'Show review toolbar', icon: 'reviewtb', active: showReview, palette: toggle('review', 'Show review toolbar') },
    ],
  ];

  // The LyX View/Update toolbar: view / update the PDF (and the master's), SyncTeX forward search.
  const viewUpdate: ToolButton[][] = [
    [
      { id: 'pdf', title: 'View PDF (Ctrl+R)', icon: 'view', action: () => ctx.build() },
      ...(ctx.updatePdf ? [{ id: 'update', title: 'Update the PDF without switching to the viewer', icon: 'update', action: () => ctx.updatePdf!() } as ToolButton] : []),
      ...(slots.pdf ?? []),
    ],
    [
      { id: 'outputsync', title: "Sync to PDF — show the cursor's place in the built PDF (Ctrl+Alt+J)", icon: 'outputsync', action: () => ctx.syncToPdf() },
    ],
  ];

  const extra: ToolButton[][] = [
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
      { id: 'href', title: `Link (${LINK_KEY})`, icon: 'href', action: () => runView(openLinkBoxFor) },
      { id: 'ert', title: 'TeX code (Ctrl+L)', icon: 'ert', action: () => run(C.insertERT) },
      { id: 'macro', title: 'Math macro definition', icon: 'macro', action: () => { const n = prompt('Macro name (without backslash):'); if (n) run(C.insertMacroDef(n, Number(prompt('Number of arguments:', '0') || 0), '')); } },
      { id: 'include', title: 'Include file (child document)', icon: 'include', action: () => { const fn = prompt('Child document file name (relative):', 'chapter1.tex'); if (fn) run(C.insertInclude(fn, 'include')); } },
    ],
    [
      { id: 'textstyle', title: 'Text properties', icon: 'textstyle', palette: styles },
      { id: 'paragraph', title: 'Paragraph settings (Ctrl+Alt+P)', icon: 'paragraph', action: () => setDialog({ name: 'paragraph' }) },
    ],
  ];

  const mf = () => activeMathField();
  const math: ToolButton[][] = [
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
      { id: 'm-delim-grow', title: 'Larger delimiters around the cursor: ( ) → \\big → \\Big → \\bigg → \\Bigg → \\left…\\right', icon: '( )↑', action: () => mathExec('delimSize', 1) },
      { id: 'm-delim-shrink', title: 'Smaller delimiters around the cursor: \\left…\\right → \\Bigg → \\bigg → \\Big → \\big → ( )', icon: '( )↓', action: () => mathExec('delimSize', -1) },
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
      { id: 'm-text', title: 'Text in formula; inside text, math again (Ctrl+M)', icon: 'Tx', action: () => mathExec('text') },
      { id: 'tb-mathpanels', title: 'Show math panels', icon: 'mathpanelstb', active: tbMode('mathpanels') !== 'off', palette: toggle('mathpanels', 'Show math panels') },
    ],
  ];

  const mathPanels: ToolButton[][] = [ctx.mathPanels.map(p => ({ id: 'mp-' + p.id, title: p.title, icon: MATH_PANEL_ICONS[p.id] ?? p.title, html: MATH_PANEL_PREVIEW[p.id] ? mathPreview(MATH_PANEL_PREVIEW[p.id]) ?? undefined : undefined, palette: p.palette }))];

  const table: ToolButton[][] = [
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

  const review: ToolButton[][] = [
    [
      { id: 'r-track', title: 'Track changes (Ctrl+Shift+E)', icon: 'track', action: () => ctx.toggleTracking(), active: tracking },
      { id: 'r-output', title: 'Show changes in output (\\output_changes)', icon: 'changesoutput', active: outputChanges, action: () => {
        if (!docId) return;
        api.setHeader(docId, { set: { output_changes: outputChanges ? 'false' : 'true' } })
          .then(r => { ctx.onHeaderLines?.(r.headerLines); notify(outputChanges ? 'Changes are no longer shown in the output' : 'Changes are shown in the output (needs the ulem/xcolor packages)'); })
          .catch(e => notify(String(e), 'error'));
      } },
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

  return { standard, viewUpdate, extra, math, mathPanels, table, review, showMath, showTable, showReview };
}
