import type { Command } from 'prosemirror-state';
import type { MenuDef, MenuEntry } from './MenuBar';
import type { ToolbarId, ToolbarMode } from './toolbars';
import { editorContext } from '../editor/context';
import * as C from '../editor/commands';
import { isPresenting, togglePresentation, PRESENTATION_KEY } from './presentation';

export interface ViewMenuContext {
  hostItems: MenuEntry[]; themeItems: MenuEntry[]; hostToolbars: MenuEntry[];
  combined: boolean; setCombined(value: boolean): void; marginMode: boolean; toggleMargin(): void;
  run(command: Command): void; showRuler: boolean; setShowRuler(next: (value: boolean) => boolean): void;
  tbMode(id: ToolbarId): ToolbarMode; setToolbar(id: ToolbarId, mode: ToolbarMode): void;
  textWidth: number; setTextWidth(value: number): void; stepTextWidth(direction: number): void;
}

export function editorViewMenu({ hostItems, themeItems, hostToolbars, combined, setCombined, marginMode, toggleMargin, run, showRuler, setShowRuler, tbMode, setToolbar, textWidth, setTextWidth, stepTextWidth }: ViewMenuContext): MenuDef {
  return { title: 'View', items: [
      ...hostItems,
      { label: 'Master + child documents in one view', checked: combined, action: () => setCombined(!combined) },
      { label: 'Notes & comments in the margin', checked: marginMode, action: toggleMargin },
      { label: 'Open all insets', action: () => run(C.setAllInsets('open')) },
      { label: 'Close all insets', action: () => run(C.setAllInsets('collapsed')) },
      { sep: true },
      { label: 'Zoom in', shortcut: 'Ctrl++', action: () => editorContext.ui?.zoom(1) },
      { label: 'Zoom out', shortcut: 'Ctrl+-', action: () => editorContext.ui?.zoom(-1) },
      { label: 'Reset zoom', action: () => editorContext.ui?.zoom(0) },   // Ctrl+0 is Part now (Edit ▸ Paragraph style); rebindable in the palette
      { label: 'Ruler', checked: showRuler, action: () => setShowRuler(r => !r) },
      // the document alone: menu bar, toolbars, status bar, rulers and panels hidden; Esc leaves (app/presentation.ts)
      { label: 'Presentation mode', shortcut: PRESENTATION_KEY, checked: isPresenting(), action: togglePresentation },
      ...themeItems,
      { label: 'Toolbars ▸', sub: [
        // the LyX toolbar set (stdtoolbars.inc); the contextual ones are docked at the bottom of the window
        { label: 'Standard', checked: tbMode('standard') !== 'off', action: () => setToolbar('standard', tbMode('standard') === 'off' ? 'on' : 'off') },
        { label: 'View/Update', checked: tbMode('viewupdate') !== 'off', action: () => setToolbar('viewupdate', tbMode('viewupdate') === 'off' ? 'on' : 'off') },
        { label: 'Extra', checked: tbMode('extra') !== 'off', action: () => setToolbar('extra', tbMode('extra') === 'off' ? 'on' : 'off') },
        ...hostToolbars,
        { sep: true },
        ...([['math', 'Math'], ['table', 'Table'], ['review', 'Review']] as [ToolbarId, string][]).flatMap(([id, name]) => [
          { label: `${name}: automatic (when the cursor is in ${id === 'math' ? 'a formula' : id === 'table' ? 'a table' : 'a document with tracked changes'})`, checked: tbMode(id) === 'auto', action: () => setToolbar(id, 'auto') },
          { label: `${name}: always shown`, checked: tbMode(id) === 'on', action: () => setToolbar(id, 'on') },
          { label: `${name}: hidden`, checked: tbMode(id) === 'off', action: () => setToolbar(id, 'off') },
        ]),
        { sep: true },
        { label: 'Math panels (with the math toolbar)', checked: tbMode('mathpanels') !== 'off', action: () => setToolbar('mathpanels', tbMode('mathpanels') === 'off' ? 'on' : 'off') },
      ] },
      { label: 'Text width ▸', sub: [
        ...[['Narrow', 560], ['Normal', 720], ['Wide', 880], ['Extra wide', 1080], ['Full width', 0]].map(([l, w]) => ({ label: String(l), checked: textWidth === w, action: () => setTextWidth(w as number) })),
        { sep: true },
        { label: 'Wider', shortcut: 'Ctrl+Alt++', action: () => stepTextWidth(1) },
        { label: 'Narrower', shortcut: 'Ctrl+Alt+-', action: () => stepTextWidth(-1) },
      ] },
    ] };
}
