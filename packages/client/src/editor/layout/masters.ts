/**
 * Master pages of layout decks — PowerPoint's slide master and layouts, done the way beamer does
 * its background templates: defined once, drawn on every frame that uses them. A master is a page of
 * role 'master' (`\begin{olmaster}{name=…}` in the file, core layout/latex.ts):
 * - its objects are drawn behind those of every page whose `master` names it (a master may build on
 *   another master the same way), and its background is theirs unless they have their own;
 * - its placeholders — text boxes with a `ph` — are not drawn on the slides but give the position
 *   and style of the slides' boxes with the same `ph`. When a placeholder changes, a slide's box
 *   follows in every respect it still shares with the old placeholder: what was changed on the
 *   slide itself stays (followMasters). The file stays self-contained: every slide box is written
 *   with its own geometry, so the follow is the editor's, and TeX needs no lookup.
 *
 * On screen a master's objects are a widget at the start of each page that uses it: a copy of the
 * master page's own DOM (MasterLayers), refreshed when that changes — so the slide rail's thumbnails,
 * the sorter and the presentation, which copy the page, show them too.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { Decoration } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import { ySyncPluginKey } from 'y-prosemirror';
import { schema } from '@overlyx/core';
import { pages, isMasterPage, defaultParagraph, pageFill, type Attrs } from './commands';
import { color } from './geom';
import { BOX_PROMPTS, deckStyle } from './slidelayouts';

export type PagePos = { node: PMNode; pos: number };

/* ------------------------------------------------------------------ lookups */

export function masterPages(doc: PMNode): PagePos[] { return pages(doc, 'masters'); }

export function findMaster(doc: PMNode, name: string | null | undefined): PagePos | null {
  if (!name) return null;
  return masterPages(doc).find(m => m.node.attrs.name === name) ?? null;
}

/**
 * The masters a page draws, nearest first: the one it names, the one that builds on, … A chain that
 * comes back to a master already in it stops there (and `cyclic` says so: nothing is drawn then).
 */
export function masterChain(doc: PMNode, name: string | null | undefined): { chain: PagePos[]; cyclic: boolean } {
  const chain: PagePos[] = [];
  const seen = new Set<string>();
  let cur = name;
  while (cur) {
    if (seen.has(cur)) return { chain, cyclic: true };
    seen.add(cur);
    const m = findMaster(doc, cur);
    if (!m) break;
    chain.push(m);
    cur = m.node.attrs.master;
  }
  return { chain, cyclic: false };
}

/** The background a page shows: its own, else the nearest master's that has one. */
export function resolvedFill(doc: PMNode, page: { attrs: Attrs }): string | null {
  return pageFill(doc, page);
}

/** A master's placeholders by `ph` (its top-level text boxes that have one). */
export function placeholdersOf(master: PMNode): Map<string, PMNode> {
  const out = new Map<string, PMNode>();
  master.forEach(c => { if (c.type.name === 'ol_box' && c.attrs.ph && !out.has(c.attrs.ph)) out.set(c.attrs.ph, c); });
  return out;
}

/** The masters another one may build on: not itself, nor any that (indirectly) builds on it. */
export function possibleBases(doc: PMNode, name: string): string[] {
  return masterPages(doc).map(m => m.node.attrs.name as string).filter(n => n && n !== name && !masterChain(doc, n).chain.some(m => m.node.attrs.name === name));
}

/** A master name not taken yet (`base`, `base 2`, …); names stay to letters, digits, blanks and - _ (TeX builds control sequences of them). */
export function uniqueMasterName(doc: PMNode, base: string): string {
  const clean = base.replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, ' ').trim() || 'Layout';
  const taken = new Set(masterPages(doc).map(m => m.node.attrs.name));
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean} ${i}`)) return `${clean} ${i}`;
}

/**
 * The formatting text typed into an empty box of a slide starts with: the first letters' of its
 * placeholder on the master (a placeholder with sample text — "Title" in bold — sets it). Null: none.
 */
export function placeholderMarks(doc: PMNode, boxPos: number): readonly Mark[] | null {
  const box = doc.nodeAt(boxPos);
  if (!box?.attrs.ph) return null;
  const $p = doc.resolve(boxPos);
  const page = $p.depth >= 1 ? $p.node(1) : null;
  const m = page ? findMaster(doc, page.attrs.master) : null;
  const ph = m ? placeholdersOf(m.node).get(box.attrs.ph) : undefined;
  let marks: readonly Mark[] | null = null;
  ph?.descendants(n => { if (marks) return false; if (n.isText) marks = n.marks; return true; });
  return marks && (marks as readonly Mark[]).length ? marks : null;
}

/* ------------------------------------------------------------------ placeholders follow their master */

/** what a slide's box takes from its placeholder (its text and its animation are its own) */
export const FOLLOWED = ['x', 'y', 'w', 'h', 'rot', 'fill', 'stroke', 'lw', 'radius', 'pad', 'valign', 'shape', 'font', 'leading', 'color', 'align', 'opacity', 'grow'];

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-3;
  return (a ?? null) === (b ?? null);
}

/** A slide box (`attrs`) brought to placeholder `to`: the attributes it shares with `from` (all, without one) take `to`'s values. */
function follow(attrs: Attrs, from: PMNode | null, to: PMNode): Attrs | null {
  let out: Attrs | null = null;
  for (const k of FOLLOWED) {
    if (same(attrs[k], to.attrs[k])) continue;
    if (from && !same(attrs[k], from.attrs[k])) continue;
    (out ??= { ...attrs })[k] = to.attrs[k];
  }
  return out;
}

const OWN_TR = 'olMasterFollow';

/**
 * appendTransaction of the layout plugin: placeholders of masters changed by the transactions are
 * followed by the boxes of the slides that use them. Not for collaborators' changes (theirs already
 * carry it), undo, live previews of a drag (only its end), or what this did itself.
 */
export function followMasters(trs: readonly Transaction[], oldState: EditorState, state: EditorState): Transaction | null {
  if (!trs.some(t => t.docChanged && !t.getMeta(OWN_TR) && t.getMeta('addToHistory') !== false && !(t.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin)) return null;
  const before = new Map(masterPages(oldState.doc).map(m => [m.node.attrs.name as string, m.node]));
  if (!before.size) return null;
  const changes = new Map<string, Map<string, { from: PMNode; to: PMNode }>>();
  for (const m of masterPages(state.doc)) {
    const old = before.get(m.node.attrs.name);
    if (!old || old === m.node) continue;
    const was = placeholdersOf(old);
    for (const [ph, box] of placeholdersOf(m.node)) {
      const prev = was.get(ph);
      if (!prev || prev.attrs === box.attrs || FOLLOWED.every(k => same(prev.attrs[k], box.attrs[k]))) continue;
      let byPh = changes.get(m.node.attrs.name);
      if (!byPh) changes.set(m.node.attrs.name, byPh = new Map());
      byPh.set(ph, { from: prev, to: box });
    }
  }
  if (!changes.size) return null;
  const tr = state.tr;
  for (const p of pages(state.doc)) {
    const byPh = changes.get(p.node.attrs.master);
    if (!byPh) continue;
    p.node.forEach((c, off) => {
      const ch = c.type.name === 'ol_box' && c.attrs.ph ? byPh.get(c.attrs.ph) : undefined;
      const next = ch ? follow(c.attrs, ch.from, ch.to) : null;
      if (next) tr.setNodeMarkup(tr.mapping.map(p.pos + 1 + off), undefined, next);
    });
  }
  return tr.docChanged ? tr.setMeta(OWN_TR, true) : null;
}

/* ------------------------------------------------------------------ commands */

/** an object as a master draws it: its look, not its animation or identity (objects of a slide equal to one are drawn twice) */
function signature(n: PMNode): string {
  const { step: _s, effect: _e, id: _i, lock: _l, ...rest } = n.attrs;
  return n.type.name + JSON.stringify(rest) + (n.isLeaf ? '' : JSON.stringify(n.content.toJSON()));
}

/** A placeholder's empty copy for a slide: its frame and style, an empty first paragraph of its first paragraph's kind. */
export function emptyPlaceholder(box: PMNode): PMNode {
  const first = box.firstChild;
  const par = first?.isTextblock ? schema.nodes.paragraph.create({ ...first.attrs }) : defaultParagraph();
  return schema.nodes.ol_box.create({ ...box.attrs, step: null, effect: null, lock: false, hidden: false, id: null }, [par]);
}

/** where a new master goes: after the last one, else at the very start (masters precede the frames, as TeX needs them defined) */
function masterInsertPos(doc: PMNode): number {
  const list = masterPages(doc);
  const last = list[list.length - 1];
  return last ? last.pos + last.node.nodeSize : 0;
}

/** Insert a master page; returns its position. */
export function insertMaster(tr: Transaction, node: PMNode): number {
  const at = masterInsertPos(tr.doc);
  tr.insert(at, node);
  return at;
}

/** A new master with the deck's title and text placeholders (its look read off the slides, slidelayouts.ts). */
export function newMaster(state: EditorState, page: { w: number; h: number }, basePt = 11): { tr: Transaction; pos: number; name: string } {
  const style = deckStyle(state.doc, page, basePt);
  const name = uniqueMasterName(state.doc, masterPages(state.doc).length ? 'Layout' : 'Title and content');
  const box = (s: typeof style.title, n: string, ph: string) => {
    const p = s.par.layout ? schema.nodes.paragraph.create({ ...s.par, depth: s.par.depth ?? 0 }) : defaultParagraph();
    return schema.nodes.ol_box.create({ ...s.attrs, step: null, effect: null, lock: false, id: null, name: n, ph }, [p]);
  };
  const node = schema.nodes.ol_page.create({ role: 'master', name, fill: style.fill }, [...style.master, box(style.title, 'Title', 'title'), box(style.body, 'Text', 'body')]);
  const tr = state.tr;
  const pos = insertMaster(tr, node);
  return { tr, pos, name };
}

/**
 * Link the slide at `pos` to master `name` (null: none) — PowerPoint's "apply layout": its boxes that
 * belong to placeholders (by `ph`, else by the placeholder's name) take the new placeholders' frames
 * and styles where they had the old master's; placeholders it lacks are added empty; objects equal to
 * the masters' own are taken off the slide (the master draws them). `reset`: every placeholder's look
 * is taken, changed or not (PowerPoint's "Reset slide").
 */
export function applyMaster(tr: Transaction, pos: number, name: string | null, reset = false): void {
  const slide = tr.doc.nodeAt(pos);
  if (!slide || slide.type.name !== 'ol_page') return;
  const oldMaster = reset ? null : findMaster(tr.doc, slide.attrs.master)?.node ?? null;
  const target = findMaster(tr.doc, name);
  tr.setNodeMarkup(pos, undefined, { ...slide.attrs, master: target ? name : null });
  if (!target) return;
  const was = oldMaster ? placeholdersOf(oldMaster) : new Map<string, PMNode>();
  const want = placeholdersOf(target.node);
  const { chain } = masterChain(tr.doc, name);
  const drawn = new Set<string>();
  for (const m of chain) m.node.forEach(c => { if (!(c.type.name === 'ol_box' && c.attrs.ph)) drawn.add(signature(c)); });
  const used = new Set<string>();
  slide.forEach(c => { if (c.type.name === 'ol_box' && c.attrs.ph && want.has(c.attrs.ph)) used.add(c.attrs.ph); });
  const remove: { at: number; size: number }[] = [];
  slide.forEach((c, off) => {
    const at = pos + 1 + off;
    if (c.type.name === 'ol_notes') return;
    if (drawn.has(signature(c))) { remove.push({ at, size: c.nodeSize }); return; }
    if (c.type.name !== 'ol_box') return;
    let ph = c.attrs.ph && want.has(c.attrs.ph) ? c.attrs.ph as string : null;
    if (!ph && c.attrs.name) {
      // a box named like a placeholder (a new slide's Title, Text …) becomes it
      const match = [...want.entries()].find(([k, b]) => !used.has(k) && b.attrs.name === c.attrs.name);
      if (match) { ph = match[0]; used.add(ph); }
    }
    if (!ph) return;
    // (a box that was no placeholder of the old master takes the new one's look whole)
    const next = follow({ ...c.attrs, ph }, reset ? null : was.get(ph) ?? null, want.get(ph)!) ?? (c.attrs.ph !== ph ? { ...c.attrs, ph } : null);
    if (next) { if (!next.name && want.get(ph)!.attrs.name) next.name = want.get(ph)!.attrs.name; tr.setNodeMarkup(tr.mapping.map(at), undefined, next); }
  });
  for (const r of remove.reverse()) tr.delete(tr.mapping.map(r.at), tr.mapping.map(r.at + r.size));
  // the placeholders the slide has no box for: empty ones, before its notes
  const missing = [...want.entries()].filter(([k]) => !used.has(k) && ![...slideBoxes(tr.doc.nodeAt(tr.mapping.map(pos))!)].some(b => b.attrs.ph === k));
  if (missing.length) {
    const page = tr.doc.nodeAt(tr.mapping.map(pos))!;
    let at = tr.mapping.map(pos) + page.nodeSize - 1;
    if (page.lastChild?.type.name === 'ol_notes') at -= page.lastChild.nodeSize;
    tr.insert(at, missing.map(([, b]) => emptyPlaceholder(b)));
  }
}

function* slideBoxes(page: PMNode): Generator<PMNode> {
  for (let i = 0; i < page.childCount; i++) { const c = page.child(i); if (c.type.name === 'ol_box') yield c; }
}

/** A new slide using master `name` after the slide at `afterPos` (null: at the end): the master's placeholders, empty. */
export function slideFromMaster(state: EditorState, afterPos: number | null, name: string): { tr: Transaction; pos: number } | null {
  const m = findMaster(state.doc, name);
  if (!m) return null;
  const boxes = [...placeholdersOf(m.node).values()].map(emptyPlaceholder);
  const node = schema.nodes.ol_page.create({ master: name }, boxes);
  const list = pages(state.doc);
  const after = afterPos === null ? null : list.find(p => p.pos === afterPos) ?? null;
  const last = list[list.length - 1];
  const at = after ? after.pos + after.node.nodeSize : last ? last.pos + last.node.nodeSize : state.doc.content.size;
  return { tr: state.tr.insert(at, node), pos: at };
}

/**
 * A master made of the slide at `pos`: its text boxes named like placeholders (Title, Text, …, or
 * with a `ph` already) become empty placeholders, everything else becomes the master's own objects,
 * its background the master's. The slide then uses it (and keeps only its boxes' text).
 */
export function masterFromSlide(state: EditorState, pos: number, page: { w: number; h: number }): { tr: Transaction; name: string } | null {
  const slide = state.doc.nodeAt(pos);
  if (!slide || slide.type.name !== 'ol_page' || isMasterPage(slide)) return null;
  const boxes: PMNode[] = [];
  slide.forEach(c => { if (c.type.name === 'ol_box') boxes.push(c); });
  let named = boxes.filter(b => b.attrs.ph || (b.attrs.name && BOX_PROMPTS[b.attrs.name]));
  const role = new Map<PMNode, string>();
  if (!named.length) {
    // no names: the top box with the largest type is the title, the largest box below it the text
    const font = (b: PMNode) => Number(b.attrs.font ?? 0);
    const top = boxes.filter(b => Number(b.attrs.y) < page.h * 0.3 && b.textContent.trim());
    const t = top.length ? top.reduce((a, b) => (font(b) > font(a) || (font(b) === font(a) && Number(b.attrs.y) < Number(a.attrs.y)) ? b : a)) : null;
    const below = t ? boxes.filter(b => b !== t && b.textContent.trim() && Number(b.attrs.y) >= Number(t.attrs.y) + Number(t.attrs.h) * 0.5) : [];
    const body = below.length ? below.reduce((a, b) => (Number(b.attrs.w) * Number(b.attrs.h) > Number(a.attrs.w) * Number(a.attrs.h) ? b : a)) : null;
    if (t) role.set(t, 'Title');
    if (body) role.set(body, 'Text');
    named = [...role.keys()];
  }
  const phs = new Map<PMNode, string>();
  const taken = new Set<string>();
  for (const b of named) {
    let ph = (b.attrs.ph as string | null) ?? String(role.get(b) ?? b.attrs.name ?? 'text').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (taken.has(ph)) { let i = 2; while (taken.has(ph + i)) i++; ph += i; }
    taken.add(ph);
    phs.set(b, ph);
  }
  const name = uniqueMasterName(state.doc, slide.attrs.name || 'Layout');
  const content: PMNode[] = [];
  slide.forEach(c => {
    if (c.type.name === 'ol_notes') return;
    const ph = phs.get(c);
    if (ph) content.push(emptyPlaceholder(c.type.create({ ...c.attrs, ph, name: c.attrs.name ?? role.get(c) ?? null }, c.content)));
    else content.push(c.type.create({ ...c.attrs, step: null, effect: null }, c.content, c.marks));
  });
  const tr = state.tr;
  const mpos = insertMaster(tr, schema.nodes.ol_page.create({ role: 'master', name, fill: slide.attrs.fill, master: slide.attrs.master }, content));
  void mpos;
  // the slide: its placeholder boxes keep their text, the rest is the master's now
  const at = tr.mapping.map(pos);
  const kept: PMNode[] = [];
  slide.forEach(c => {
    const ph = phs.get(c);
    if (ph) kept.push(c.type.create({ ...c.attrs, ph, name: c.attrs.name ?? role.get(c) ?? null }, c.content, c.marks));
    else if (c.type.name === 'ol_notes') kept.push(c);
  });
  tr.replaceWith(at, at + slide.nodeSize, schema.nodes.ol_page.create({ ...slide.attrs, fill: null, master: name }, kept));
  return { tr, name };
}

/**
 * Objects of a slide moved onto its master (a logo, a footer, a frame repeated on every slide): taken
 * off this slide and off the other slides of that master that have the same object.
 */
export function moveToMaster(state: EditorState, positions: number[]): Transaction | null {
  const slide = positions.length ? pageAtPos(state.doc, positions[0]) : null;
  const m = slide ? findMaster(state.doc, slide.node.attrs.master) : null;
  if (!slide || !m) return null;
  const objs = positions.map(p => state.doc.nodeAt(p)).filter((n): n is PMNode => !!n);
  const sigs = new Set(objs.map(signature));
  const tr = state.tr;
  const gone: { at: number; size: number }[] = [];
  for (const p of pages(state.doc)) {
    if (p.node.attrs.master !== m.node.attrs.name) continue;
    p.node.forEach((c, off) => { if (c.type.name !== 'ol_notes' && sigs.has(signature(c))) gone.push({ at: p.pos + 1 + off, size: c.nodeSize }); });
  }
  for (const g of gone.sort((a, b) => b.at - a.at)) tr.delete(g.at, g.at + g.size);
  const mpos = tr.mapping.map(m.pos);
  const mnode = tr.doc.nodeAt(mpos)!;
  // on top of the master's own objects (the slide's are drawn above them all the same)
  tr.insert(mpos + mnode.nodeSize - 1, objs.map(o => o.type.create({ ...o.attrs, step: null, effect: null }, o.content, o.marks)));
  return tr;
}

function pageAtPos(doc: PMNode, pos: number): PagePos | null {
  let found: PagePos | null = null;
  doc.forEach((n, off) => { if (!found && n.type.name === 'ol_page' && pos > off && pos < off + n.nodeSize) found = { node: n, pos: off }; });
  return found;
}

/** Rename a master, and every page that names it. */
export function renameMaster(state: EditorState, pos: number, to: string): Transaction | null {
  const m = state.doc.nodeAt(pos);
  if (!m || !isMasterPage(m)) return null;
  const from = m.attrs.name as string;
  const name = to === from ? from : uniqueMasterName(state.doc, to);
  if (name === from) return null;
  const tr = state.tr;
  state.doc.forEach((p, off) => {
    if (p.type.name !== 'ol_page') return;
    if (off === pos) tr.setNodeMarkup(off, undefined, { ...p.attrs, name });
    else if (p.attrs.master === from) tr.setNodeMarkup(off, undefined, { ...p.attrs, master: name });
  });
  return tr;
}

/** Delete a master: the pages that used it use the master it built on (or none). */
export function deleteMaster(state: EditorState, pos: number): Transaction | null {
  const m = state.doc.nodeAt(pos);
  if (!m || !isMasterPage(m)) return null;
  const tr = state.tr;
  state.doc.forEach((p, off) => { if (p.type.name === 'ol_page' && off !== pos && p.attrs.master === m.attrs.name) tr.setNodeMarkup(off, undefined, { ...p.attrs, master: m.attrs.master ?? null }); });
  tr.delete(pos, pos + m.nodeSize);
  return tr;
}

/** A copy of a master (another name) after the last master. */
export function duplicateMaster(state: EditorState, pos: number): { tr: Transaction; pos: number } | null {
  const m = state.doc.nodeAt(pos);
  if (!m || !isMasterPage(m)) return null;
  const tr = state.tr;
  const at = insertMaster(tr, m.type.create({ ...m.attrs, name: uniqueMasterName(state.doc, m.attrs.name || 'Layout') }, m.content));
  return { tr, pos: at };
}

/** Pages copied from one list and pasted into the other (the slide clipboard): slides become masters (named) and back. */
export function asKind(nodes: PMNode[], masters: boolean, doc: PMNode): PMNode[] {
  const names = new Set(masterPages(doc).map(m => m.node.attrs.name));
  return nodes.map(n => {
    if (isMasterPage(n) === masters) {
      if (!masters) return n;
      let name = n.attrs.name || 'Layout';
      if (names.has(name)) { let i = 2; while (names.has(`${name} ${i}`)) i++; name = `${name} ${i}`; }
      names.add(name);
      return n.type.create({ ...n.attrs, name }, n.content);
    }
    if (!masters) return n.type.create({ ...n.attrs, role: 'page' }, n.content);
    let name = n.attrs.name || 'Layout';
    if (names.has(name)) { let i = 2; while (names.has(`${name} ${i}`)) i++; name = `${name} ${i}`; }
    names.add(name);
    const content: PMNode[] = [];
    n.forEach(c => { if (c.type.name !== 'ol_notes') content.push(c); });
    return n.type.create({ ...n.attrs, role: 'master', name, transition: null }, content);
  });
}

/* ------------------------------------------------------------------ drawing masters on the pages */

const layersByView = new WeakMap<EditorView, MasterLayers>();

/** The master widgets of a document: one at the start of every page that uses a master (none in a chain that loops). */
export function masterWidgets(doc: PMNode): Decoration[] {
  const out: Decoration[] = [];
  doc.forEach((p, off) => {
    if (p.type.name !== 'ol_page' || !p.attrs.master) return;
    const { chain, cyclic } = masterChain(doc, p.attrs.master);
    if (cyclic || !chain.length) return;
    const name = p.attrs.master as string, own = !!p.attrs.fill;
    out.push(Decoration.widget(off + 1, view => layersOf(view).create(name, own), { key: `olm|${name}|${own ? 1 : 0}`, side: -1, ignoreSelection: true, marks: [] }));
  });
  return out;
}

function layersOf(view: EditorView): MasterLayers {
  let l = layersByView.get(view);
  if (!l) layersByView.set(view, l = new MasterLayers(view));
  return l;
}

/** Stop drawing master layers for a view (its layout plugin went). */
export function destroyMasterLayers(view: EditorView): void { layersByView.get(view)?.destroy(); layersByView.delete(view); }

/** The objects of a page's master: copies of the master page's DOM in each page's layer, kept up to date. */
class MasterLayers {
  private layers = new Set<HTMLElement>();
  private dirty = new Set<string>();
  private timer = 0;
  private mo: MutationObserver;

  constructor(private view: EditorView) {
    this.mo = new MutationObserver(recs => {
      for (const r of recs) {
        const t = (r.target.nodeType === 1 ? r.target : r.target.parentElement) as HTMLElement | null;
        const wrap = t?.closest?.('.ol-page-wrap') as (HTMLElement & { olPage?: { node: PMNode } }) | null;
        if (!wrap || wrap.dataset.role !== 'master' || t!.closest('.ol-overlay, .ol-page-label, .ol-notes-add')) continue;
        const name = wrap.olPage?.node.attrs.name;
        if (name) this.dirty.add(name);
      }
      if (this.dirty.size) this.schedule();
    });
    this.mo.observe(view.dom, { subtree: true, childList: true, characterData: true, attributes: true });
  }

  destroy(): void { this.mo.disconnect(); clearTimeout(this.timer); this.layers.clear(); }

  /** the widget's element: the master's objects (and its background unless the page has its own) */
  create(name: string, ownFill: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'ol-master-layer';
    el.contentEditable = 'false';
    el.dataset.master = name;
    if (!ownFill) el.dataset.inherit = '';
    this.layers.add(el);
    this.draw(el);
    // the master's own page may be drawn after this one (or its formulas later): once more when it is
    requestAnimationFrame(() => { if (el.isConnected) this.draw(el); });
    return el;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 120);
  }

  /** the layers of the changed masters drawn again (a master building on a changed one changes in turn: its layer is part of its page) */
  refresh(all = false): void {
    if (this.view.isDestroyed) return;
    const names = this.dirty;
    this.dirty = new Set();
    for (const el of [...this.layers]) {
      if (!el.isConnected) { this.layers.delete(el); continue; }
      if (all || names.has(el.dataset.master ?? '')) this.draw(el);
    }
  }

  private draw(el: HTMLElement): void {
    const doc = this.view.state.doc;
    const m = findMaster(doc, el.dataset.master);
    const fill = el.dataset.inherit !== undefined && m ? color(resolvedFill(doc, { attrs: { fill: null, master: m.node.attrs.name } })) : null;
    el.style.background = fill ?? '';
    const wrap = m ? this.view.nodeDOM(m.pos) as HTMLElement | null : null;
    const section = wrap?.querySelector?.(':scope > .ol-page') as HTMLElement | null;
    if (!section) { el.replaceChildren(); return; }
    const out: Node[] = [];
    for (const child of section.children) {
      const c = child as HTMLElement;
      if (c === el || !(c.classList.contains('ol-obj') || c.classList.contains('ol-group') || c.classList.contains('ol-master-layer'))) continue;
      if (c.dataset.ph || c.classList.contains('ol-hidden-obj') || c.classList.contains('ol-raw-unplaced')) continue;
      out.push(cleanCopy(c));
    }
    el.replaceChildren(...out);
  }
}

let markerSeq = 0;

/** A copy of an object's DOM to draw elsewhere: no editing marks, no prompts, its own SVG marker ids. */
export function cleanCopy(src: HTMLElement): HTMLElement {
  const copy = src.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.ol-box-prompt, .ol-notes, .ol-raw-unplaced, [data-ph], .ol-hidden-obj').forEach(n => n.remove());
  for (const e of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
    e.classList?.remove('ol-sel', 'ol-edited', 'ol-selatom', 'ProseMirror-selectednode', 'focused', 'ol-hover');
    e.removeAttribute?.('contenteditable');
  }
  // arrow tips: the copy's markers under new ids (an id twice in the page would draw the original's)
  for (const mk of copy.querySelectorAll('marker[id]')) {
    const id = mk.id, nid = `olmc${++markerSeq}`;
    mk.id = nid;
    for (const p of copy.querySelectorAll(`[marker-start="url(#${id})"], [marker-end="url(#${id})"]`)) {
      if (p.getAttribute('marker-start') === `url(#${id})`) p.setAttribute('marker-start', `url(#${nid})`);
      if (p.getAttribute('marker-end') === `url(#${id})`) p.setAttribute('marker-end', `url(#${nid})`);
    }
  }
  copy.querySelectorAll('[id]').forEach(n => { if (n.tagName.toLowerCase() !== 'marker') n.removeAttribute('id'); });
  return copy;
}
