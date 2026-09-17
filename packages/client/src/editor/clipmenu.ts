/**
 * Cut / Copy / Paste of the document's selection as menu entries. The editor's right-click menu
 * (editormenu.ts) shows them, and so does a formula's own menu (nodeviews/math.ts) when the formula
 * lies inside the selection — an equation selected whole, or text dragged across one — so that the
 * selection can be cut or copied from wherever one right-clicks on it.
 */
import type { EditorView } from 'prosemirror-view';
import type { Selection } from 'prosemirror-state';
import type { MenuItem } from './contextmenu';
import { editorContext } from './context';
import { insertImageFiles, readClipboardImages } from './imagepaste';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

/** the node at `pos` (of `size` positions) lies wholly inside a non-empty selection */
export function selectionCovers(sel: Selection, pos: number, size: number): boolean {
  return !sel.empty && sel.from <= pos && sel.to >= pos + size;
}

/** Cut and Copy (disabled without a selection) and Paste (images become graphics insets, text is inserted) */
export function clipboardMenuItems(view: EditorView): MenuItem[] {
  const hasSel = !view.state.selection.empty;
  return [
    { label: 'Cut', shortcut: MOD + '+X', disabled: !hasSel, action: () => { view.focus(); document.execCommand('cut'); } },
    { label: 'Copy', shortcut: MOD + '+C', disabled: !hasSel, action: () => { view.focus(); document.execCommand('copy'); } },
    { label: 'Paste', shortcut: MOD + '+V', action: () => {
      view.focus();
      const pasteText = () => navigator.clipboard?.readText().then(t => { if (t) view.dispatch(view.state.tr.insertText(t)); }).catch(() => editorContext.notify?.('Use ' + MOD + '+V to paste', 'error'));
      readClipboardImages().then(imgs => { if (imgs.length) void insertImageFiles(view, imgs); else void pasteText(); }).catch(() => void pasteText());
    } },
  ];
}
