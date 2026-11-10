/**
 * Placeholder figures (core/figureplaceholder.ts) for figures the document names before their files are
 * there. Placing one at a path with no file (the Graphics dialog) asks whether to make it; a figure whose
 * file is missing says so where it stands, with the button (nodeviews/leaf.ts), and its right-click menu
 * — and a layout page's image's — has the entry (figuredraft.ts figureMenuItems).
 */
import { canMakePlaceholder, figureEnding, jpegWithDpi, pdfWithJpeg, placeholderColor, placeholderEps, placeholderPath, placeholderSvg, pngWithDpi, unquote, PLACEHOLDER_PT } from '@overlyx/core';
import { api } from '../api';
import { uiConfirm } from '../app/Dialogs';
import { editorContext, figureCandidates, figureUrl } from './context';

/** pixels per pt of the raster placeholders: 1280 × 960 px, 288 dpi */
const K = 4;

/** The placeholder drawn on a canvas (`K` px a pt), `label` on it — as placeholderSvg draws it. */
function drawPlaceholder(label: string): HTMLCanvasElement {
  const { w, h } = PLACEHOLDER_PT;
  const cv = document.createElement('canvas');
  cv.width = w * K; cv.height = h * K;
  const g = cv.getContext('2d')!;
  g.setTransform(K, 0, 0, K, 0, 0);
  g.fillStyle = placeholderColor('ground'); g.fillRect(0, 0, w, h);
  g.strokeStyle = placeholderColor('cross'); g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.moveTo(0, h); g.lineTo(w, 0); g.stroke();
  g.strokeStyle = placeholderColor('frame'); g.lineWidth = 1.5; g.strokeRect(0.75, 0.75, w - 1.5, h - 1.5);
  // (text set at its pixel size, not scaled up: a small size scaled spaces its letters unevenly)
  g.setTransform(1, 0, 0, 1, 0, 0);
  const face = (weight: number, pt: number) => `${weight} ${pt * K}px Anodyne, "OL Inter", sans-serif`;
  let size = 20;
  g.font = face(600, size);
  const tw = g.measureText(label).width / K;
  if (tw > w * 0.8) { size = Math.max(6, size * (w * 0.8) / tw); g.font = face(600, size); }
  g.fillStyle = placeholderColor('ground');
  g.fillRect(w * 0.08 * K, (h / 2 - size * 1.1) * K, w * 0.84 * K, (size * 2.2 + 12) * K);
  g.textAlign = 'center';
  g.fillStyle = placeholderColor('name'); g.fillText(label, w / 2 * K, (h / 2 + size * 0.1) * K);
  g.font = face(400, 10);
  g.fillStyle = placeholderColor('note'); g.fillText('placeholder', w / 2 * K, (h / 2 + size * 0.1 + 16) * K);
  return cv;
}

function canvasBytes(cv: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => cv.toBlob(b => b ? b.arrayBuffer().then(a => resolve(new Uint8Array(a)), reject) : reject(new Error('the picture could not be drawn')), type, quality));
}

/** The placeholder file for the project path `rel` (its ending decides the format); null: none for that ending. */
export async function placeholderBlob(rel: string): Promise<Blob | null> {
  const ending = figureEnding(rel), label = rel.split('/').pop() ?? rel;
  const dpi = 72 * K;
  switch (ending) {
    case '.svg': return new Blob([placeholderSvg(label)], { type: 'image/svg+xml' });
    case '.eps': return new Blob([placeholderEps()], { type: 'application/postscript' });
    case '.png': return new Blob([pngWithDpi(await canvasBytes(drawPlaceholder(label), 'image/png'), dpi)], { type: 'image/png' });
    case '.jpg': case '.jpeg': return new Blob([jpegWithDpi(await canvasBytes(drawPlaceholder(label), 'image/jpeg', 0.95), dpi)], { type: 'image/jpeg' });
    case '.webp': return new Blob([await canvasBytes(drawPlaceholder(label), 'image/webp', 0.95)], { type: 'image/webp' });
    case '.pdf': {
      const cv = drawPlaceholder(label);
      return new Blob([pdfWithJpeg(await canvasBytes(cv, 'image/jpeg', 0.95), { w: cv.width, h: cv.height })], { type: 'application/pdf' });
    }
  }
  return null;
}

/**
 * Is there no file for the figure the document names `name`, wherever graphicx would look (figureCandidates,
 * its endings for a name without one)? Asks the graphics endpoint, which looks the same way. false when it
 * cannot tell (offline, say).
 */
export async function figureMissing(project: string, name: string, docDir: string): Promise<boolean> {
  const n = unquote(name), cands = figureCandidates(n, docDir);
  const files = project === editorContext.project ? editorContext.meta?.files : undefined;
  if (files?.some(f => cands.some(c => f.path === c || (!figureEnding(c) && f.path.startsWith(c + '.'))))) return false;
  try { return (await fetch(figureUrl(project, n, docDir, 100), { method: 'HEAD', credentials: 'include', cache: 'no-store' })).status === 404; }
  catch { return false; }
}

/**
 * The project path a placeholder for `name` goes to: where graphicx looks first, beside the document — or,
 * for a bare name (no folder) in a document with a \graphicspath, its first folder, where it was meant to
 * be; `.pdf` added to a name without an ending.
 */
export function placeholderTarget(name: string, docDir: string): string {
  const n = unquote(name), cands = figureCandidates(n, docDir);
  return placeholderPath(!n.includes('/') && cands.length > 1 ? cands[1] : cands[0]);
}

/**
 * A placeholder made at the project path `rel` (placeholderPath) — never over a file there. Its path, or
 * null (said why). `upload` puts a file into the project, rejecting when the name is taken (a deck's host
 * has its own); absent: the server's upload.
 */
export async function makePlaceholder(project: string, rel: string, upload?: (rel: string, data: Blob) => Promise<void>): Promise<string | null> {
  const target = placeholderPath(rel);
  try {
    const blob = await placeholderBlob(target);
    if (!blob) { editorContext.notify?.(`OverLyX makes placeholders as PDF, PNG, JPEG, SVG or EPS, not ${figureEnding(target) || 'files without an ending'}.`, 'error'); return null; }
    await (upload ? upload(target, blob) : api.upload(project, target, blob, { overwrite: false }));
  } catch (e) {
    const status = (e as { status?: number }).status;
    editorContext.notify?.(status === 409 ? `There is a file at ${target} already.` : `Could not make the placeholder: ${(e as Error).message}`, 'error');
    return null;
  }
  // (the pictures naming it load it; the project's file events reach the others)
  window.dispatchEvent(new CustomEvent('ol:svg-saved', { detail: { project, path: target } }));
  return target;
}

/**
 * A figure was just placed under `name`: no file there → the offer to make a placeholder for it. Resolves
 * with the placeholder's project path, or null.
 */
export async function offerPlaceholder(project: string, name: string, docDir: string): Promise<string | null> {
  const n = unquote(name).trim();
  if (!project || !n || /^[a-z][a-z0-9+.-]*:/i.test(n)) return null;
  const target = placeholderTarget(n, docDir);
  if (!canMakePlaceholder(target) || !await figureMissing(project, n, docDir)) return null;
  const ok = await uiConfirm('No figure there yet',
    `There is no file ${n} in the project. Make a placeholder there — a grey frame with the file's name — so the editor and the PDF show where the figure goes? Save the real figure as ${target} (a plotting script can) and it takes the placeholder's place.`,
    { okLabel: 'Make a placeholder' });
  return ok ? makePlaceholder(project, target) : null;
}
