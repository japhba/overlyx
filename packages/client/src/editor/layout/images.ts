/**
 * Images on layout pages: uploaded (paste, drop, the toolbar) into the project's figures/ like
 * images in the text, then placed as an image object — at the drop point, or centred on the page —
 * sized to the picture's proportions.
 */
import type { EditorView } from 'prosemirror-view';
import { NodeSelection } from 'prosemirror-state';
import { schema } from '@overlyx/core';
import { graphicsUrl, fileUrl } from '../../api';
import { editorContext, resolveDocPath, toDocRel, viewDocDir, viewProject } from '../context';
import { imageExt, imageFiles, isSvgMarkup, svgFile, uploadBaseName, uploadUnique } from '../imagepaste';
import { isLayoutDoc, insertObject, pageAt } from './commands';
import { isLayoutObject } from './geom';
import { layoutControllerOf, selectObjects } from './controller';
import { svgToLayoutObjects } from './svgimport';
import { copyObjects } from './connectors';

/** The natural aspect ratio (height / width) of a project image, as the editor's image route renders it. */
export function imageAspect(view: EditorView, docRel: string): Promise<number> {
  const project = viewProject(view);
  return new Promise(resolve => {
    if (!project || typeof Image === 'undefined') { resolve(0.75); return; }
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0.75);
    img.onerror = () => resolve(0.75);
    img.src = graphicsUrl(project, resolveDocPath(docRel, viewDocDir(view)), 800);
  });
}

/** Place a project image (document-relative path) on a page: centred at (cx, cy) mm, or the page's centre. */
export async function placeImage(view: EditorView, docRel: string, pagePos?: number, at?: [number, number]): Promise<void> {
  const ctl = layoutControllerOf(view);
  const page = pagePos ?? ctl?.currentPage()?.pos;
  if (page === undefined || !ctl) return;
  const ratio = await imageAspect(view, docRel);
  const { w: pw, h: ph } = ctl.page;
  let w = pw * 0.4, h = w * ratio;
  if (h > ph * 0.6) { h = ph * 0.6; w = h / ratio; }
  const [cx, cy] = at ?? [pw / 2, ph / 2];
  const node = schema.nodes.ol_image.create({ src: docRel, x: r(cx - w / 2), y: r(cy - h / 2), w: r(w), h: r(h) });
  const cur = view.state.doc.nodeAt(page);
  if (!cur || cur.type.name !== 'ol_page') return;
  const res = insertObject(view.state, page, node);
  view.dispatch(selectObjects(res.tr, [res.pos]));
  view.focus();
}
const r = (n: number) => Math.round(n * 100) / 100;

/** Upload image files and place each (offset a little so several do not cover each other). */
export async function placeImageFiles(view: EditorView, files: File[], pagePos?: number, at?: [number, number]): Promise<void> {
  const project = viewProject(view);
  if (!project) return;
  let i = 0;
  for (const file of files) {
    const ext = imageExt(file);
    if (!ext) continue;
    try {
      const rel = await uploadUnique(project, uploadBaseName(file), ext, file);
      await placeImage(view, toDocRel(rel, viewDocDir(view)), pagePos, at ? [at[0] + 6 * i, at[1] + 6 * i] : undefined);
      editorContext.notify?.(`Image saved as ${rel}`);
      i++;
    } catch (e) {
      editorContext.notify?.(`Could not upload ${file.name || 'the image'}: ${(e as Error).message}`, 'error');
    }
  }
}

/** Is the editor in object mode on a layout page (objects selected, no text being edited)? */
function objectMode(view: EditorView): boolean {
  const s = view.state.selection;
  return s instanceof NodeSelection && isLayoutObject(s.node);
}

/**
 * A paste on a layout document, before the text editor's own handling: images become image
 * objects; with objects selected nothing may replace them (text becomes a new text box — the
 * layout plugin's handlePaste does that once ProseMirror has parsed it).
 */
export function layoutPaste(view: EditorView, event: ClipboardEvent): boolean {
  if (!isLayoutDoc(view.state.doc)) return false;
  const images = imageFiles(event.clipboardData);
  const text = event.clipboardData?.getData('text/plain') ?? '';
  const inBox = !objectMode(view) && !!pageAt(view.state.doc, view.state.selection.from) && view.state.selection.$from.parent.type.name === 'paragraph';
  // an SVG (Inkscape, Illustrator, a plot): editable shapes, not a picture
  const svgs = images.filter(f => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name));
  if (svgs.length === 1 && images.length === 1 && !inBox) { void svgs[0].text().then(t => { if (!placeSvg(view, t)) void placeImageFiles(view, images); }); return true; }
  if (images.length && !inBox) { void placeImageFiles(view, images); return true; }
  if (!inBox && text && isSvgMarkup(text)) { if (!placeSvg(view, text)) void placeImageFiles(view, [svgFile(text)]); return true; }
  return false;
}

/** SVG markup as shapes and text boxes on the current page (svgimport.ts); false when nothing in it can be drawn. */
export function placeSvg(view: EditorView, svg: string, at?: [number, number]): boolean {
  const ctl = layoutControllerOf(view);
  const page = ctl?.currentPage();
  if (!ctl || !page) return false;
  const r = svgToLayoutObjects(svg, { page: ctl.page, at });
  if (!r.nodes.length) return false;
  // on top of the page's objects, before its notes
  let end = page.pos + page.node.nodeSize - 1;
  if (page.node.lastChild?.type.name === 'ol_notes') end -= page.node.lastChild.nodeSize;
  const tr = view.state.tr;
  const made: number[] = [];
  for (const n of copyObjects(r.nodes, page.node)) { tr.insert(end, n); made.push(end); end += n.nodeSize; }
  view.dispatch(selectObjects(tr, made));
  if (r.warnings.length) editorContext.notify?.(`Pasted as shapes — ${r.warnings[0]}${r.warnings.length > 1 ? ` (and ${r.warnings.length - 1} more)` : ''}`, 'info');
  return true;
}

/**
 * An SVG picture on a page turned into shapes and text boxes where it is (PowerPoint's "Convert to
 * Shape"): its file is read, drawn into the picture's frame, and takes its place in the drawing order.
 */
export async function imageToShapes(view: EditorView, pos: number): Promise<void> {
  const img = view.state.doc.nodeAt(pos);
  const project = viewProject(view);
  const ctl = layoutControllerOf(view);
  if (!img || img.type.name !== 'ol_image' || !project || !ctl) return;
  const file = resolveDocPath(String(img.attrs.src ?? ''), viewDocDir(view));
  let text = '';
  try {
    const res = await fetch(fileUrl(project, file), { credentials: 'include' });
    if (!res.ok) throw new Error(`${res.status}`);
    text = await res.text();
  } catch (e) { editorContext.notify?.(`Could not read ${file}: ${(e as Error).message}`, 'error'); return; }
  const r = svgToLayoutObjects(text, { page: ctl.page, into: { x: Number(img.attrs.x), y: Number(img.attrs.y), w: Number(img.attrs.w), h: Number(img.attrs.h) } });
  if (!r.nodes.length) { editorContext.notify?.(`Nothing in ${file} can be drawn as shapes${r.warnings.length ? ` (${r.warnings[0]})` : ''}`, 'error'); return; }
  // the picture may have moved meanwhile: found again by its node
  let at = -1;
  view.state.doc.descendants((n, p) => { if (n === img) at = p; return at < 0; });
  if (at < 0) return;
  const page = pageAt(view.state.doc, at);
  const nodes = copyObjects(r.nodes, page?.node ?? null).map(n => (img.attrs.step || img.attrs.name ? n.type.create({ ...n.attrs, step: img.attrs.step, effect: img.attrs.effect, name: n.attrs.name ?? img.attrs.name }, n.content, n.marks) : n));
  const tr = view.state.tr.replaceWith(at, at + img.nodeSize, nodes);
  view.dispatch(selectObjects(tr, [at]));
  const notes = [...(img.attrs.rot ? ['the picture’s rotation is not kept'] : []), ...(Number(img.attrs.cl) || Number(img.attrs.ct) || Number(img.attrs.cr) || Number(img.attrs.cb) ? ['its crop is not kept'] : []), ...r.warnings];
  if (notes.length) editorContext.notify?.(`Converted to shapes — ${notes[0]}${notes.length > 1 ? ` (and ${notes.length - 1} more)` : ''}`, 'info');
}

/** Files dropped onto a page: images are placed where they were dropped. */
export function layoutDrop(view: EditorView, event: DragEvent): boolean {
  if (!isLayoutDoc(view.state.doc) || !event.dataTransfer?.files.length) return false;
  const images = imageFiles(event.dataTransfer);
  if (!images.length) return false;
  const pageEl = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest('.ol-page-wrap') as (HTMLElement & { olPage?: { pos(): number | undefined; contentDOM: HTMLElement } }) | null;
  const pv = pageEl?.olPage;
  const pos = pv?.pos();
  const ctl = layoutControllerOf(view);
  if (!pv || pos === undefined || !ctl) { void placeImageFiles(view, images); return true; }
  const rect = pv.contentDOM.getBoundingClientRect();
  const at: [number, number] = [(event.clientX - rect.left) * ctl.page.w / rect.width, (event.clientY - rect.top) * ctl.page.h / rect.height];
  // one SVG (Inkscape, a plot): editable shapes where it was dropped, as when it is pasted
  const svgs = images.filter(f => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name));
  if (svgs.length === 1 && images.length === 1) { void svgs[0].text().then(t => { if (!placeSvg(view, t, at)) void placeImageFiles(view, images, pos, at); }); return true; }
  void placeImageFiles(view, images, pos, at);
  return true;
}
