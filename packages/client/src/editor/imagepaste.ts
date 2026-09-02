/**
 * Images pasted or dropped into the editor: the file is uploaded into the project's figures/
 * directory and a graphics inset is inserted where the cursor (or the drop) is. Covers clipboard
 * image data (screenshots), image files copied or dragged in from the computer, and SVG markup
 * on the text clipboard ("Copy as SVG" in drawing tools).
 */
import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { api } from '../api';
import { insertGraphics } from './commands';
import { editorContext, toDocRel, viewDocDir, viewProject } from './context';

/** MIME type → graphics extension for the formats \includegraphics (with our converters) handles. */
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tif',
  'application/pdf': 'pdf', 'application/postscript': 'eps',
};
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'pdf', 'eps', 'ps']);

/** The extension to store a pasted/dropped file under — by MIME type, else file name; null: not an image. */
export function imageExt(file: { type?: string; name?: string }): string | null {
  const byType = EXT_BY_TYPE[(file.type ?? '').toLowerCase()];
  if (byType) return byType;
  const name = file.name ?? '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return IMAGE_EXTS.has(ext) ? ext : null;
}

/** The image files of a paste or drop (empty when there are none). */
export function imageFiles(dt: DataTransfer | null | undefined): File[] {
  return Array.from(dt?.files ?? []).filter(f => imageExt(f) !== null);
}

/** A LaTeX-safe base name (no directory, extension, spaces or specials — \includegraphics chokes on them). */
export function safeGraphicsName(name: string): string {
  let base = name.split(/[\\/]/).pop() ?? '';
  if (base.includes('.')) base = base.slice(0, base.lastIndexOf('.'));
  base = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return base || 'image';
}

/** Clipboard images arrive under generic names ("image.png"): those get a timestamp name instead. */
const GENERIC_NAMES = new Set(['image', 'grafik', 'bild', 'unknown', 'clipboard']);

export function pastedName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `pasted-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** The base name to store a pasted/dropped file under (without directory and extension). */
export function uploadBaseName(file: { name?: string }): string {
  const base = safeGraphicsName(file.name ?? '');
  return GENERIC_NAMES.has(base.toLowerCase()) ? pastedName() : base;
}

/** Does pasted plain text look like an SVG document? */
export function isSvgMarkup(text: string): boolean {
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text);
}

/** Pasted SVG markup as a file to upload. */
export function svgFile(text: string): File {
  return new File([text], 'image.svg', { type: 'image/svg+xml' });
}

/** Upload without replacing anything: on a name clash the server answers 409 and we count up (plot-2.png). */
async function uploadUnique(project: string, base: string, ext: string, blob: Blob): Promise<string> {
  for (let i = 1; i <= 100; i++) {
    const rel = `figures/${base}${i > 1 ? '-' + i : ''}.${ext}`;
    try { await api.upload(project, rel, blob, { overwrite: false }); return rel; }
    catch (e) { if ((e as { status?: number }).status !== 409) throw e; }
  }
  throw new Error('no free file name');
}

/**
 * Upload the image files and insert a graphics inset for each; `atPos` (a drop) moves the cursor
 * there first. Returns how many images were inserted.
 */
export async function insertImageFiles(view: EditorView, files: File[], atPos?: number | null): Promise<number> {
  const project = viewProject(view);
  if (!project) return 0;
  if (typeof atPos === 'number') {
    const pos = Math.max(0, Math.min(atPos, view.state.doc.content.size));
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
  }
  let inserted = 0;
  for (const file of files) {
    const ext = imageExt(file);
    if (!ext) continue;
    try {
      const rel = await uploadUnique(project, uploadBaseName(file), ext, file);
      // the dialog's defaults for a new graphic: column width (LaTeX would overflow the page with a full-size screenshot)
      insertGraphics(toDocRel(rel, viewDocDir(view)), { width: '100col%' })(view.state, view.dispatch);
      inserted++;
      editorContext.notify?.(`Image saved as ${rel}`);
    } catch (e) {
      editorContext.notify?.(`Could not upload ${file.name || 'the image'}: ${(e as Error).message}`, 'error');
    }
  }
  if (inserted) view.focus();
  return inserted;
}

/** Image data from the async clipboard API (toolbar and context-menu paste; empty when unsupported). */
export async function readClipboardImages(): Promise<File[]> {
  const items = await navigator.clipboard?.read?.() ?? [];
  const out: File[] = [];
  for (const item of items) {
    const type = item.types.find(t => t.startsWith('image/'));
    if (!type) continue;
    out.push(new File([await item.getType(type)], 'image', { type }));
  }
  return out;
}
