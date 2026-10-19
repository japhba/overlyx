/** Editing commands shared by the browser and VS Code. Add document features here once. */
import { insertDrawing } from '../editor/svgdrawing';
import type { EditorView } from 'prosemirror-view';
import type { Command } from 'prosemirror-state';
import { undo, redo } from '../editor/collab';
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, mergeCells, splitCell } from 'prosemirror-tables';
import type { DocMeta } from '../api';
import type { MenuDef, MenuEntry } from './MenuBar';
import { NAMED_COLORS, TABLE_WIDTHS } from './Toolbar';
import * as C from '../editor/commands';
import * as T from '../editor/tablecommands';
import { fixTableColumnWidths } from '../editor/tablefit';
import { isMac } from '../editor/keymap';
import { moveSection, shiftSection } from '../editor/outline';
import { changeAt, resolveChange, acceptAllChanges, rejectAllChanges } from '../editor/plugins/changes';
import { openLinkBoxFor, LINK_KEY } from '../editor/links';
import { uiPrompt } from './Dialogs';
import { styleLabel } from './stylenames';
import { isMarkdownDoc, insertCodeBlock, insertRule } from '../editor/markdown';
import { viewDocId } from '../editor/context';

const SECTION_LAYOUTS: [string, string][] = [['0', 'Part'], ['1', 'Chapter'], ['2', 'Section'], ['3', 'Subsection'], ['4', 'Subsubsection'], ['5', 'Paragraph'], ['6', 'Subparagraph']];
export interface DocumentMenuContext {
  view: EditorView | null; meta: DocMeta | null;
  run(command: Command): void;
  runView(command: (view: EditorView) => boolean): void;
  setDialog(dialog: { name: string; arg?: unknown }): void;
  setFindOpen(open: boolean): void;
  textColor: string | null; tracking: boolean; changeInfo: string | null;
  toggleTracking(): void; toggleCellLine(key: string): void;
  healthItems: MenuEntry[]; reloadMetadata(): void;
}

export function documentMenus({ view, meta, run, runView, setDialog, textColor, tracking, changeInfo, toggleTracking, toggleCellLine, healthItems, reloadMetadata, setFindOpen }: DocumentMenuContext): { edit: MenuDef; insert: MenuDef; document: MenuDef } {
  // a markdown document: only what markdown can write (editor/markdown.ts)
  const markdown = meta?.format === 'markdown' || (!!view && isMarkdownDoc(viewDocId(view)));
  const tex = <T,>(entries: T[]): T[] => (markdown ? [] : entries);
  const tableWidth = view && !markdown ? T.tableToolbarState(view.state).tableWidth : null;
  // the Table entries act on the table the cursor is in: greyed out anywhere else
  const inTable = !!view && !!C.tableContext(view.state);
  const tableOnly = (entries: MenuEntry[]): MenuEntry[] => (inTable ? entries : entries.map(e => (e.sep ? e : { ...e, disabled: true })));
  const md = <T,>(entries: T[]): T[] => (markdown ? entries : []);
  // the Modern interface assumes nobody comes from LyX: plain names (the Classic label stays the
  // entry's id, so custom keys and the statistics carry over), and LyX's own devices are left out
  const modern = typeof document !== 'undefined' && document.documentElement.dataset.ui === 'modern';
  const plain = (classic: string, simple: string): { label: string; id?: string } => (modern ? { label: simple, id: classic } : { label: classic });
  const lyxOnly = <T,>(entries: T[]): T[] => (modern ? [] : entries);
  return {
    edit: { title: 'Edit', items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', action: () => run(undo) },
      { label: 'Redo', shortcut: 'Ctrl+Y', action: () => run(redo) },
      { sep: true },
      { label: 'Find & Replace…', shortcut: 'Ctrl+F', action: () => setFindOpen(true) },
      { ...plain('Select inset / all', 'Select all'), shortcut: 'Ctrl+A', action: () => run(C.selectInset) },
      { sep: true },
      { label: 'Text Style ▸', sub: [
        { label: 'Emphasized', shortcut: 'Ctrl+E', action: () => run(C.fontCommands.emph) },
        { label: 'Italic', shortcut: 'Ctrl+I', action: () => run(C.fontCommands.italic) },
        { label: 'Bold', shortcut: 'Ctrl+B', action: () => run(C.fontCommands.bold) },
        ...tex([{ ...plain('Noun (small caps)', 'Name (small caps)'), shortcut: 'Ctrl+Shift+N', action: () => run(C.fontCommands.noun) }]),
        { label: 'Underline', shortcut: 'Ctrl+U', action: () => run(C.fontCommands.underline) },
        { label: markdown ? 'Strikethrough' : 'Strikeout', shortcut: 'Ctrl+Shift+O', action: () => run(C.fontCommands.strikeout) },
        { label: markdown ? 'Code' : 'Typewriter', action: () => run(C.fontCommands.typewriter) },   // Ctrl+Shift+P is the command palette
        ...tex([
          { label: 'Sans serif', action: () => run(C.fontCommands.sans) },
          { label: 'Small caps shape', action: () => run(C.fontCommands.smallcaps) },
          { label: 'Double underline', action: () => run(C.fontCommands.uuline) },
          { label: 'Wavy underline', action: () => run(C.fontCommands.uwave) },
          { sep: true },
          ...['tiny', 'scriptsize', 'footnotesize', 'small', 'normal', 'large', 'larger', 'largest', 'huge', 'giant'].map(s => ({ label: 'Size: ' + s, action: () => run(C.setValueMark('size', s === 'normal' ? null : s)) })),
          { sep: true },
          ...['red', 'blue', 'green', 'magenta', 'cyan', 'orange', 'purple', 'gray', 'none'].map(c => ({ label: 'Color: ' + c, action: () => run(C.setValueMark('color', c === 'none' ? null : c)) })),
        ]),
        { sep: true },
        { label: 'Reset font', shortcut: 'Ctrl+Alt+D', action: () => run(C.fontDefault) },
      ] },
      ...tex<MenuEntry>([{ label: 'Text colour ▸', sub: [
        { label: 'Default (no colour)', checked: !textColor, action: () => run(C.setValueMark('color', null)) },
        { sep: true },
        ...NAMED_COLORS.map(([name]) => ({ label: name[0].toUpperCase() + name.slice(1), checked: textColor === name, action: () => run(C.setValueMark('color', name)) })),
        { sep: true },
        { label: 'Custom colour… (palette on the toolbar)', checked: !!textColor && textColor.startsWith('#'), action: () => (document.querySelector('[data-tb="textcolor"]') as HTMLButtonElement | null)?.click() },
      ] }]),
      { label: 'Paragraph ▸', sub: [
        ...tex<MenuEntry>([
          { label: 'Paragraph settings…', shortcut: 'Ctrl+Alt+P', action: () => setDialog({ name: 'paragraph' }) },
          { sep: true },
          { label: 'Align left', shortcut: 'Alt+A L', action: () => run(C.setParagraphAttrs({ align: 'left' })) },
          { label: 'Align center', shortcut: 'Alt+A C', action: () => run(C.setParagraphAttrs({ align: 'center' })) },
          { label: 'Align right', shortcut: 'Alt+A R', action: () => run(C.setParagraphAttrs({ align: 'right' })) },
          { label: 'Justified', shortcut: 'Alt+A J', action: () => run(C.setParagraphAttrs({ align: 'block' })) },
          { label: 'Default alignment', shortcut: 'Alt+A E', action: () => run(C.setParagraphAttrs({ align: null })) },
          { label: 'Toggle indentation', shortcut: 'Alt+A I', action: () => { const p = view && C.currentParagraph(view.state); if (p) run(C.setParagraphAttrs({ noindent: !p.node.attrs.noindent })); } },
          { sep: true },
        ]),
        { ...plain('Increase depth', 'Nest deeper (indent)'), shortcut: 'Alt+Shift+→', action: () => run(C.changeDepth(1)) },
        { ...plain('Decrease depth', 'Nest less deep (outdent)'), shortcut: 'Alt+Shift+←', action: () => run(C.changeDepth(-1)) },
        { label: 'Move paragraph up', shortcut: 'Alt+↑', action: () => run(C.moveParagraph(-1)) },
        { label: 'Move paragraph down', shortcut: 'Alt+↓', action: () => run(C.moveParagraph(1)) },
        { sep: true },
        { label: 'Move section up', action: () => run(moveSection(-1)) },
        { label: 'Move section down', action: () => run(moveSection(1)) },
        { label: 'Promote section (heading level up)', action: () => run(shiftSection(-1, undefined, meta?.layouts)) },
        { label: 'Demote section (heading level down)', action: () => run(shiftSection(1, undefined, meta?.layouts)) },
      ] },
      // Google-Docs-style: Ctrl+digit sets a heading level (LyX's Alt+P digits), Ctrl+Alt+digit the unnumbered one
      ...md<MenuEntry>([{ label: 'Paragraph style ▸', sub: [
        { label: 'Normal text', shortcut: 'Alt+P S', action: () => run(C.setKnownLayout('Standard')) },
        { sep: true },
        ...[['2', 'Section'], ['3', 'Subsection'], ['4', 'Subsubsection'], ['5', 'Paragraph'], ['6', 'Subparagraph']].map(([digit, name], i) => ({ label: `Heading ${i + 1} (${'#'.repeat(i + 1)})`, shortcut: 'Ctrl+' + digit, action: () => run(C.setKnownLayout(name)) })),
        { sep: true },
        { label: 'Bullet list (or type “- ”)', shortcut: 'Alt+P I', action: () => run(C.setKnownLayout('Itemize')) },
        { label: 'Numbered list (or type “1. ”)', shortcut: 'Alt+P E', action: () => run(C.setKnownLayout('Enumerate')) },
        { label: 'Quote (or type “> ”)', shortcut: 'Alt+P Q', action: () => run(C.setKnownLayout('Quote')) },
        { label: 'Code block (or type ``` and Enter)', action: () => run(insertCodeBlock) },
      ] }]),
      ...tex<MenuEntry>([{ label: 'Paragraph style ▸', sub: [
        { ...plain('Standard', 'Normal text'), shortcut: 'Alt+P S', action: () => run(C.setKnownLayout('Standard')) },
        { sep: true },
        ...SECTION_LAYOUTS.map(([digit, name]) => ({ label: name, shortcut: 'Ctrl+' + digit, action: () => run(C.setKnownLayout(name)) })),
        { sep: true },
        ...SECTION_LAYOUTS.map(([digit, name]) => ({ ...plain(name + '* (unnumbered)', styleLabel(name + '*', 'modern')), shortcut: 'Ctrl+Alt+' + digit, action: () => run(C.setKnownLayout(name + '*')) })),
        { sep: true },
        { ...plain('Itemize (bullet list — or type “- ”)', 'Bullet list (or type “- ”)'), shortcut: 'Alt+P I', action: () => run(C.setKnownLayout('Itemize')) },
        { ...plain('Enumerate (numbered list — or type “1. ”)', 'Numbered list (or type “1. ”)'), shortcut: 'Alt+P E', action: () => run(C.setKnownLayout('Enumerate')) },
        { ...plain('Description', 'Description list'), shortcut: 'Alt+P D', action: () => run(C.setKnownLayout('Description')) },
        { label: 'Quote', shortcut: 'Alt+P Q', action: () => run(C.setKnownLayout('Quote')) },
        { ...plain('LyX-Code', 'Code'), shortcut: 'Alt+P C', action: () => run(C.setKnownLayout('LyX-Code')) },
      ] }]),
      { label: 'Table ▸', sub: tableOnly([
        { label: 'Add row above', action: () => run(addRowBefore) }, { label: 'Add row below', action: () => run(addRowAfter) },
        { label: 'Add column before', action: () => run(addColumnBefore) }, { label: 'Add column after', action: () => run(addColumnAfter) },
        { label: 'Delete row', action: () => run(deleteRow) }, { label: 'Delete column', action: () => run(deleteColumn) },
        ...tex<MenuEntry>([
          { label: 'Merge cells (multicolumn)', action: () => run(mergeCells) }, { label: 'Split cell', action: () => run(splitCell) },
          { sep: true },
          { label: 'Top line on/off', action: () => toggleCellLine('topline') }, { label: 'Bottom line on/off', action: () => toggleCellLine('bottomline') },
          { label: 'Left line on/off', action: () => toggleCellLine('leftline') }, { label: 'Right line on/off', action: () => toggleCellLine('rightline') },
        ]),
        { label: markdown ? 'Align column left' : 'Align cell left', action: () => run(markdown ? T.setAlignment('left') : C.setCellAttr('alignment', 'left')) },
        { label: markdown ? 'Align column center' : 'Align cell center', action: () => run(markdown ? T.setAlignment('center') : C.setCellAttr('alignment', 'center')) },
        { label: markdown ? 'Align column right' : 'Align cell right', action: () => run(markdown ? T.setAlignment('right') : C.setCellAttr('alignment', 'right')) },
        ...tex<MenuEntry>([
          { sep: true },
          { label: 'Column: natural width (l c r, no wrapping)', action: () => run(T.setColumnWidth('natural')) },
          { label: 'Column: wrap text, filling the table width (X)', action: () => run(T.setColumnWidth('variable')) },
          // the whole table at once (Word's AutoFit)
          ...TABLE_WIDTHS.map(([k, name]): MenuEntry => ({ label: 'Table: ' + name.toLowerCase(), checked: tableWidth === k, action: () => (k === 'fixed' ? runView(fixTableColumnWidths) : run(T.setTableColumnWidths(k))) })),
        ]),
        { sep: true },
        { label: 'Delete table', action: () => run(deleteTable) },
        ...tex<MenuEntry>([
          { sep: true },
          { label: 'Table settings…', action: () => setDialog({ name: 'tablesettings' }) },
        ]),
      ]) },
      { label: 'Track Changes ▸', sub: [
        { label: 'Track changes', shortcut: 'Ctrl+Shift+E', checked: tracking, action: toggleTracking },
        { label: 'Accept change at cursor', disabled: !changeInfo, action: () => { const v = view; if (!v) return; const ch = changeAt(v.state, v.state.selection.from); if (ch) run(resolveChange(ch, true)); } },
        { label: 'Reject change at cursor', disabled: !changeInfo, action: () => { const v = view; if (!v) return; const ch = changeAt(v.state, v.state.selection.from); if (ch) run(resolveChange(ch, false)); } },
        { sep: true },
        { label: 'Accept all changes', action: () => run(acceptAllChanges()) },
        { label: 'Reject all changes', action: () => run(rejectAllChanges()) },
      ] },
      { sep: true },
      ...healthItems,
      { ...plain('Inset settings…', 'Settings of the item at the cursor…'), shortcut: 'Ctrl+Alt+Shift+I', action: () => setDialog({ name: 'inset' }) },
      { ...plain('Open/close inset', 'Open / close (footnote, note, box …)'), shortcut: 'Ctrl+Alt+I', action: () => run(C.toggleInset) },
      { label: 'Math: toggle inline/display', action: () => run(C.toggleMathDisplay) },
    ] },
    insert: markdown ? { title: 'Insert', items: [
      { label: 'Math ▸', sub: [
        { label: 'Inline formula ($…$)', shortcut: 'Ctrl+M', action: () => runView(C.insertMathFromUi(false)) },
        { label: 'Display formula ($$…$$)', shortcut: 'Ctrl+Shift+M', action: () => runView(C.insertMathFromUi(true)) },
        { label: 'Numbered equation', shortcut: 'Ctrl+Alt+N', action: () => runView(C.insertMathFromUi(true, 'equation')) },
        { label: 'AMS align environment', shortcut: 'Alt+M T A', action: () => runView(C.insertMathFromUi(true, 'align')) },
        { label: 'AMS gather', action: () => runView(C.insertMathFromUi(true, 'gather')) },
        { sep: true },
        { label: 'Delimiters…', action: () => setDialog({ name: 'delimiters' }) },
        { label: 'Matrix…', action: () => setDialog({ name: 'matrix' }) },
      ] },
      { label: 'Special Character ▸', sub: [
        { label: 'Ellipsis …', shortcut: 'Alt+.', action: () => run(C.insertSpecial('ldots')) },
        { label: 'En dash –', ...(isMac() ? {} : { shortcut: 'Alt+Shift+-' }), action: () => run(C.insertDash('en')) },
        { label: 'Em dash —', shortcut: 'Alt+-', action: () => run(C.insertDash('em')) },
        { label: 'Opening quote', action: () => run(C.insertQuote('l')) }, { label: 'Closing quote', action: () => run(C.insertQuote('r')) },
      ] },
      { label: 'Line break', shortcut: 'Ctrl+Enter', action: () => run(C.insertNewline('newline')) },
      { sep: true },
      { label: 'Link…', shortcut: LINK_KEY, action: () => runView(openLinkBoxFor) },
      { label: 'Image…', shortcut: 'Ctrl+Shift+G', action: () => setDialog({ name: 'graphics' }) },
      { label: 'Table…', shortcut: 'Ctrl+Alt+T', action: () => setDialog({ name: 'table' }) },
      { label: 'Footnote', shortcut: 'Ctrl+Alt+F', action: () => run(C.insertFootnote) },
      { label: 'Code block', action: () => run(insertCodeBlock) },
      { label: 'Horizontal rule', action: () => run(insertRule) },
      { sep: true },
      { label: 'Comment thread', shortcut: 'Ctrl+Alt+C', action: () => run(C.insertComment) },
      { label: 'Hidden note (HTML comment)', shortcut: 'Ctrl+Alt+Shift+N', action: () => run(C.insertNote('Note')) },
      { label: 'Raw HTML', shortcut: 'Ctrl+L', action: () => run(C.insertERT) },
    ] } : { title: 'Insert', items: [
      { label: 'Math ▸', sub: [
        { label: 'Inline formula', shortcut: 'Ctrl+M', action: () => runView(C.insertMathFromUi(false)) },
        { label: 'Display formula', shortcut: 'Ctrl+Shift+M', action: () => runView(C.insertMathFromUi(true)) },
        { label: 'Numbered equation', shortcut: 'Ctrl+Alt+N', action: () => runView(C.insertMathFromUi(true, 'equation')) },
        { label: 'AMS align environment', shortcut: 'Alt+M T A', action: () => runView(C.insertMathFromUi(true, 'align')) },
        { label: 'AMS align* (unnumbered)', action: () => runView(C.insertMathFromUi(true, 'align*')) },
        { label: 'AMS gather', action: () => runView(C.insertMathFromUi(true, 'gather')) },
        { label: 'AMS multline', action: () => runView(C.insertMathFromUi(true, 'multline')) },
        { label: 'eqnarray', action: () => runView(C.insertMathFromUi(true, 'eqnarray')) },
        { sep: true },
        { label: 'Delimiters…', action: () => setDialog({ name: 'delimiters' }) },
        { label: 'Matrix…', action: () => setDialog({ name: 'matrix' }) },
        { sep: true },
        { label: 'Math macro definition', action: () => { void uiPrompt('Math Macro', 'Macro name (without backslash):').then(n => { if (n) void uiPrompt('Math Macro', 'Number of arguments:', '0').then(a => run(C.insertMacroDef(n, Number(a || 0), ''))); }); } },
      ] },
      { label: 'Special Character ▸', sub: [
        { label: 'Ellipsis …', shortcut: 'Alt+.', action: () => run(C.insertSpecial('ldots')) },
        { label: 'End of sentence', shortcut: 'Ctrl+.', action: () => run(C.insertSpecial('endofsentence')) },
        { label: 'Non-breaking dash', shortcut: 'Ctrl+Alt+-', action: () => run(C.insertSpecial('nobreakdash')) },
        { label: 'Hyphenation point', action: () => run(C.insertSpecial('softhyphen')) },
        { label: 'Ligature break', shortcut: 'Ctrl+Shift+L', action: () => run(C.insertSpecial('ligaturebreak')) },
        { label: 'Breakable slash', shortcut: 'Ctrl+/', action: () => run(C.insertSpecial('breakableslash')) },
        ...lyxOnly([{ label: 'Menu separator', action: () => run(C.insertSpecial('menuseparator')) }]),
        { label: 'En dash –', ...(isMac() ? {} : { shortcut: 'Alt+Shift+-' }), action: () => run(C.insertDash('en')) },
        { label: 'Em dash —', shortcut: 'Alt+-', action: () => run(C.insertDash('em')) },
        { ...plain('LyX / TeX / LaTeX logos', 'TeX / LaTeX logos'), action: () => run(C.insertSpecial('LaTeX')) },
        { label: 'Opening quote', action: () => run(C.insertQuote('l')) }, { label: 'Closing quote', action: () => run(C.insertQuote('r')) },
        { label: 'Single quotes ‘ ’', action: () => run(C.insertQuote('l', 'e', 's')) },
      ] },
      { label: 'Formatting ▸', sub: [
        { label: 'Line break', shortcut: 'Ctrl+Enter', action: () => run(C.insertNewline('newline')) },
        { label: 'Justified line break', shortcut: 'Ctrl+Shift+Enter', action: () => run(C.insertNewline('linebreak')) },
        { label: 'New page', action: () => run(C.insertNewpage('newpage')) },
        { label: 'Page break', action: () => run(C.insertNewpage('pagebreak')) },
        { label: 'Clear page', action: () => run(C.insertNewpage('clearpage')) },
        { sep: true },
        { label: 'Protected space', shortcut: 'Ctrl+Space', action: () => run(C.insertSpace('~')) },
        { label: 'Thin space', shortcut: 'Ctrl+Shift+Space', action: () => run(C.insertSpace('\\thinspace{}')) },
        { label: 'Interword space', action: () => run(C.insertSpace('\\space{}')) },
        { label: 'Quad space', action: () => run(C.insertSpace('\\quad{}')) },
        { label: 'Horizontal fill', action: () => run(C.insertSpace('\\hfill{}')) },
        { sep: true },
        { label: 'Vertical space (defskip)', action: () => run(C.insertVSpace('defskip')) },
        { label: 'Vertical space (bigskip)', action: () => run(C.insertVSpace('bigskip')) },
      ] },
      { label: 'Float ▸', sub: [
        { label: 'Figure', action: () => run(C.insertFloat('figure')) },
        { label: 'Table', action: () => run(C.insertFloat('table')) },
        { label: 'Algorithm', action: () => run(C.insertFloat('algorithm')) },
      ] },
      { label: 'Note ▸', sub: [
        { ...plain('LyX note (not printed)', 'Note (not printed)'), shortcut: 'Ctrl+Alt+Shift+N', action: () => run(C.insertNote('Note')) },
        { label: 'Comment (LaTeX comment)', action: () => run(C.insertNote('Comment')) },
        { label: 'Greyed out', action: () => run(C.insertNote('Greyedout')) },
      ] },
      { label: 'Comment thread', shortcut: 'Ctrl+Alt+C', action: () => run(C.insertComment) },
      { sep: true },
      { label: 'Graphics…', shortcut: 'Ctrl+Shift+G', action: () => setDialog({ name: 'graphics' }) },
      { label: 'Drawing (SVG)…', action: () => runView(v => { void insertDrawing(v); return true; }) },
      { label: 'Table…', shortcut: 'Ctrl+Alt+T', action: () => setDialog({ name: 'table' }) },
      { label: 'Caption', action: () => run(C.insertCaption) },
      { sep: true },
      { label: 'Label…', shortcut: 'Ctrl+Alt+L', action: () => setDialog({ name: 'label' }) },
      { label: 'Cross-reference…', shortcut: 'Ctrl+Shift+I', action: () => setDialog({ name: 'ref' }) },
      { label: 'Citation…', shortcut: 'Ctrl+Shift+C', action: () => setDialog({ name: 'cite' }) },
      { label: 'Link…', shortcut: LINK_KEY, action: () => runView(openLinkBoxFor) },
      { label: 'Footnote', shortcut: 'Ctrl+Alt+F', action: () => run(C.insertFootnote) },
      { label: 'Marginal note', shortcut: 'Ctrl+Alt+M', action: () => run(C.insertMarginal) },
      { label: 'Index entry', action: () => run(C.insertIndex) },
      { ...plain('Short title (argument)', 'Short title'), shortcut: 'Alt+A 1', action: () => run(C.insertArgument('1')) },
      { sep: true },
      { ...plain('TeX code (ERT)', 'LaTeX code'), shortcut: 'Ctrl+L', action: () => run(C.insertERT) },
      { label: 'Program listing', action: () => run(C.insertListing) },
      { label: 'Box', action: () => run(C.insertBox) },
      ...lyxOnly([{ label: 'Branch…', action: () => { void uiPrompt('Branch', 'Branch name:').then(n => { if (n) run(C.insertBranch(n)); }); } }]),
      { ...plain('Custom inset (Flex)…', 'Character style…'), action: () => { void uiPrompt(modern ? 'Character Style' : 'Custom Inset', modern ? 'Style name (from the document class):' : 'Flex inset name:', meta?.flexInsets?.[0] ?? 'Code').then(n => { if (n) run(C.insertFlex(n)); }); } },
      { sep: true },
      { ...plain('Child document…', 'Include a document…'), action: () => setDialog({ name: 'childdoc' }) },
      { label: 'Table of contents', action: () => run(C.insertToc()) },
      { label: 'List of figures', action: () => run(C.insertToc('listoffigures')) },
      { label: 'BibTeX bibliography…', action: () => { void uiPrompt('BibTeX Bibliography', 'BibTeX file(s), comma separated (without .bib):', (meta?.files.filter(x => x.kind === 'bib').map(x => x.path.replace(/\.bib$/, '')).join(',') || 'references')).then(f => { if (f) void uiPrompt('BibTeX Bibliography', 'Style:', 'plain').then(style => run(C.insertBibtex(f, style || 'plain'))); }); } },
      { label: 'Index (print)', action: () => run(C.insertIndexPrint) },
    ] },
    document: { title: 'Document', items: [
      ...tex<MenuEntry>([
        { label: 'Settings…', action: () => setDialog({ name: 'settings' }) },
        { label: 'Start Appendix Here', checked: !!(view && C.currentParagraph(view.state)?.node.attrs.appendix), action: () => run(C.toggleAppendix) },
        { label: 'Math macros…', action: () => setDialog({ name: 'macros' }) },
      ]),
      // a markdown document's typesetting: its front matter's keys (app/MarkdownSettings.tsx)
      ...md<MenuEntry>([{ label: 'Settings…', action: () => setDialog({ name: 'mdsettings' }) }]),
      // how titles, headings, body text and quotes look (app/TextStyles.tsx)
      { label: 'Text styles…', action: () => setDialog({ name: 'textstyles' }) },
      { label: 'Statistics (word count)…', action: () => setDialog({ name: 'stats' }) },
      { label: 'Change tracking', shortcut: 'Ctrl+Shift+E', checked: tracking, action: toggleTracking },
      { sep: true },
      { label: 'Reload metadata (macros, bibliography)', action: reloadMetadata },
    ] }
  };
}
