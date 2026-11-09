/**
 * Figure drafts (core/figuredraft.ts): every figure may have a draft drawn in OverLyX beside its final
 * file — `figures/plot.olx.svg` next to `figures/plot.pdf`. Right-click ▸ Insert figure makes a figure
 * with an empty draft and opens it in the drawing editor with the pen in hand; the switch on a figure
 * (nodeviews/leaf.ts), its right-click menu, and the same entries on slides and layout pages show the
 * one or the other by changing the name the document uses, so the PDF shows it too. A draft is drawn
 * on; a final figure is only edited (an SVG one in the same editor, the Select tool in hand) or replaced.
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { blankDraftSvg, draftOfFigure, figureBase, finalCandidates, isFigureDraft, paramMap, switchFigureName, unquote, FINAL_ENDINGS } from '@overlyx/core';
import { api, fileUrl } from '../api';
import { uiConfirm } from '../app/Dialogs';
import { insertFloat, insertGraphics } from './commands';
import { editorContext, figureCandidates, figureFile, toDocRel, viewDocDir, viewDocId, viewProject } from './context';
import { imageExt } from './imagepaste';
import { isMarkdownDoc } from './markdown';
import { isLayoutDoc } from './layout/commands';
import { placeImage } from './layout/images';
import { editSvgFile } from './svgEditorEvents';
import type { MenuItem } from './contextmenu';

/* ------------------------------------------------------------------ files */

/** Is there a file at this project path? The editor's file list says yes at once; else the server is asked (a plot just written). */
export async function fileThere(project: string, rel: string): Promise<boolean> {
  if (project === editorContext.project && editorContext.meta?.files?.some(f => f.path === rel)) return true;
  try { return (await fetch(fileUrl(project, rel), { method: 'HEAD', credentials: 'include', cache: 'no-store' })).ok; }
  catch { return false; }
}

/** The final figure of the draft `draftRel` (project paths), the first ending found in FINAL_ENDINGS' order; null: none yet. */
export async function findFinal(project: string, draftRel: string): Promise<string | null> {
  const cands = finalCandidates(draftRel);
  const there = await Promise.all(cands.map(c => fileThere(project, c)));
  return cands[there.indexOf(true)] ?? null;
}

/**
 * A new, empty draft at a free name in `dir`: `figure.olx.svg`, `figure-2.olx.svg` … — free for its
 * final too, so a plot saved later under the same name pairs with it. `upload` puts a file there and
 * rejects when the name is taken (a deck's host does it its own way). Returns the project path.
 */
export async function newDraft(project: string, dir: string, base = 'figure', size?: { w: number; h: number }, upload?: (rel: string, data: Blob) => Promise<void>): Promise<string> {
  const put = upload ?? ((rel: string, data: Blob) => api.upload(project, rel, data, { overwrite: false }).then(() => {}));
  const svg = new Blob([blankDraftSvg(size?.w, size?.h)], { type: 'image/svg+xml' });
  for (let i = 1; i <= 100; i++) {
    const stem = `${dir ? dir + '/' : ''}${base}${i > 1 ? '-' + i : ''}`;
    if (await findFinal(project, stem + '.olx.svg')) continue;
    try { await put(stem + '.olx.svg', svg); return stem + '.olx.svg'; }
    catch (e) { const status = (e as { status?: number }).status; if (status !== undefined && status !== 409) throw e; }
  }
  throw new Error('no free file name');
}

/** The draft in the drawing editor with the pen in hand; its figures reload once it is saved. */
export function drawDraft(project: string, rel: string, readOnly: boolean, extra: { onSaved?(): void; onDiscard?(): void } = {}): void {
  editSvgFile(project, rel, readOnly, { ...extra, draw: true });
}

/** A file chosen on this computer (null: none). */
export function chooseFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept;
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.addEventListener('cancel', () => resolve(null));
    inp.click();
  });
}

const FINAL_ACCEPT = 'image/*,.pdf,.eps,.svg';

/**
 * The final figure of the draft `draftRel` uploaded from this computer, saved beside the draft under its
 * name (`plot.olx.svg` → `plot.pdf`); its project path, or null when nothing was chosen.
 */
export async function uploadFinal(project: string, draftRel: string, upload?: (rel: string, data: Blob) => Promise<void>): Promise<string | null> {
  const file = await chooseFile(FINAL_ACCEPT);
  if (!file) return null;
  const ext = imageExt(file);
  if (!ext || !FINAL_ENDINGS.includes('.' + ext)) { editorContext.notify?.(`${file.name} is not a figure OverLyX pairs with a draft (${FINAL_ENDINGS.join(' ')}).`, 'error'); return null; }
  const rel = figureBase(draftRel) + '.' + ext;
  if (upload) await upload(rel, file); else await api.upload(project, rel, file);
  return rel;
}

/**
 * No final figure yet for the draft: where to put one, and the offer to upload it now. Resolves with
 * the uploaded file's project path, or null.
 */
export async function askForFinal(project: string, draftRel: string, upload?: (rel: string, data: Blob) => Promise<void>): Promise<string | null> {
  const base = figureBase(draftRel), name = base.split('/').pop();
  const ok = await uiConfirm('No final figure yet',
    `The final figure goes beside its draft as ${base}.pdf (or ${FINAL_ENDINGS.filter(e => e !== '.pdf').map(e => name + e).slice(0, 3).join(', ')} …) — a plotting script can save it there. Then switch to it here. Or upload it now.`,
    { okLabel: 'Upload the final figure…' });
  if (!ok) return null;
  try { return await uploadFinal(project, draftRel, upload); }
  catch (e) { editorContext.notify?.(`Could not upload the final figure: ${(e as Error).message}`, 'error'); return null; }
}

/* ------------------------------------------------------------------ documents */

function graphicsParams(node: PMNode): string[] {
  try { return JSON.parse(node.attrs.params || '[]'); } catch { return []; }
}

/** The figure's file name as the document writes it (unquoted). */
export function figureName(node: PMNode): string {
  return unquote(paramMap(graphicsParams(node)).get('filename') ?? '');
}

/** The graphics node at `pos` if it still names `name`, else the first one that does (the document changed meanwhile); null: gone. */
function findFigure(view: EditorView, pos: number, name: string): { node: PMNode; pos: number } | null {
  const at = view.state.doc.nodeAt(pos);
  if (at?.type.name === 'graphics' && figureName(at) === name) return { node: at, pos };
  let hit: { node: PMNode; pos: number } | null = null;
  view.state.doc.descendants((n, p) => {
    if (hit) return false;
    if (n.type.name === 'graphics' && figureName(n) === name) hit = { node: n, pos: p };
    // (insets, floats among them, are inline nodes with paragraphs inside: looked into too)
    return true;
  });
  return hit;
}

/** The figure's file name set to `name` (quoted when the old one was). */
function renameFigure(view: EditorView, pos: number, node: PMNode, name: string): void {
  const lines = graphicsParams(node);
  const i = lines.findIndex(l => l.replace(/^\t/, '').startsWith('filename '));
  const old = i >= 0 ? lines[i].replace(/^\t/, '').slice('filename '.length) : '';
  const value = old.startsWith('"') || /\s/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name;
  if (i >= 0) lines[i] = `\tfilename ${value}`; else lines.unshift(`\tfilename ${value}`);
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, params: JSON.stringify(lines) }));
}

/** The figure's two versions as project paths: the file it shows now, and whether that is the draft. */
export function figureVersions(view: EditorView, node: PMNode): { name: string; rel: string; draft: boolean } {
  const name = figureName(node);
  const rel = figureFile(name, viewDocDir(view));
  return { name, rel, draft: isFigureDraft(name) };
}

/** The pixel shape of the figure on screen (height / width), for a new draft of the same shape. */
function shownAspect(view: EditorView, pos: number): number | null {
  const img = (view.nodeDOM(pos) as HTMLElement | null)?.querySelector?.('img');
  return img && img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : null;
}

/** A picture somewhere — a document's figure, a layout page's image, a slide's picture — as the switch sees it. */
export interface FigureSlot {
  project: string;
  /** the file's name as written there (relative to the document or page) */
  name: string;
  /** the project path of the file it shows */
  rel: string;
  /** height / width of the picture shown, for a new draft of its shape */
  aspect?: number | null;
  readOnly: boolean;
  /** the picture named `from` renamed `to`; false when it is gone (changed meanwhile) */
  rename(from: string, to: string): boolean;
  /** a file put into the project (project path), rejecting when the name is taken; absent: the server's upload */
  upload?(rel: string, data: Blob): Promise<void>;
}

/**
 * Show the picture as its draft or as its final figure. A draft not drawn yet is made (empty, in the
 * final figure's shape) and opened with the pen; closed unsaved, the picture shows the final again and
 * the draft goes. A final not there yet: where it goes, or upload it. `draw` opens the draft for drawing.
 */
export async function switchVersion(s: FigureSlot, to: 'draft' | 'final', draw = false): Promise<void> {
  const draft = isFigureDraft(s.name);
  if (to === 'final') {
    if (!draft) return;
    const fin = await findFinal(s.project, s.rel) ?? (s.readOnly ? null : await askForFinal(s.project, s.rel, s.upload));
    if (!fin) { if (s.readOnly) editorContext.notify?.('This figure has no final version yet.'); return; }
    if (!s.readOnly) s.rename(s.name, switchFigureName(s.name, fin));
    return;
  }
  if (draft) { if (draw) drawDraft(s.project, s.rel, s.readOnly); return; }
  const draftRel = draftOfFigure(s.rel), draftName = switchFigureName(s.name, draftRel);
  if (await fileThere(s.project, draftRel)) {
    if (s.readOnly) { if (draw) drawDraft(s.project, draftRel, true); return; }
    if (s.rename(s.name, draftName) && draw) drawDraft(s.project, draftRel, false);
    return;
  }
  if (s.readOnly) { editorContext.notify?.('This figure has no draft.'); return; }
  const blank = new Blob([blankDraftSvg(640, s.aspect ? 640 * s.aspect : 360)], { type: 'image/svg+xml' });
  try { await (s.upload ? s.upload(draftRel, blank) : api.upload(s.project, draftRel, blank, { overwrite: false })); }
  catch (e) { editorContext.notify?.(`Could not make the draft: ${(e as Error).message}`, 'error'); return; }
  const drop = () => { void api.fileOp(s.project, { op: 'delete', from: draftRel }).catch(() => {}); };
  if (!s.rename(s.name, draftName)) { drop(); return; }
  drawDraft(s.project, draftRel, false, { onDiscard: () => { s.rename(draftName, s.name); drop(); } });
}

/** The final figure uploaded from this computer (named after the draft) and shown. */
export async function replaceFinalOf(s: FigureSlot): Promise<void> {
  if (s.readOnly) return;
  let fin: string | null;
  try { fin = await uploadFinal(s.project, draftOfFigure(s.rel), s.upload); }
  catch (e) { editorContext.notify?.(`Could not upload the final figure: ${(e as Error).message}`, 'error'); return; }
  if (!fin) return;
  s.rename(s.name, switchFigureName(s.name, fin));
  // (the same name as before: the pictures showing it load it again)
  window.dispatchEvent(new CustomEvent('ol:svg-saved', { detail: { project: s.project, path: fin } }));
}

/** A picture's entries in a right-click menu: which version shows, drawing the draft, the final uploaded. */
export function figureMenuItems(s: FigureSlot | null, opts: { drawShortcut?: string } = {}): MenuItem[] {
  if (!s) return [];
  const draft = isFigureDraft(s.name), ro = s.readOnly;
  return [
    { label: 'Show the draft', checked: draft, disabled: ro, action: () => void switchVersion(s, 'draft') },
    { label: 'Show the final figure', checked: !draft, disabled: ro, action: () => void switchVersion(s, 'final') },
    { label: draft ? 'Draw on the draft…' : 'Draw the draft…', icon: 'edit', ...(draft && opts.drawShortcut ? { shortcut: opts.drawShortcut } : {}), disabled: ro && !draft, action: () => void switchVersion(s, 'draft', true) },
    { label: draft ? 'Upload the final figure…' : 'Replace the final figure…', icon: 'image', disabled: ro, action: () => void replaceFinalOf(s) },
  ];
}

/** The figure at `pos`'s entries (figureMenuItems). */
export function figureMenuAt(view: EditorView, pos: number): MenuItem[] {
  return figureMenuItems(docSlot(view, pos), { drawShortcut: 'double-click' });
}

/** The document's figure at `pos` as a slot (null: no figure there). */
function docSlot(view: EditorView, pos: number): FigureSlot | null {
  const project = viewProject(view) || editorContext.project;
  const node = view.state.doc.nodeAt(pos);
  if (!project || node?.type.name !== 'graphics') return null;
  const { name, rel } = figureVersions(view, node);
  if (!name) return null;
  return {
    project, name, rel, aspect: shownAspect(view, pos), readOnly: !view.editable,
    rename: (from, to) => {
      const hit = findFigure(view, pos, from);
      if (!hit || !view.editable) return false;
      renameFigure(view, hit.pos, hit.node, to);
      return true;
    },
  };
}

/** The figure at `pos` as its draft or its final figure (switchVersion). */
export async function showFigureVersion(view: EditorView, pos: number, to: 'draft' | 'final', draw = false): Promise<void> {
  const s = docSlot(view, pos);
  if (s) await switchVersion(s, to, draw);
}

/** The final figure of the figure at `pos` uploaded and shown. */
export async function replaceFinal(view: EditorView, pos: number): Promise<void> {
  const s = docSlot(view, pos);
  if (s) await replaceFinalOf(s);
}

/** A layout page's image (ol_image at `pos`) as a slot. */
export function layoutImageSlot(view: EditorView, pos: number): FigureSlot | null {
  const project = viewProject(view) || editorContext.project;
  const node = view.state.doc.nodeAt(pos);
  const name = String(node?.attrs.src ?? '');
  if (!project || node?.type.name !== 'ol_image' || !name) return null;
  return {
    project, name, rel: figureFile(name, viewDocDir(view)), aspect: shownAspect(view, pos) ?? (node.attrs.w ? Number(node.attrs.h) / Number(node.attrs.w) : null),
    readOnly: !view.editable,
    rename: (from, to) => {
      let at = view.state.doc.nodeAt(pos)?.attrs.src === from ? pos : -1;
      if (at < 0) view.state.doc.descendants((n, p) => { if (at < 0 && n.type.name === 'ol_image' && n.attrs.src === from) at = p; return at < 0; });
      if (at < 0 || !view.editable) return false;
      const n = view.state.doc.nodeAt(at)!;
      view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...n.attrs, src: to }));
      return true;
    },
  };
}

/**
 * Every figure of the document as its draft or its final figure — those that have one (no draft is made,
 * no final asked for). One undo step; says how many changed and how many have none.
 */
export async function showAllFigures(view: EditorView, to: 'draft' | 'final'): Promise<void> {
  const project = viewProject(view) || editorContext.project;
  if (!project || !view.editable) return;
  const figs: { pos: number; name: string; rel: string }[] = [];
  view.state.doc.descendants((n, p) => {
    if (n.type.name === 'graphics') {
      const { name, rel, draft } = figureVersions(view, n);
      if (name && draft === (to === 'final')) figs.push({ pos: p, name, rel });
    }
    return true;
  });
  if (!figs.length) { editorContext.notify?.(to === 'final' ? 'Every figure shows its final version already.' : 'Every figure shows its draft already.'); return; }
  const other = await Promise.all(figs.map(f => to === 'final' ? findFinal(project, f.rel) : fileThere(project, draftOfFigure(f.rel)).then(ok => ok ? draftOfFigure(f.rel) : null)));
  const tr = view.state.tr;
  let changed = 0;
  figs.forEach((f, i) => {
    const target = other[i];
    if (!target) return;
    const pos = tr.mapping.map(f.pos);
    const n = tr.doc.nodeAt(pos);
    if (n?.type.name !== 'graphics' || figureName(n) !== f.name) return;
    const lines = graphicsParams(n);
    const k = lines.findIndex(l => l.replace(/^\t/, '').startsWith('filename '));
    if (k < 0) return;
    const quoted = lines[k].replace(/^\t/, '').slice('filename '.length).startsWith('"');
    const next = switchFigureName(f.name, target);
    lines[k] = `\tfilename ${quoted ? `"${next}"` : next}`;
    tr.setNodeMarkup(pos, undefined, { ...n.attrs, params: JSON.stringify(lines) });
    changed++;
  });
  if (changed) view.dispatch(tr);
  const missing = figs.length - changed;
  const what = to === 'final' ? 'final version' : 'draft';
  editorContext.notify?.(`${changed} figure${changed === 1 ? '' : 's'} now show${changed === 1 ? 's' : ''} ${to === 'final' ? 'the final version' : 'the draft'}${missing ? ` — ${missing} ha${missing === 1 ? 's' : 've'} no ${what} yet` : ''}.`);
}

/**
 * Right-click ▸ Insert figure: a figure (a float with its caption; in markdown the picture alone) whose
 * draft — figures/figure.olx.svg, figure-2 … — opens at once with the pen; the cursor waits in the
 * caption. Closed without saving, the figure and its draft go again.
 */
export async function insertDraftFigure(view: EditorView): Promise<void> {
  const project = viewProject(view) || editorContext.project;
  if (!project || !view.editable) return;
  let rel: string;
  try { rel = await newDraft(project, 'figures'); }
  catch (e) { editorContext.notify?.(`Could not make the figure: ${(e as Error).message}`, 'error'); return; }
  const file = toDocRel(rel, viewDocDir(view));
  // (a selection stays where it is: the figure comes after it)
  const sel = view.state.selection;
  if (!sel.empty) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(sel.to), -1)));
  const floated = !isMarkdownDoc(viewDocId(view)) && !isLayoutDoc(view.state.doc) && sel.$from.parent.inlineContent && insertFloat('figure')(view.state, view.dispatch);
  insertGraphics(file, { width: '60col%' })(view.state, view.dispatch);
  if (floated) captionCaret(view);
  view.focus();
  drawDraft(project, rel, false, {
    onDiscard: () => {
      const tr = view.state.tr;
      view.state.doc.descendants((n, p) => {
        if (n.type.name !== 'graphics') return true;
        if (!figureCandidates(figureName(n), viewDocDir(view)).includes(rel)) return false;
        // the float it came in, when nothing else was put into it
        const $p = view.state.doc.resolve(p);
        let from = p, to = p + n.nodeSize;
        for (let d = $p.depth; d > 0; d--) {
          const a = $p.node(d);
          if (a.type.name === 'inset' && a.attrs.name === 'Float') { if (!a.textContent.trim()) { from = $p.before(d); to = $p.after(d); } break; }
        }
        tr.delete(tr.mapping.map(from), tr.mapping.map(to));
        return false;
      });
      if (tr.docChanged) view.dispatch(tr);
      void api.fileOp(project, { op: 'delete', from: rel }).catch(() => {});
    },
  });
}

/** The cursor into the caption of the float it is in (just made by insertDraftFigure). */
function captionCaret(view: EditorView): void {
  const $from = view.state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const a = $from.node(d);
    if (a.type.name !== 'inset' || a.attrs.name !== 'Float') continue;
    const start = $from.start(d);
    let at = -1;
    a.descendants((n, p) => { if (at < 0 && n.type.name === 'inset' && n.attrs.name === 'Caption') at = start + p; return at < 0; });
    if (at >= 0) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at + 2))).scrollIntoView());
    return;
  }
}

/** A layout page's Figure here: an image of an empty draft on the page (`at`, mm), drawn at once; closed unsaved, both go again. */
export async function insertLayoutDraftFigure(view: EditorView, pagePos: number, at?: [number, number]): Promise<void> {
  const project = viewProject(view) || editorContext.project;
  if (!project || !view.editable) return;
  let rel: string;
  try { rel = await newDraft(project, 'figures'); }
  catch (e) { editorContext.notify?.(`Could not make the figure: ${(e as Error).message}`, 'error'); return; }
  const src = toDocRel(rel, viewDocDir(view));
  await placeImage(view, src, pagePos, at);
  drawDraft(project, rel, false, {
    onDiscard: () => {
      const tr = view.state.tr;
      view.state.doc.descendants((n, p) => {
        if (n.type.name === 'ol_image' && n.attrs.src === src) tr.delete(tr.mapping.map(p), tr.mapping.map(p + n.nodeSize));
        return !n.isLeaf;
      });
      if (tr.docChanged) view.dispatch(tr);
      void api.fileOp(project, { op: 'delete', from: rel }).catch(() => {});
    },
  });
}
