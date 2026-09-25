/** Editing commands shared by the browser and VS Code. Add document features here once. */
import type { EditorView } from 'prosemirror-view';
import type { Command } from 'prosemirror-state';
import { undo, redo } from 'y-prosemirror';
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, mergeCells, splitCell } from 'prosemirror-tables';
import type { DocMeta } from '../api';
import type { MenuDef, MenuEntry } from './MenuBar';
import { NAMED_COLORS } from './Toolbar';
import * as C from '../editor/commands';
import { isMac } from '../editor/keymap';
import { moveSection, shiftSection } from '../editor/outline';
import { changeAt, resolveChange, acceptAllChanges, rejectAllChanges } from '../editor/plugins/changes';

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
  return {
    edit: { title: 'Edit', items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', action: () => run(undo) },
      { label: 'Redo', shortcut: 'Ctrl+Y', action: () => run(redo) },
      { sep: true },
      { label: 'Find & Replace…', shortcut: 'Ctrl+F', action: () => setFindOpen(true) },
      { label: 'Select inset / all', shortcut: 'Ctrl+A', action: () => run(C.selectInset) },
      { sep: true },
      { label: 'Text Style ▸', sub: [
        { label: 'Emphasized', shortcut: 'Ctrl+E', action: () => run(C.fontCommands.emph) },
        { label: 'Italic', shortcut: 'Ctrl+I', action: () => run(C.fontCommands.italic) },
        { label: 'Bold', shortcut: 'Ctrl+B', action: () => run(C.fontCommands.bold) },
        { label: 'Noun (small caps)', shortcut: 'Ctrl+Shift+N', action: () => run(C.fontCommands.noun) },
        { label: 'Underline', shortcut: 'Ctrl+U', action: () => run(C.fontCommands.underline) },
        { label: 'Strikeout', shortcut: 'Ctrl+Shift+O', action: () => run(C.fontCommands.strikeout) },
        { label: 'Typewriter', action: () => run(C.fontCommands.typewriter) },   // Ctrl+Shift+P is the command palette
        { label: 'Sans serif', action: () => run(C.fontCommands.sans) },
        { label: 'Small caps shape', action: () => run(C.fontCommands.smallcaps) },
        { label: 'Double underline', action: () => run(C.fontCommands.uuline) },
        { label: 'Wavy underline', action: () => run(C.fontCommands.uwave) },
        { sep: true },
        ...['tiny', 'scriptsize', 'footnotesize', 'small', 'normal', 'large', 'larger', 'largest', 'huge', 'giant'].map(s => ({ label: 'Size: ' + s, action: () => run(C.setValueMark('size', s === 'normal' ? null : s)) })),
        { sep: true },
        ...['red', 'blue', 'green', 'magenta', 'cyan', 'orange', 'purple', 'gray', 'none'].map(c => ({ label: 'Color: ' + c, action: () => run(C.setValueMark('color', c === 'none' ? null : c)) })),
        { sep: true },
        { label: 'Reset font', shortcut: 'Ctrl+Alt+D', action: () => run(C.fontDefault) },
      ] },
      { label: 'Text colour ▸', sub: [
        { label: 'Default (no colour)', checked: !textColor, action: () => run(C.setValueMark('color', null)) },
        { sep: true },
        ...NAMED_COLORS.map(([name]) => ({ label: name[0].toUpperCase() + name.slice(1), checked: textColor === name, action: () => run(C.setValueMark('color', name)) })),
        { sep: true },
        { label: 'Custom colour… (palette on the toolbar)', checked: !!textColor && textColor.startsWith('#'), action: () => (document.querySelector('[data-tb="textcolor"]') as HTMLButtonElement | null)?.click() },
      ] },
      { label: 'Paragraph ▸', sub: [
        { label: 'Paragraph settings…', shortcut: 'Ctrl+Alt+P', action: () => setDialog({ name: 'paragraph' }) },
        { sep: true },
        { label: 'Align left', shortcut: 'Alt+A L', action: () => run(C.setParagraphAttrs({ align: 'left' })) },
        { label: 'Align center', shortcut: 'Alt+A C', action: () => run(C.setParagraphAttrs({ align: 'center' })) },
        { label: 'Align right', shortcut: 'Alt+A R', action: () => run(C.setParagraphAttrs({ align: 'right' })) },
        { label: 'Justified', shortcut: 'Alt+A J', action: () => run(C.setParagraphAttrs({ align: 'block' })) },
        { label: 'Default alignment', shortcut: 'Alt+A E', action: () => run(C.setParagraphAttrs({ align: null })) },
        { label: 'Toggle indentation', shortcut: 'Alt+A I', action: () => { const p = view && C.currentParagraph(view.state); if (p) run(C.setParagraphAttrs({ noindent: !p.node.attrs.noindent })); } },
        { sep: true },
        { label: 'Increase depth', shortcut: 'Alt+Shift+→', action: () => run(C.changeDepth(1)) },
        { label: 'Decrease depth', shortcut: 'Alt+Shift+←', action: () => run(C.changeDepth(-1)) },
        { label: 'Move paragraph up', shortcut: 'Alt+↑', action: () => run(C.moveParagraph(-1)) },
        { label: 'Move paragraph down', shortcut: 'Alt+↓', action: () => run(C.moveParagraph(1)) },
        { sep: true },
        { label: 'Move section up', action: () => run(moveSection(-1)) },
        { label: 'Move section down', action: () => run(moveSection(1)) },
        { label: 'Promote section (heading level up)', action: () => run(shiftSection(-1, undefined, meta?.layouts)) },
        { label: 'Demote section (heading level down)', action: () => run(shiftSection(1, undefined, meta?.layouts)) },
      ] },
      // Google-Docs-style: Ctrl+digit sets a heading level (LyX's Alt+P digits), Ctrl+Alt+digit the unnumbered one
      { label: 'Paragraph style ▸', sub: [
        { label: 'Standard', shortcut: 'Alt+P S', action: () => run(C.setKnownLayout('Standard')) },
        { sep: true },
        ...SECTION_LAYOUTS.map(([digit, name]) => ({ label: name, shortcut: 'Ctrl+' + digit, action: () => run(C.setKnownLayout(name)) })),
        { sep: true },
        ...SECTION_LAYOUTS.map(([digit, name]) => ({ label: name + '* (unnumbered)', shortcut: 'Ctrl+Alt+' + digit, action: () => run(C.setKnownLayout(name + '*')) })),
        { sep: true },
        { label: 'Itemize (bullet list — or type “- ”)', shortcut: 'Alt+P I', action: () => run(C.setKnownLayout('Itemize')) },
        { label: 'Enumerate (numbered list — or type “1. ”)', shortcut: 'Alt+P E', action: () => run(C.setKnownLayout('Enumerate')) },
        { label: 'Description', shortcut: 'Alt+P D', action: () => run(C.setKnownLayout('Description')) },
        { label: 'Quote', shortcut: 'Alt+P Q', action: () => run(C.setKnownLayout('Quote')) },
        { label: 'LyX-Code', shortcut: 'Alt+P C', action: () => run(C.setKnownLayout('LyX-Code')) },
      ] },
      { label: 'Table ▸', sub: [
        { label: 'Add row above', action: () => run(addRowBefore) }, { label: 'Add row below', action: () => run(addRowAfter) },
        { label: 'Add column before', action: () => run(addColumnBefore) }, { label: 'Add column after', action: () => run(addColumnAfter) },
        { label: 'Delete row', action: () => run(deleteRow) }, { label: 'Delete column', action: () => run(deleteColumn) },
        { label: 'Merge cells (multicolumn)', action: () => run(mergeCells) }, { label: 'Split cell', action: () => run(splitCell) },
        { sep: true },
        { label: 'Top line on/off', action: () => toggleCellLine('topline') }, { label: 'Bottom line on/off', action: () => toggleCellLine('bottomline') },
        { label: 'Left line on/off', action: () => toggleCellLine('leftline') }, { label: 'Right line on/off', action: () => toggleCellLine('rightline') },
        { label: 'Align cell left', action: () => run(C.setCellAttr('alignment', 'left')) }, { label: 'Align cell center', action: () => run(C.setCellAttr('alignment', 'center')) }, { label: 'Align cell right', action: () => run(C.setCellAttr('alignment', 'right')) },
        { sep: true },
        { label: 'Delete table', action: () => run(deleteTable) },
        { sep: true },
        { label: 'Table settings…', action: () => setDialog({ name: 'tablesettings' }) },
      ] },
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
      { label: 'Inset settings…', shortcut: 'Ctrl+Alt+Shift+I', action: () => setDialog({ name: 'inset' }) },
      { label: 'Open/close inset', shortcut: 'Ctrl+Alt+I', action: () => run(C.toggleInset) },
      { label: 'Math: toggle inline/display', action: () => run(C.toggleMathDisplay) },
    ] },
    insert: { title: 'Insert', items: [
      { label: 'Math ▸', sub: [
        { label: 'Inline formula', shortcut: 'Ctrl+M', action: () => runView(C.insertMath(false)) },
        { label: 'Display formula', shortcut: 'Ctrl+Shift+M', action: () => runView(C.insertMath(true)) },
        { label: 'Numbered equation', shortcut: 'Ctrl+Alt+N', action: () => runView(C.insertMath(true, 'equation')) },
        { label: 'AMS align environment', shortcut: 'Alt+M T A', action: () => runView(C.insertMath(true, 'align')) },
        { label: 'AMS align* (unnumbered)', action: () => runView(C.insertMath(true, 'align*')) },
        { label: 'AMS gather', action: () => runView(C.insertMath(true, 'gather')) },
        { label: 'AMS multline', action: () => runView(C.insertMath(true, 'multline')) },
        { label: 'eqnarray', action: () => runView(C.insertMath(true, 'eqnarray')) },
        { sep: true },
        { label: 'Delimiters…', action: () => setDialog({ name: 'delimiters' }) },
        { label: 'Matrix…', action: () => setDialog({ name: 'matrix' }) },
        { sep: true },
        { label: 'Math macro definition', action: () => { const n = prompt('Macro name (without backslash):'); if (n) run(C.insertMacroDef(n, Number(prompt('Number of arguments:', '0') || 0), '')); } },
      ] },
      { label: 'Special Character ▸', sub: [
        { label: 'Ellipsis …', shortcut: 'Alt+.', action: () => run(C.insertSpecial('ldots')) },
        { label: 'End of sentence', shortcut: 'Ctrl+.', action: () => run(C.insertSpecial('endofsentence')) },
        { label: 'Non-breaking dash', shortcut: 'Ctrl+Alt+-', action: () => run(C.insertSpecial('nobreakdash')) },
        { label: 'Hyphenation point', action: () => run(C.insertSpecial('softhyphen')) },
        { label: 'Ligature break', shortcut: 'Ctrl+Shift+L', action: () => run(C.insertSpecial('ligaturebreak')) },
        { label: 'Breakable slash', shortcut: 'Ctrl+/', action: () => run(C.insertSpecial('breakableslash')) },
        { label: 'Menu separator', action: () => run(C.insertSpecial('menuseparator')) },
        { label: 'En dash –', ...(isMac() ? {} : { shortcut: 'Alt+Shift+-' }), action: () => run(C.insertDash('en')) },
        { label: 'Em dash —', shortcut: 'Alt+-', action: () => run(C.insertDash('em')) },
        { label: 'LyX / TeX / LaTeX logos', action: () => run(C.insertSpecial('LaTeX')) },
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
        { label: 'LyX note (not printed)', shortcut: 'Ctrl+Alt+Shift+N', action: () => run(C.insertNote('Note')) },
        { label: 'Comment (LaTeX comment)', action: () => run(C.insertNote('Comment')) },
        { label: 'Greyed out', action: () => run(C.insertNote('Greyedout')) },
      ] },
      { label: 'Comment thread', shortcut: 'Ctrl+Alt+C', action: () => run(C.insertComment) },
      { sep: true },
      { label: 'Graphics…', shortcut: 'Ctrl+Shift+G', action: () => setDialog({ name: 'graphics' }) },
      { label: 'Table…', shortcut: 'Ctrl+Alt+T', action: () => setDialog({ name: 'table' }) },
      { label: 'Caption', action: () => run(C.insertCaption) },
      { sep: true },
      { label: 'Label…', shortcut: 'Ctrl+Alt+L', action: () => setDialog({ name: 'label' }) },
      { label: 'Cross-reference…', shortcut: 'Ctrl+Shift+I', action: () => setDialog({ name: 'ref' }) },
      { label: 'Citation…', shortcut: 'Ctrl+Shift+C', action: () => setDialog({ name: 'cite' }) },
      { label: 'Hyperlink…', shortcut: 'Ctrl+Alt+K', action: () => setDialog({ name: 'href' }) },
      { label: 'Footnote', shortcut: 'Ctrl+Alt+F', action: () => run(C.insertFootnote) },
      { label: 'Marginal note', shortcut: 'Ctrl+Alt+M', action: () => run(C.insertMarginal) },
      { label: 'Index entry', action: () => run(C.insertIndex) },
      { label: 'Short title (argument)', shortcut: 'Alt+A 1', action: () => run(C.insertArgument('1')) },
      { sep: true },
      { label: 'TeX code (ERT)', shortcut: 'Ctrl+L', action: () => run(C.insertERT) },
      { label: 'Program listing', action: () => run(C.insertListing) },
      { label: 'Box', action: () => run(C.insertBox) },
      { label: 'Branch…', action: () => { const n = prompt('Branch name:'); if (n) run(C.insertBranch(n)); } },
      { label: 'Custom inset (Flex)…', action: () => { const n = prompt('Flex inset name:', meta?.flexInsets?.[0] ?? 'Code'); if (n) run(C.insertFlex(n)); } },
      { sep: true },
      { label: 'Child document…', action: () => { const fn = prompt('Child document file name (relative):', 'chapter1.tex'); if (fn) run(C.insertInclude(fn, 'include')); } },
      { label: 'Table of contents', action: () => run(C.insertToc()) },
      { label: 'List of figures', action: () => run(C.insertToc('listoffigures')) },
      { label: 'BibTeX bibliography…', action: () => { const f = prompt('BibTeX file(s), comma separated (without .bib):', (meta?.files.filter(x => x.kind === 'bib').map(x => x.path.replace(/\.bib$/, '')).join(',') || 'references')); if (f) run(C.insertBibtex(f, prompt('Style:', 'plain') || 'plain')); } },
      { label: 'Index (print)', action: () => run(C.insertIndexPrint) },
    ] },
    document: { title: 'Document', items: [
      { label: 'Settings…', action: () => setDialog({ name: 'settings' }) },
      { label: 'Start Appendix Here', checked: !!(view && C.currentParagraph(view.state)?.node.attrs.appendix), action: () => run(C.toggleAppendix) },
      { label: 'Math macros…', action: () => setDialog({ name: 'macros' }) },
      { label: 'Statistics (word count)…', action: () => setDialog({ name: 'stats' }) },
      { label: 'Change tracking', shortcut: 'Ctrl+Shift+E', checked: tracking, action: toggleTracking },
      { sep: true },
      { label: 'Reload metadata (macros, bibliography)', action: reloadMetadata },
    ] }
  };
}
