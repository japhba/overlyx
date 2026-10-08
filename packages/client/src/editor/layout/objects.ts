/**
 * The objects list of layout pages — Inkscape's Objects dialog, PowerPoint's Selection pane: the
 * objects of the page shown on the canvas, top-most first, groups unfolded under theirs. A click
 * selects an object (Shift / Ctrl adds it), a double click renames it, the eye hides it (not drawn —
 * in the PDF neither: `hide`), the lock keeps the canvas from picking it, and dragging a row changes the
 * drawing order among its neighbours. The objects the page's master draws are listed below, greyed
 * (they are edited on the master). The list lies over the right edge of the scroller (`--ol-objects-w`
 * makes room on the canvas), and is shown or not as the reader last had it.
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import * as L from './commands';
import { layoutKey, selectObjects, setMasterView } from './controller';
import { masterChain } from './masters';
import { isConnector } from './connectors';

export interface ObjectsHost {
  /** the page the canvas shows */
  currentPage(): { pos: number } | null;
  /** the room for the canvas changed */
  refit(): void;
  close(): void;
}

const WIDTH = 236;
const STORE = 'ol.objects';

/** Is the objects list shown (remembered per browser)? */
export function objectsShown(): boolean {
  try { return localStorage.getItem(STORE) === '1'; } catch { return false; }
}
export function rememberObjectsShown(on: boolean): void {
  try { localStorage.setItem(STORE, on ? '1' : '0'); } catch { /* not remembered */ }
}

const ICONS: Record<string, string> = {
  ol_box: '<path d="M3 4h10M3 7h10M3 10h7"/>',
  ol_shape: '<rect x="3" y="3.5" width="10" height="9" rx="1"/>',
  line: '<path d="M3 13 13 3"/>',
  arrow: '<path d="M3 13 13 3M8 3h5v5"/>',
  connector: '<circle cx="3.5" cy="12.5" r="1.5"/><circle cx="12.5" cy="3.5" r="1.5"/><path d="M5 11l6-6"/>',
  ol_image: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="m3 11 3.5-3.5 2.5 2.5 1.5-1.5 2.5 2.5"/>',
  ol_raw: '<path d="M6 4 3 8l3 4M10 4l3 4-3 4"/>',
  ol_group: '<rect x="2.5" y="2.5" width="7" height="6"/><rect x="6.5" y="7.5" width="7" height="6"/>',
};
const icon = (k: string) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] ?? ICONS.ol_shape}</svg>`;
const EYE = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" opacity="0.45"/><path d="M2.5 13.5 13.5 2.5"/></svg>';
const LOCK = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
const UNLOCK = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true" opacity="0.45"><rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5-.5"/></svg>';

/** what a row calls an object without a name */
export function objectLabel(n: PMNode): { kind: string; text: string } {
  const name = n.type.name;
  if (name === 'ol_box') {
    const t = n.textContent.trim().replace(/\s+/g, ' ');
    return { kind: 'ol_box', text: n.attrs.name ? String(n.attrs.name) : t ? (t.length > 40 ? t.slice(0, 40) + '…' : t) : 'Text box' };
  }
  if (name === 'ol_shape') {
    const kind = isConnector(n) ? 'connector' : /^M[^MCZ]*L[^MCZ]*$/.test(String(n.attrs.d).trim()) ? (n.attrs.arrows ? 'arrow' : 'line') : 'ol_shape';
    const text = n.attrs.name ? String(n.attrs.name) : kind === 'connector' ? 'Connector' : kind === 'arrow' ? 'Arrow' : kind === 'line' ? 'Line' : 'Shape';
    return { kind, text };
  }
  if (name === 'ol_image') return { kind: 'ol_image', text: n.attrs.name ? String(n.attrs.name) : String(n.attrs.src ?? '').split('/').pop() || 'Image' };
  if (name === 'ol_raw') return { kind: 'ol_raw', text: n.attrs.name ? String(n.attrs.name) : 'LaTeX' };
  if (name === 'ol_group') return { kind: 'ol_group', text: n.attrs.name ? String(n.attrs.name) : `Group (${n.childCount})` };
  return { kind: name, text: name };
}

interface Row { pos: number; node: PMNode; depth: number; parent: number; index: number; siblings: number; path: string }

export class ObjectsPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private title: HTMLElement;
  private key = '';
  private raf = 0;
  private rows: Row[] = [];
  private folded = new Set<string>();
  private drag: { row: Row; y: number; id: number; moved: boolean; target: number } | null = null;
  private drop: HTMLElement;
  private ro: ResizeObserver | null = null;
  /** a name being edited: the list is not drawn again meanwhile */
  private renaming = false;

  constructor(private view: EditorView, private scroller: HTMLElement, private host: ObjectsHost) {
    this.el = document.createElement('div');
    this.el.className = 'ol-objects';
    this.el.dataset.olObjects = '';
    const head = document.createElement('div');
    head.className = 'ol-objects-head';
    this.title = document.createElement('span');
    this.title.className = 'ol-objects-title';
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'ol-objects-close'; close.textContent = '×'; close.title = 'Hide the objects list';
    close.addEventListener('click', () => this.host.close());
    head.append(this.title, close);
    this.list = document.createElement('div');
    this.list.className = 'ol-objects-list';
    this.list.setAttribute('role', 'tree');
    this.drop = document.createElement('div');
    this.drop.className = 'ol-objects-drop';
    this.el.append(head, this.list);
    this.list.addEventListener('pointerdown', this.onPointerDown);
    this.list.addEventListener('dblclick', this.onDblClick);
    const column = scroller.parentElement!;
    if (getComputedStyle(column).position === 'static') column.style.position = 'relative';
    column.append(this.el);
    if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => this.place()); this.ro.observe(scroller); }
    view.dom.classList.add('ol-has-objects');
    view.dom.style.setProperty('--ol-objects-w', `${WIDTH}px`);
    this.place();
    this.update();
  }

  width(): number { return WIDTH; }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.el.remove();
    this.view.dom.classList.remove('ol-has-objects');
    this.view.dom.style.removeProperty('--ol-objects-w');
  }

  private place(): void {
    const s = this.scroller;
    const right = (s.parentElement?.clientWidth ?? 0) - (s.offsetLeft + s.offsetWidth);
    this.el.style.right = `${Math.max(0, right) + (s.offsetWidth - s.clientWidth)}px`;
    this.el.style.top = `${s.offsetTop}px`;
    this.el.style.height = `${s.clientHeight}px`;
  }

  /** the editor changed: drawn again (once a frame) when the page, its objects or the selection did */
  update(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  private render(): void {
    if (this.view.isDestroyed || this.renaming) return;
    const state = this.view.state;
    const cur = this.host.currentPage();
    const page = cur ? state.doc.nodeAt(cur.pos) : null;
    const sel = layoutKey.getState(state)?.sel ?? [];
    const key = `${cur?.pos}|${page ? pageKey(page) : ''}|${sel.join(',')}|${[...this.folded].join(',')}`;
    if (key === this.key) return;
    this.key = key;
    this.place();
    this.rows = [];
    if (!page || !cur) { this.title.textContent = 'Objects'; this.list.replaceChildren(); return; }
    const master = L.isMasterPage(page);
    this.title.textContent = master ? `Objects · master ${page.attrs.name ?? ''}` : 'Objects on this page';
    // top-most first: the page's children from the last
    const walk = (parent: PMNode, at: number, depth: number, path: string) => {
      const kids: { node: PMNode; pos: number; index: number }[] = [];
      parent.forEach((c, off, index) => { if (c.type.name !== 'ol_notes' && !(c.type.name === 'ol_raw' && c.attrs.placed === false)) kids.push({ node: c, pos: at + 1 + off, index }); });
      for (const k of kids.reverse()) {
        const id = `${path}/${k.index}`;
        this.rows.push({ pos: k.pos, node: k.node, depth, parent: at, index: k.index, siblings: parent.childCount, path: id });
        if (k.node.type.name === 'ol_group' && !this.folded.has(id)) walk(k.node, k.pos, depth + 1, id);
      }
    };
    walk(page, cur.pos, 0, String(cur.pos));
    const out: HTMLElement[] = [];
    for (const [i, r] of this.rows.entries()) out.push(this.rowEl(r, i, sel.includes(r.pos)));
    if (!this.rows.length) { const e = document.createElement('div'); e.className = 'ol-objects-empty'; e.textContent = 'Nothing on this page yet'; out.push(e); }
    // what the page's master draws behind it
    const chain = masterChain(state.doc, page.attrs.master).chain;
    for (const m of chain) {
      const head = document.createElement('div');
      head.className = 'ol-objects-section';
      head.textContent = `From the master “${m.node.attrs.name}”`;
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'ol-objects-edit'; edit.textContent = 'Edit';
      edit.title = 'Edit the master (the master view)';
      edit.addEventListener('click', () => setMasterView(this.view, true));
      head.append(edit);
      out.push(head);
      const list: PMNode[] = [];
      m.node.forEach(c => { if (c.type.name !== 'ol_notes' && !c.attrs.ph) list.push(c); });
      for (const c of list.reverse()) {
        const row = document.createElement('div');
        row.className = 'ol-objects-row ol-objects-master';
        const l = objectLabel(c);
        row.innerHTML = `<span class="ol-objects-icon">${icon(l.kind)}</span>`;
        const t = document.createElement('span'); t.className = 'ol-objects-name'; t.textContent = l.text;
        row.append(t);
        out.push(row);
      }
    }
    out.push(this.drop);
    this.list.replaceChildren(...out);
    const first = this.list.querySelector('.ol-objects-row.selected') as HTMLElement | null;
    first?.scrollIntoView({ block: 'nearest' });
  }

  private rowEl(r: Row, i: number, selected: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ol-objects-row' + (selected ? ' selected' : '') + (r.node.attrs.hidden ? ' is-hidden' : '') + (r.node.attrs.lock ? ' is-locked' : '');
    row.dataset.index = String(i);
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-selected', String(selected));
    row.style.paddingLeft = `${6 + r.depth * 14}px`;
    const l = objectLabel(r.node);
    const fold = document.createElement('span');
    fold.className = 'ol-objects-fold';
    if (r.node.type.name === 'ol_group') {
      fold.textContent = this.folded.has(r.path) ? '▸' : '▾';
      fold.dataset.fold = r.path;
    }
    const ic = document.createElement('span');
    ic.className = 'ol-objects-icon';
    ic.innerHTML = icon(l.kind);
    const name = document.createElement('span');
    name.className = 'ol-objects-name';
    name.textContent = l.text;
    name.title = `${l.text}${r.node.attrs.ph ? ' — placeholder' : ''}${r.node.attrs.step ? ` — appears on step ${r.node.attrs.step}` : ''} (double-click to rename)`;
    const badges = document.createElement('span');
    badges.className = 'ol-objects-badges';
    if (r.node.attrs.ph) badges.append(badge('P', 'A placeholder of the master'));
    if (r.node.attrs.step) badges.append(badge(String(r.node.attrs.step), `Appears on step ${r.node.attrs.step}`));
    const eye = document.createElement('button');
    eye.type = 'button'; eye.className = 'ol-objects-eye'; eye.dataset.act = 'hide';
    eye.innerHTML = r.node.attrs.hidden ? EYE_OFF : EYE;
    eye.title = r.node.attrs.hidden ? 'Hidden (not in the PDF either) — show it' : 'Hide (not drawn, in the PDF neither)';
    const lock = document.createElement('button');
    lock.type = 'button'; lock.className = 'ol-objects-lock'; lock.dataset.act = 'lock';
    lock.innerHTML = r.node.attrs.lock ? LOCK : UNLOCK;
    lock.title = r.node.attrs.lock ? 'Locked: not picked on the canvas — unlock' : 'Lock (not picked on the canvas)';
    row.append(fold, ic, name, badges, eye, lock);
    return row;
  }

  /* ---------------------------------------------------------------- pointer */

  private rowAt(target: EventTarget | null): Row | null {
    const el = (target as HTMLElement | null)?.closest?.('.ol-objects-row[data-index]') as HTMLElement | null;
    return el ? this.rows[Number(el.dataset.index)] ?? null : null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    const fold = t.closest('[data-fold]') as HTMLElement | null;
    if (fold) { e.preventDefault(); const id = fold.dataset.fold!; if (this.folded.has(id)) this.folded.delete(id); else this.folded.add(id); this.key = ''; this.update(); return; }
    const r = this.rowAt(t);
    if (!r) return;
    const act = (t.closest('[data-act]') as HTMLElement | null)?.dataset.act;
    if (act) {
      e.preventDefault();
      const key = act === 'hide' ? 'hidden' : 'lock';
      this.view.dispatch(L.setAttrs(this.view.state.tr, r.pos, { [key]: !r.node.attrs[key] }));
      return;
    }
    if (t.closest('.ol-objects-name[contenteditable="true"]')) return;
    e.preventDefault();
    // a click selects (Shift / Ctrl: adds or takes out); a drag moves the row among its neighbours
    const sel = layoutKey.getState(this.view.state)?.sel ?? [];
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const next = add ? (sel.includes(r.pos) ? sel.filter(p => p !== r.pos) : [...sel, r.pos]) : [r.pos];
    this.view.dispatch(selectObjects(this.view.state.tr, next));
    this.view.focus();
    // (no pointer capture: it would make the second click of a double click the list's, not the name's)
    this.drag = { row: r, y: e.clientY, id: e.pointerId, moved: false, target: -1 };
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved && Math.abs(e.clientY - d.y) < 5) return;
    d.moved = true;
    // the sibling rows (same parent): the gap the pointer is nearest
    const sibs = this.rows.map((r, i) => ({ r, i })).filter(x => x.r.parent === d.row.parent);
    let best = { gapRow: -1, dist: Infinity, top: 0 };
    for (const { i } of sibs) {
      const el = this.list.querySelector(`.ol-objects-row[data-index="${i}"]`) as HTMLElement | null;
      if (!el) continue;
      const rr = el.getBoundingClientRect(), lr = this.list.getBoundingClientRect();
      for (const [y, gap] of [[rr.top, i], [rr.bottom, i + 0.5]] as [number, number][]) {
        const dist = Math.abs(e.clientY - y);
        if (dist < best.dist) best = { gapRow: gap, dist, top: y - lr.top + this.list.scrollTop };
      }
    }
    d.target = best.gapRow;
    this.drop.style.display = 'block';
    this.drop.style.top = `${best.top - 1}px`;
  };

  private onPointerUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.drop.style.display = 'none';
    if (!d.moved || d.target < 0 || e.type === 'pointercancel') return;
    // a gap between rows (top-most first) → an index among the siblings in drawing order
    const gapAt = Math.floor(d.target), below = d.target % 1 !== 0;
    const other = this.rows[gapAt];
    if (!other || other.parent !== d.row.parent) return;
    // drawn just above `other` when dropped above its row, just below it when dropped under its row
    const index = below ? other.index : other.index + 1;
    const r = moveObjectTo(this.view, d.row, index);
    if (r !== null) this.view.dispatch(selectObjects(this.view.state.tr, [r]));
  };

  private onDblClick = (e: MouseEvent): void => {
    if (!(e.target as HTMLElement).closest?.('.ol-objects-name')) return;
    // (the first click selected the object and drew the list again: its row as it is now)
    const index = (e.target as HTMLElement).closest('.ol-objects-row')?.getAttribute('data-index');
    this.render();
    const rowEl = this.list.querySelector(`.ol-objects-row[data-index="${index}"]`) as HTMLElement | null;
    const r = index === null || index === undefined ? null : this.rows[Number(index)] ?? null;
    const name = rowEl?.querySelector('.ol-objects-name') as HTMLElement | null;
    if (!r || !name) return;
    e.preventDefault();
    this.renaming = true;
    name.contentEditable = 'true';
    name.textContent = r.node.attrs.name ?? '';
    name.focus();
    document.getSelection()?.selectAllChildren(name);
    const done = (save: boolean) => {
      name.removeEventListener('keydown', key);
      name.removeEventListener('blur', blur);
      name.contentEditable = 'false';
      this.renaming = false;
      const v = (name.textContent ?? '').trim();
      if (save) {
        const at = this.view.state.doc.nodeAt(r.pos) === r.node ? r.pos : -1;
        if (at >= 0) this.view.dispatch(L.setAttrs(this.view.state.tr, at, { name: v || null }));
      }
      this.key = '';
      this.update();
    };
    const key = (k: KeyboardEvent) => { k.stopPropagation(); if (k.key === 'Enter') { k.preventDefault(); done(true); } if (k.key === 'Escape') { k.preventDefault(); done(false); } };
    const blur = () => done(true);
    name.addEventListener('keydown', key);
    name.addEventListener('blur', blur);
  };
}

function badge(text: string, title: string): HTMLElement {
  const b = document.createElement('span');
  b.className = 'ol-objects-badge';
  b.textContent = text;
  b.title = title;
  return b;
}

/** a page's look in the list: its objects' names, kinds and switches (not their places) */
function pageKey(page: PMNode): string {
  const parts: string[] = [];
  page.descendants(n => { if (n.type.spec.group === 'ol_object') parts.push(`${n.type.name}:${n.attrs.name ?? ''}:${n.attrs.hidden ? 1 : 0}${n.attrs.lock ? 1 : 0}:${n.attrs.step ?? ''}:${n.attrs.ph ?? ''}:${n.type.name === 'ol_box' ? n.textContent.slice(0, 40) : n.type.name === 'ol_group' ? n.childCount : ''}`); return n.type.name === 'ol_group' || n.type.name === 'ol_page'; });
  return `${page.attrs.master}|${parts.join('/')}`;
}

/** Move an object to drawing position `index` among its siblings (before the moved one is taken out); its new position. */
function moveObjectTo(view: EditorView, row: Row, index: number): number | null {
  const state = view.state;
  const parent = state.doc.nodeAt(row.parent);
  const node = state.doc.nodeAt(row.pos);
  if (!parent || !node) return null;
  const from = row.index;
  const to = index > from ? index - 1 : index;
  if (to === from) return null;
  const tr = state.tr.delete(row.pos, row.pos + node.nodeSize);
  const p = tr.doc.nodeAt(row.parent)!;
  let at = row.parent + 1;
  for (let i = 0; i < Math.min(to, p.childCount); i++) at += p.child(i).nodeSize;
  tr.insert(at, node);
  view.dispatch(tr);
  return at;
}
