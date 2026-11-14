/**
 * File ▸ Import PDF as slides…: a PDF becomes a deck, every page a slide with the page as its
 * picture (drawn here by pdf.js at twice the slide's size). The deck has the first page's shape,
 * 1280 px on its longer side; its folder is named after the file (`talk/`, `talk-2/` …), the
 * pictures go to `pages/page-01.png` … beside its index.html. Each slide is one picture covering it,
 * so text and objects can be put over it as on any slide.
 */
import { api } from '../api';
import { blankDeck } from '@overlyx/core/html/deliverable.ts';

/** pages taken from one PDF (a deck of more is split by hand) */
export const PDF_IMPORT_MAX_PAGES = 300;
const LONG_SIDE = 1280;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** the deck's HTML: the blank deck's head and styles, a slide a page */
export function pdfDeckHtml(title: string, width: number, height: number, pages: string[]): string {
  const base = blankDeck(title, { width, height, unit: 'px' });
  const slides = pages.map((src, i) =>
    `<section class="slide">\n  <img src="${esc(src)}" alt="Page ${i + 1}" style="position: absolute; left: 0px; top: 0px; width: ${width}px; height: ${height}px">\n</section>`).join('\n');
  return base.replace('<section class="slide"></section>', slides || '<section class="slide"></section>');
}

/** the deck's size for a page of this shape */
export function pdfDeckSize(pageW: number, pageH: number): { width: number; height: number } {
  const w = Math.max(1, pageW), h = Math.max(1, pageH);
  return w >= h ? { width: LONG_SIDE, height: Math.max(200, Math.round(LONG_SIDE * h / w)) } : { width: Math.max(200, Math.round(LONG_SIDE * w / h)), height: LONG_SIDE };
}

export async function importPdfAsDeck(project: string, file: File, progress?: (done: number, total: number) => void): Promise<{ id: string; path: string; pages: number; skipped: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc ||= new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  try {
    const total = Math.min(doc.numPages, PDF_IMPORT_MAX_PAGES);
    const first = await doc.getPage(1);
    const v1 = first.getViewport({ scale: 1 });
    const { width, height } = pdfDeckSize(v1.width, v1.height);
    const title = file.name.replace(/\.pdf$/i, '').trim() || 'Imported slides';
    const folder = title.replace(/[^\p{L}\p{N} ._-]+/gu, '-').replace(/^[-. ]+|[-. ]+$/g, '').slice(0, 60) || 'slides';
    // the folder: the file's name, or with -2, -3 … when it is taken (the server refuses an existing one)
    let created: { id: string; path: string } | null = null;
    for (let i = 1; !created; i++) {
      try { created = await api.newDeliverable(project, i === 1 ? folder : `${folder}-${i}`, 'deck', title, 'blank', { width, height, unit: 'px' }); }
      catch (e) { if (i > 40 || !/exists already/.test((e as Error).message)) throw e; }
    }
    const dir = created.path.replace(/\/?index\.html$/, '');
    const digits = Math.max(2, String(total).length);
    const pages: string[] = [];
    progress?.(0, total);
    for (let n = 1; n <= total; n++) {
      const page = n === 1 ? first : await doc.getPage(n);
      const v = page.getViewport({ scale: (width * 2) / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(v.width); canvas.height = Math.round(v.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: v, canvas }).promise;
      const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob(b => b ? ok(b) : fail(new Error(`Page ${n} could not be drawn.`)), 'image/png'));
      canvas.width = canvas.height = 0;
      page.cleanup();
      const name = `pages/page-${String(n).padStart(digits, '0')}.png`;
      await api.upload(project, `${dir}/${name}`, blob);
      pages.push(name);
      progress?.(n, total);
    }
    await api.upload(project, created.path, new Blob([pdfDeckHtml(title, width, height, pages)], { type: 'text/html' }));
    return { ...created, pages: total, skipped: doc.numPages - total };
  } finally {
    void task.destroy();
  }
}

/** choose a PDF, import it, then `onDone` with the new deck */
export function choosePdfImport(project: string, notify: (msg: string, kind?: 'error' | 'info') => void, onDone: (id: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    notify(`Importing ${file.name}…`, 'info');
    let last = 0;
    importPdfAsDeck(project, file, (done, total) => { if (done - last >= 10) { last = done; notify(`Importing ${file.name}: page ${done} of ${total}…`, 'info'); } })
      .then(r => {
        notify(r.skipped ? `Imported the first ${r.pages} pages as slides (${r.skipped} more left out).` : `Imported ${r.pages} page${r.pages === 1 ? '' : 's'} as slides.`, 'info');
        onDone(r.id);
      }, e => notify('Could not import the PDF: ' + (e as Error).message, 'error'));
  };
  input.click();
}
