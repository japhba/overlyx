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
import { insertImageFiles } from './imagepaste';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

/** the node at `pos` (of `size` positions) lies wholly inside a non-empty selection */
export function selectionCovers(sel: Selection, pos: number, size: number): boolean {
  return !sel.empty && sel.from <= pos && sel.to >= pos + size;
}

/** What the async clipboard API holds: images, the HTML and the plain text ('' when absent). */
export async function readClipboard(): Promise<{ images: File[]; html: string; text: string }> {
  const out = { images: [] as File[], html: '', text: '' };
  for (const item of await navigator.clipboard?.read?.() ?? []) {
    // prefer the vector form when both are offered (Chromium 124+ carries image/svg+xml)
    const image = item.types.find(t => t === 'image/svg+xml') ?? item.types.find(t => t.startsWith('image/'));
    if (image) out.images.push(new File([await item.getType(image)], 'image', { type: image }));
    if (!out.html && item.types.includes('text/html')) out.html = await (await item.getType('text/html')).text();
    if (!out.text && item.types.includes('text/plain')) out.text = await (await item.getType('text/plain')).text();
  }
  return out;
}

/**
 * Paste from a menu or the toolbar (no paste event, so the async clipboard is read): images become
 * graphics insets; everything else takes the same way as Ctrl+V — the HTML an OverLyX copy wrote
 * keeps its insets, and table cells copied from a table (whole rows too) go in cell by cell from
 * the cursor's cell (prosemirror-tables, as LyX pastes a tabular selection); plain text is split
 * into paragraphs, LaTeX in it parsed. False when the clipboard could not be read.
 */
export async function pasteFromClipboard(view: EditorView): Promise<boolean> {
  let clip: { images: File[]; html: string; text: string };
  try { clip = await readClipboard(); } catch {
    // no clipboard.read (older Safari / Firefox, some webviews): the text alone
    try { clip = { images: [], html: '', text: await navigator.clipboard?.readText?.() ?? '' }; } catch { return false; }
  }
  if (view.isDestroyed) return false;
  if (clip.images.length) { await insertImageFiles(view, clip.images); return true; }
  if (!clip.html && !clip.text) return true;   // an empty clipboard: nothing to paste
  view.focus();
  // the editor's handlePaste reads clipboardData (LaTeX, SVG markup …): hand it the same data
  let event: ClipboardEvent | undefined;
  try {
    const data = new DataTransfer();
    if (clip.text) data.setData('text/plain', clip.text);
    if (clip.html) data.setData('text/html', clip.html);
    event = new ClipboardEvent('paste', { clipboardData: data });
  } catch { /* no DataTransfer constructor: ProseMirror makes an empty event */ }
  return clip.html ? view.pasteHTML(clip.html, event) : view.pasteText(clip.text, event);
}

/** Cut and Copy (disabled without a selection) and Paste (images become graphics insets, text and table cells go in as with Ctrl+V) */
export function clipboardMenuItems(view: EditorView): MenuItem[] {
  const hasSel = !view.state.selection.empty;
  return [
    { label: 'Cut', shortcut: MOD + '+X', disabled: !hasSel, action: () => { view.focus(); document.execCommand('cut'); } },
    { label: 'Copy', shortcut: MOD + '+C', disabled: !hasSel, action: () => { view.focus(); document.execCommand('copy'); } },
    { label: 'Paste', shortcut: MOD + '+V', action: () => {
      view.focus();
      pasteFromClipboard(view).then(ok => { if (!ok) editorContext.notify?.('Use ' + MOD + '+V to paste', 'error'); }).catch(() => editorContext.notify?.('Use ' + MOD + '+V to paste', 'error'));
    } },
  ];
}
