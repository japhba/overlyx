import type { Command } from 'prosemirror-state';
import { darkThemeMenuEntries, type MenuDef, type MenuEntry } from './MenuBar';
import type { ToolbarId, ToolbarMode } from './toolbars';
import { tbDockMenuEntries } from './tbdock';
import { editorContext } from '../editor/context';
import * as C from '../editor/commands';
import { foldAllSections, unfoldAllSections, toggleSectionAtCursor, toggleLevelAtCursor, toggleItemAtCursor, foldAllItems, unfoldAllItems } from '../editor/plugins/fold';
import { isPresenting, togglePresentation, PRESENTATION_KEY } from './presentation';
import { TEXT_WIDTH_RUNGS } from './Ruler';
import { wideWidth, setWideWidth, WIDE_FULL, WIDE_TEXT } from '../editor/widecontent';

export interface ViewMenuContext {
  hostItems: MenuEntry[]; themeItems: MenuEntry[]; hostToolbars: MenuEntry[];
  combined: boolean; setCombined(value: boolean): void; marginMode: boolean; toggleMargin(): void;
  run(command: Command): void; showRuler: boolean; setShowRuler(next: (value: boolean) => boolean): void;
  tbMode(id: ToolbarId): ToolbarMode; setToolbar(id: ToolbarId, mode: ToolbarMode): void;
  textWidth: number; setTextWidth(value: number): void; stepTextWidth(direction: number): void;
}

export function editorViewMenu({ hostItems, themeItems, hostToolbars, combined, setCombined, marginMode, toggleMargin, run, showRuler, setShowRuler, tbMode, setToolbar, textWidth, setTextWidth, stepTextWidth }: ViewMenuContext): MenuDef {
  // Modern: plain names, the Classic label stays the id (documentMenus `plain`)
  const modern = typeof document !== 'undefined' && document.documentElement.dataset.ui === 'modern';
  const plain = (classic: string, simple: string): { label: string; id?: string } => (modern ? { label: simple, id: classic } : { label: classic });
  return { title: 'View', items: [
      ...hostItems,
      { ...plain('Master + child documents in one view', 'Included documents in one view'), checked: combined, action: () => setCombined(!combined) },
      { label: 'Notes & comments in the margin', checked: marginMode, action: toggleMargin },
      { ...plain('Open all insets', 'Open all footnotes, notes and boxes'), action: () => run(C.setAllInsets('open')) },
      { ...plain('Close all insets', 'Close all footnotes, notes and boxes'), action: () => run(C.setAllInsets('collapsed')) },
      // Google-Docs-style section folding (editor/plugins/fold.ts): the arrow left of a heading does it for one
      { label: 'Fold / expand this section', action: () => run(toggleSectionAtCursor) },
      { label: 'Fold all at this level', action: () => run(toggleLevelAtCursor(true)) },
      { label: 'Expand all at this level', action: () => run(toggleLevelAtCursor(false)) },
      { label: 'Fold all sections', action: () => run(foldAllSections) },
      { label: 'Expand all sections', action: () => run(unfoldAllSections) },
      // list items with sub-items fold the same way (the arrow left of the bullet)
      { label: 'Fold / expand this list item\'s sub-items', action: () => run(toggleItemAtCursor) },
      { label: 'Fold all list items', action: () => run(foldAllItems) },
      { label: 'Expand all list items', action: () => run(unfoldAllItems) },
      { sep: true },
      { label: 'Zoom in', shortcut: 'Ctrl++', action: () => editorContext.ui?.zoom(1) },
      { label: 'Zoom out', shortcut: 'Ctrl+-', action: () => editorContext.ui?.zoom(-1) },
      { label: 'Reset zoom', action: () => editorContext.ui?.zoom(0) },   // Ctrl+0 is Part now (Edit ▸ Paragraph style); rebindable in the palette
      { label: 'Ruler', checked: showRuler, action: () => setShowRuler(r => !r) },
      // the document alone: menu bar, toolbars, status bar, rulers and panels hidden; Esc leaves (app/presentation.ts)
      { label: 'Presentation mode', shortcut: PRESENTATION_KEY, checked: isPresenting(), action: togglePresentation },
      ...themeItems,
      // smart invert of the pages and figures, the text tone (app/darkpages.ts; also the theme switch's menu)
      ...darkThemeMenuEntries(),
      { label: 'Toolbars ▸', sub: [
        // where they sit: along the top or in a column beside the document (app/tbdock.tsx; also a toolbar's right-click menu)
        ...tbDockMenuEntries(),
        { sep: true },
        // the LyX toolbar set (stdtoolbars.inc); the contextual ones are docked at the bottom of the window
        { label: 'Standard', checked: tbMode('standard') !== 'off', action: () => setToolbar('standard', tbMode('standard') === 'off' ? 'on' : 'off') },
        { label: 'View/Update', checked: tbMode('viewupdate') !== 'off', action: () => setToolbar('viewupdate', tbMode('viewupdate') === 'off' ? 'on' : 'off') },
        { label: 'Extra', checked: tbMode('extra') !== 'off', action: () => setToolbar('extra', tbMode('extra') === 'off' ? 'on' : 'off') },
        ...hostToolbars,
        { sep: true },
        ...([['math', 'Math'], ['table', 'Table'], ['review', 'Review']] as [ToolbarId, string][]).flatMap(([id, name]) => [
          { label: `${name}: automatic (${id === 'math' ? 'when the cursor is in a formula' : id === 'table' ? 'when the cursor is in a table' : 'while suggesting'})`, checked: tbMode(id) === 'auto', action: () => setToolbar(id, 'auto') },
          { label: `${name}: always shown`, checked: tbMode(id) === 'on', action: () => setToolbar(id, 'on') },
          { label: `${name}: hidden`, checked: tbMode(id) === 'off', action: () => setToolbar(id, 'off') },
        ]),
        { sep: true },
        { label: 'Math panels (with the math toolbar)', checked: tbMode('mathpanels') !== 'off', action: () => setToolbar('mathpanels', tbMode('mathpanels') === 'off' ? 'on' : 'off') },
      ] },
      { label: 'Text width ▸', sub: [
        ...[...TEXT_WIDTH_RUNGS, ['Full width', 0] as [string, number]].map(([l, w]) => ({ label: l, checked: textWidth === w, action: () => setTextWidth(w) })),
        { sep: true },
        { label: 'Wider', shortcut: 'Ctrl+Alt++', action: () => stepTextWidth(1) },
        { label: 'Narrower', shortcut: 'Ctrl+Alt+-', action: () => stepTextWidth(-1) },
      ] },
      // how far display formulas and tables may reach into the margins (the ruler's second track: editor/widecontent.ts)
      { label: 'Formula & table width ▸', sub: [
        { label: 'Full width (into the margins)', checked: wideWidth() === WIDE_FULL, action: () => setWideWidth(WIDE_FULL) },
        { label: 'Same as the text', checked: wideWidth() === WIDE_TEXT, action: () => setWideWidth(WIDE_TEXT) },
        ...(wideWidth() > 0 ? [{ label: `As set on the ruler (${(wideWidth() * 2.54 / 96).toFixed(1)} cm)`, checked: true, action: () => undefined }] : []),
        { sep: true },
        { label: 'Any width: drag the ends of the ruler’s second track', disabled: true },
      ] },
    ] };
}
