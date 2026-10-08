/**
 * The right-click menu on layout pages: on an object — clipboard, duplicate, delete, z-order,
 * group, lock, the object's own editing (text, nodes, crop, LaTeX) and its animation step; on the
 * empty page — paste, a text box there, the page's commands and the presentation from it. A click
 * into the text of the box being edited keeps the ordinary text menu.
 */
import type { EditorView } from 'prosemirror-view';
import { NodeSelection } from 'prosemirror-state';
import { showContextMenu, type MenuItem } from '../contextmenu';
import { pasteFromClipboard } from '../clipmenu';
import * as L from './commands';
import { isLayoutObject, pageObjects } from './geom';
import { layoutKey, selectObjects, selectedObjects, setTool, layoutControllerOf } from './controller';
import { startPresentation } from './present';
import { openRawEditor } from './rawedit';
import { imageExt, uploadBaseName, uploadUnique } from '../imagepaste';
import { moveToMaster } from './masters';
import { imageToShapes } from './images';
import { copyObjects } from './connectors';
import { toDocRel, viewDocDir, viewProject, editorContext } from '../context';

/** Another picture in the same frame (its position, size and rotation stay; the crop is reset). */
function replaceImage(view: EditorView, pos: number): void {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*,.pdf,.eps,.svg';
  inp.onchange = async () => {
    const file = inp.files?.[0];
    const ext = file ? imageExt(file) : null;
    const project = viewProject(view);
    if (!file || !ext || !project) return;
    try {
      const rel = await uploadUnique(project, uploadBaseName(file), ext, file);
      const n = view.state.doc.nodeAt(pos);
      if (n?.type.name === 'ol_image') view.dispatch(L.setAttrs(view.state.tr, pos, { src: toDocRel(rel, viewDocDir(view)), cl: 0, ct: 0, cr: 0, cb: 0 }));
    } catch (e) { editorContext.notify?.(`Could not upload ${file.name}: ${(e as Error).message}`, 'error'); }
  };
  inp.click();
}

type PageEl = HTMLElement & { olPage?: { pos(): number | undefined; contentDOM: HTMLElement } };

export function layoutContextMenu(view: EditorView, ev: MouseEvent): boolean {
  if (!L.isLayoutDoc(view.state.doc)) return false;
  const target = ev.target as HTMLElement;
  const wrap = target.closest?.('.ol-page-wrap') as PageEl | null;
  if (!wrap?.olPage) return false;
  if (target.closest('.ol-notes')) return false;
  const edited = L.editedBox(view.state);
  const objEl = target.closest('.ol-obj') as HTMLElement | null;
  // the text of the box being edited: the text menu
  if (edited && objEl && target.closest('.ol-box-content') && view.nodeDOM(edited.pos) === objEl) return false;
  ev.preventDefault();
  const pagePos = wrap.olPage.pos();
  if (pagePos === undefined) return true;
  let hit: { node: import('prosemirror-model').Node; pos: number } | null = null;
  if (objEl && !objEl.classList.contains('ol-locked')) {
    try {
      const p = view.posAtDOM(objEl, 0);
      hit = L.objectAt(view.state.doc, p) ?? (isLayoutObject(view.state.doc.nodeAt(p)) ? { node: view.state.doc.nodeAt(p)!, pos: p } : null);
    } catch { hit = null; }
  }
  const run = (f: () => void) => () => { f(); view.focus(); };
  if (hit) {
    const sel = layoutKey.getState(view.state)?.sel ?? [];
    if (!sel.includes(hit.pos)) view.dispatch(selectObjects(view.state.tr, [hit.pos]));
    const objs = selectedObjects(view.state);
    const positions = objs.map(o => o.pos);
    const one = objs.length === 1 ? objs[0] : null;
    const kind = one?.node.type.name;
    const locked = objs.some(o => o.node.attrs.lock);
    const reorder = (how: 'front' | 'back' | 'forward' | 'backward') => run(() => { const r = L.reorder(view.state, positions, how); if (r) view.dispatch(selectObjects(r.tr, r.positions)); });
    const stepItems: MenuItem[] = [
      { label: 'Always shown', checked: !objs.some(o => o.node.attrs.step), action: run(() => { const tr = view.state.tr; for (const p of positions) L.setAttrs(tr, p, { step: null }); view.dispatch(selectObjects(tr, positions)); }) },
      ...[1, 2, 3, 4, 5, 6].map(n => ({ label: `From step ${n}`, checked: objs.every(o => o.node.attrs.step === `${n}-`), action: run(() => { const tr = view.state.tr; for (const p of positions) L.setAttrs(tr, p, { step: `${n}-` }); view.dispatch(selectObjects(tr, positions)); }) })),
    ];
    const items: MenuItem[] = [
      ...(kind === 'ol_box' ? [{ label: 'Edit text', shortcut: 'Enter', action: run(() => view.dispatch(L.caretInto(view.state.tr, one!.pos))) }] : []),
      ...(kind === 'ol_shape' ? [{ label: 'Edit nodes', shortcut: 'N', action: run(() => setTool(view, 'nodes')) }] : []),
      ...(kind === 'ol_image' ? [{ label: 'Crop', shortcut: 'C', action: run(() => setTool(view, 'crop')) }] : []),
      ...(kind === 'ol_raw' ? [{ label: 'Edit LaTeX…', shortcut: 'Enter', action: () => openRawEditor(view, one!.pos) }] : []),
      ...(one && kind !== 'ol_group' ? [{ sep: true } as MenuItem] : []),
      { label: 'Cut', shortcut: 'Ctrl+X', icon: 'cut', action: run(() => { document.execCommand('cut'); }) },
      { label: 'Copy', shortcut: 'Ctrl+C', icon: 'copy', action: run(() => { document.execCommand('copy'); }) },
      { label: 'Paste', shortcut: 'Ctrl+V', icon: 'paste', action: run(() => { void pasteFromClipboard(view); }) },
      { label: 'Duplicate', shortcut: 'Ctrl+D', action: run(() => { const r = L.duplicateObjects(view.state, positions); view.dispatch(selectObjects(r.tr, r.positions)); }) },
      { label: 'Delete', shortcut: 'Delete', icon: 'delete', action: run(() => view.dispatch(L.deleteObjects(view.state, positions).setMeta(layoutKey, { sel: [] }))) },
      { sep: true },
      { label: 'Bring to front', shortcut: 'Ctrl+Shift+]', action: reorder('front') },
      { label: 'Bring forward', shortcut: 'Ctrl+]', action: reorder('forward') },
      { label: 'Send backward', shortcut: 'Ctrl+[', action: reorder('backward') },
      { label: 'Send to back', shortcut: 'Ctrl+Shift+[', action: reorder('back') },
      { sep: true },
      ...(objs.length > 1 ? [{ label: 'Group', shortcut: 'Ctrl+G', action: run(() => { const r = L.group(view.state, positions); if (r) view.dispatch(selectObjects(r.tr, [r.pos])); }) }] : []),
      ...(objs.some(o => o.node.type.name === 'ol_group') ? [{ label: 'Ungroup', shortcut: 'Ctrl+Shift+G', action: run(() => { const r = L.ungroup(view.state, positions); if (r) view.dispatch(selectObjects(r.tr, r.positions)); }) }] : []),
      { label: 'Copy to every page', action: run(() => {
        // the same objects at the same place on all the other pages (a logo, a footer, a page frame)
        const tr = view.state.tr;
        const herePage = L.pageAt(view.state.doc, positions[0]);
        const here = herePage?.pos;
        // (the other slides — or, in the master view, the other masters)
        for (const p of [...L.pages(view.state.doc, L.isMasterPage(herePage?.node) ? 'masters' : 'slides')].reverse()) {
          if (p.pos === here) continue;
          let at = p.pos + p.node.nodeSize - 1;
          if (p.node.lastChild?.type.name === 'ol_notes') at -= p.node.lastChild.nodeSize;
          tr.insert(at, copyObjects(objs.map(o => o.node), p.node));
        }
        view.dispatch(selectObjects(tr, positions.map(q => tr.mapping.map(q, -1))));
      }) },
      // a slide's object onto its master: drawn on every slide of that master (masters.ts)
      ...(pageNodeOf(view, positions[0])?.attrs.master && !L.isMasterPage(pageNodeOf(view, positions[0])) ? [{ label: `Move to the master (${pageNodeOf(view, positions[0])!.attrs.master})`, action: run(() => { const tr = moveToMaster(view.state, positions); if (tr) view.dispatch(tr.setMeta(layoutKey, { sel: [] })); }) } as MenuItem] : []),
      ...(kind === 'ol_image' ? [{ label: 'Replace image…', icon: 'image', action: () => replaceImage(view, one!.pos) } as MenuItem] : []),
      // an SVG picture as editable shapes (images.ts imageToShapes)
      ...(kind === 'ol_image' && /\.svg$/i.test(String(one!.node.attrs.src ?? '')) ? [{ label: 'Convert to shapes', action: () => { void imageToShapes(view, one!.pos); } } as MenuItem] : []),
      { label: locked ? 'Unlock' : 'Lock in place', action: run(() => { const tr = view.state.tr; for (const p of positions) L.setAttrs(tr, p, { lock: !locked }); view.dispatch(selectObjects(tr, positions)); }) },
      { label: 'Animation', sub: stepItems },
    ];
    showContextMenu(ev.clientX, ev.clientY, items);
    return true;
  }
  // the empty page
  const rect = wrap.olPage.contentDOM.getBoundingClientRect();
  const ctl = layoutControllerOf(view);
  const page = ctl?.page ?? { w: 160, h: 90 };
  const at: [number, number] = [(ev.clientX - rect.left) * page.w / rect.width, (ev.clientY - rect.top) * page.h / rect.height];
  const pageNode = view.state.doc.nodeAt(pagePos)!;
  const items: MenuItem[] = [
    { label: 'Paste', shortcut: 'Ctrl+V', icon: 'paste', action: run(() => { void pasteFromClipboard(view); }) },
    { label: 'Text box here', action: run(() => {
      const r = L.insertObject(view.state, pagePos, L.makeBox({ x: at[0], y: at[1], w: Math.max(20, Math.min(page.w * 0.4, page.w - at[0])), h: 10, grow: true }));
      view.dispatch(L.caretInto(r.tr, r.pos));
    }) },
    { label: 'Select all on this page', shortcut: 'Ctrl+A', action: run(() => view.dispatch(selectObjects(view.state.tr, pageObjects(pageNode, pagePos).filter(o => !o.node.attrs.lock).map(o => o.pos)))) },
    { sep: true },
    { label: 'New page after this one', action: run(() => view.dispatch(L.insertPage(view.state, pagePos + pageNode.nodeSize))) },
    { label: 'Duplicate this page', action: run(() => view.dispatch(L.insertPage(view.state, pagePos + pageNode.nodeSize, pageNode))) },
    { label: 'Delete this page', action: run(() => { const tr = L.deletePage(view.state, pagePos); if (tr) view.dispatch(tr); }) },
    { sep: true },
    { label: 'Present from this page', shortcut: 'Shift+F5', action: () => {
      // the presentation starts at the page the menu was opened on
      const s = view.state.selection;
      if (!(s instanceof NodeSelection)) { const first = pageObjects(pageNode, pagePos)[0]; if (first) view.dispatch(selectObjects(view.state.tr, [first.pos])); }
      startPresentation(view, { fromCurrent: true });
    } },
  ];
  showContextMenu(ev.clientX, ev.clientY, items);
  return true;
}

function pageNodeOf(view: EditorView, pos: number | undefined): import('prosemirror-model').Node | null {
  return pos === undefined ? null : L.pageAt(view.state.doc, pos)?.node ?? null;
}
