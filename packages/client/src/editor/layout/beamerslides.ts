/**
 * The slides of a linear beamer document (\begin{frame}…\end{frame} as LyX's Frame paragraphs),
 * for the presentation: each frame becomes a page of the deck's size (its aspect ratio) with the
 * default theme's look — the frame title at the top, the content vertically centred (`t`: at the
 * top), \begin{columns} side by side, blocks with their title — built from copies of the editor's
 * own paragraphs (formulas, lists, colours stay as they are drawn). The title block (Title,
 * Author, …) and frames with \titlepage / \maketitle give the title page. Overlays are read by
 * overlays.ts.
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { toMm } from '@overlyx/core';
import { annotateOverlays, OverlayCounter } from './overlays';

export const FRAME_LAYOUTS = new Set(['Frame', 'PlainFrame', 'FragileFrame']);
const TITLE_LAYOUTS: Record<string, string> = { Title: 'title', 'Title (Plain Frame)': 'title', Subtitle: 'subtitle', Author: 'author', Institute: 'institute', Date: 'date', TitleGraphic: 'graphic' };
const BLOCKS: Record<string, string> = {
  Block: 'bm-block', ExampleBlock: 'bm-block bm-example', AlertBlock: 'bm-block bm-alertblock',
  Theorem: 'bm-block', Proof: 'bm-block bm-proof', Corollary: 'bm-block', Definition: 'bm-block', Definitions: 'bm-block', Example: 'bm-block bm-example',
  Examples: 'bm-block bm-example', Fact: 'bm-block', Lemma: 'bm-block', Quotation: 'bm-quote', Quote: 'bm-quote', Verse: 'bm-quote',
};
/** the fixed title of beamer's theorem-like blocks (the name, if given, follows in parentheses) */
const THEOREM_TITLES: Record<string, string> = { Theorem: 'Theorem', Proof: 'Proof', Corollary: 'Corollary', Definition: 'Definition', Definitions: 'Definitions', Example: 'Example', Examples: 'Examples', Fact: 'Fact', Lemma: 'Lemma' };

interface Par { node: PMNode; pos: number }
export interface FrameSource { pos: number; layout: string; pars: Par[] }

export interface BuiltSlide { el: HTMLElement; steps: number; notes: string; name: string | null; transition: string | null; pos: number }

/** The frames of a linear document: a Frame paragraph and what is nested in it or continues it, up to a separator. */
export function beamerFrames(doc: PMNode): FrameSource[] {
  const out: FrameSource[] = [];
  let cur: FrameSource | null = null;
  doc.forEach((node, pos) => {
    const layout = node.attrs.layout as string, depth = node.attrs.depth as number;
    if (node.type.name === 'paragraph' && depth === 0 && FRAME_LAYOUTS.has(layout)) {
      if (!cur || cur.layout !== layout) { cur = { pos, layout, pars: [] }; out.push(cur); }
      cur.pars.push({ node, pos });
      return;
    }
    if (cur && node.type.name === 'paragraph' && depth > 0) { cur.pars.push({ node, pos }); return; }
    cur = null;   // a separator, a section, the title block, text outside frames
  });
  return out;
}

/** Is this a beamer deck the presentation can show frame by frame? */
export function hasFrames(doc: PMNode): boolean {
  let yes = false;
  doc.forEach(n => { if (!yes && n.type.name === 'paragraph' && FRAME_LAYOUTS.has(n.attrs.layout)) yes = true; });
  return yes;
}

/** a paragraph's own Argument inset `id` (its node) */
function argNode(par: PMNode, id: string): PMNode | null {
  let hit: PMNode | null = null;
  par.forEach(c => { if (!hit && c.type.name === 'inset' && c.attrs.name === 'Argument' && c.attrs.arg === id) hit = c; });
  return hit;
}

/** does the paragraph hold nothing but its arguments (a frame's first paragraph: the title only)? */
function onlyArgs(par: PMNode): boolean {
  let other = false;
  par.forEach(c => { if (!(c.type.name === 'inset' && c.attrs.name === 'Argument') && !(c.isText && !c.text?.trim())) other = true; });
  return !other;
}

/** a copy of an editor paragraph without what belongs to editing */
function copyOf(view: EditorView, pos: number): HTMLElement | null {
  const live = view.nodeDOM(pos) as HTMLElement | null;
  if (!live || !(live instanceof HTMLElement)) return null;
  const el = live.cloneNode(true) as HTMLElement;
  clean(el);
  return el;
}

export function clean(el: HTMLElement): void {
  el.removeAttribute('contenteditable');
  el.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
  el.querySelectorAll('.inset-label, .inset-actions, .inset-anchor, .lm-input, .lm-overlay, .ProseMirror-trailingBreak, img.ProseMirror-separator, .lyx-fold-toggle').forEach(n => n.remove());
  el.querySelectorAll('.ProseMirror-selectednode').forEach(n => n.classList.remove('ProseMirror-selectednode'));
}

/** the content of an Argument inset (its paragraphs' inline content), copied from the editor */
function argContent(view: EditorView, parPos: number, id: string): DocumentFragment | null {
  const live = view.nodeDOM(parPos) as HTMLElement | null;
  const a = live?.querySelector(`:scope > .lyx-inset[data-name="Argument"][data-arg="${CSS.escape(id)}"] > .inset-box > .inset-content`);
  if (!a) return null;
  const frag = document.createDocumentFragment();
  a.querySelectorAll(':scope > .lyx-par').forEach((p, i) => {
    const c = p.cloneNode(true) as HTMLElement;
    clean(c);
    if (i) frag.append(document.createElement('br'));
    frag.append(...c.childNodes);
  });
  return frag;
}

/** a column's width from \column{0.5\textwidth} / \column{5cm} (CSS), or '' for an equal share */
function columnWidth(text: string): string {
  const t = text.replace(/\s+/g, '');
  const rel = /^([\d.]+)\\(?:textwidth|linewidth|columnwidth|hsize|paperwidth)/.exec(t);
  if (rel) return `${Math.min(100, Number(rel[1]) * 100)}%`;
  const abs = /^([\d.]+)(cm|mm|in|pt|bp|em)$/.exec(t);
  if (abs) { const mm = toMm(abs[1] + abs[2]); if (mm) return `calc(var(--ol-mm) * ${mm})`; }
  return '';
}

function div(cls: string): HTMLDivElement { const d = document.createElement('div'); d.className = cls; return d; }

/** a {group} from `i` (at its brace): its content, balanced */
function group(s: string, i: number): string | null {
  if (s[i] !== '{') return null;
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') d++;
    else if (s[j] === '}' && --d === 0) return s.slice(i + 1, j);
  }
  return null;
}

/** \title{…}, \author{…} … from the preamble, as plain text (the title page of a deck that sets them there) */
export function preambleTitle(preamble: string): Record<string, string> {
  const out: Record<string, string> = {};
  const src = preamble.replace(/(^|[^\\])%.*$/gm, '$1');
  for (const kind of ['title', 'subtitle', 'author', 'institute', 'date']) {
    const m = new RegExp(`\\\\${kind}\\s*(?:\\[[^\\]]*\\])?\\s*(?=\\{)`).exec(src);
    if (!m) continue;
    const g = group(src, m.index + m[0].length);
    if (g !== null) out[kind] = texText(g);
  }
  if (!('date' in out)) out.date = texText('\\today');
  return out;
}

function texText(t: string): string {
  return t
    .replace(/\\today\b/g, new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))
    .replace(/\\\\(\[[^\]]*\])?/g, '\n').replace(/\\and\b/g, '\u2003').replace(/\\(inst|thanks|footnote)\s*\{[^}]*\}/g, '')
    .replace(/~/g, '\u00a0').replace(/\\[ ,;:!]/g, ' ').replace(/\\([&%$#_{}])/g, '$1').replace(/\\[A-Za-z@]+\*?\s*(\[[^\]]*\])?/g, '').replace(/[{}]/g, '')
    .replace(/[ \t]+/g, ' ').trim();
}

/** The title page from the document's title block (Title, Subtitle, Author, Institute, Date), else the preamble's \title & co. */
function titleSlide(view: EditorView, block: Par[], pos: number, preamble = ''): BuiltSlide {
  const el = document.createElement('section');
  el.className = 'ol-page ol-present-page bm-slide bm-titlepage';
  const inner = div('bm-tp');
  for (const { node, pos: p } of block) {
    const kind = TITLE_LAYOUTS[node.attrs.layout];
    const c = copyOf(view, p);
    if (!c || !kind) continue;
    c.className = 'bm-tp-' + kind;
    inner.append(c);
  }
  if (!block.length) {
    for (const [kind, text] of Object.entries(preambleTitle(preamble))) {
      if (!text) continue;
      const d = div('bm-tp-' + kind);
      d.textContent = text;
      inner.append(d);
    }
  }
  el.append(inner);
  return { el, steps: 1, notes: '', name: null, transition: null, pos };
}

function frameSlide(view: EditorView, f: FrameSource): BuiltSlide {
  const el = document.createElement('section');
  el.className = 'ol-page ol-present-page bm-slide';
  const head = div('bm-head'), body = div('bm-body');
  const first = f.pars[0].node;
  const optsNode = argNode(first, '3');
  const opts = optsNode ? optsNode.textContent : '';
  if (/(^|,)\s*t\s*(,|$)/.test(opts)) body.classList.add('bm-top');
  if (/(^|,)\s*b\s*(,|$)/.test(opts)) body.classList.add('bm-bottom');
  const plain = f.layout === 'PlainFrame' || /(^|,)\s*plain\s*(,|$)/.test(opts);
  const title = argContent(view, f.pars[0].pos, '4');
  const titleEl = div('bm-frametitle'), subEl = div('bm-framesubtitle');
  if (title) titleEl.append(title);
  let notes = '';
  const pars: HTMLElement[] = [];
  let titlePage = false;
  // containers for columns and blocks: a stack by depth
  type Ctx = { kind: 'columns' | 'block'; depth: number; layout: string; el: HTMLElement; target: HTMLElement };
  const stack: Ctx[] = [];
  const target = () => stack.length ? stack[stack.length - 1].target : body;
  for (const [i, { node, pos }] of f.pars.entries()) {
    const layout = node.attrs.layout as string, depth = node.attrs.depth as number;
    if (layout === 'FrameTitle') { const c = copyOf(view, pos); if (c) titleEl.replaceChildren(...c.childNodes); continue; }
    if (layout === 'FrameSubtitle') { const c = copyOf(view, pos); if (c) subEl.replaceChildren(...c.childNodes); continue; }
    if (layout === 'NoteItem') { notes += (notes ? '\n' : '') + node.textContent; continue; }
    if (i === 0 && onlyArgs(node)) continue;
    if (FRAME_LAYOUTS.has(layout) && onlyArgs(node)) continue;
    // leave the containers this paragraph is not part of
    while (stack.length) {
      const t = stack[stack.length - 1];
      if (depth > t.depth || (depth === t.depth && layout === t.layout)) break;
      if (t.kind === 'columns' && layout === 'Column' && depth === t.depth + 1) break;
      stack.pop();
    }
    if (/^\s*\\(titlepage|maketitle)\b/.test(node.textContent)) titlePage = true;
    // \setbeamercovered{transparent}: covered text is greyed out on this frame
    const cov = /\\setbeamercovered\{\s*([a-z]+)/.exec(node.textContent);
    if (cov) {
      el.classList.toggle('bm-transparent', cov[1] !== 'invisible');
      if (!node.textContent.replace(cov[0], '').replace(/^[^}]*\}/, '').trim()) continue;
    }
    if (layout === 'Column') {
      const cols = [...stack].reverse().find(t => t.kind === 'columns');
      if (!cols) continue;
      const col = div('bm-column');
      const w = columnWidth(node.textContent);
      if (w) col.style.flex = `0 0 ${w}`;
      cols.el.append(col);
      cols.target = col;
      continue;
    }
    if (layout.startsWith('Columns') && !(stack.length && stack[stack.length - 1].kind === 'columns' && stack[stack.length - 1].depth === depth)) {
      const row = div('bm-columns' + (layout === 'ColumnsTopAligned' || /\bt\b/.test(argNode(node, '1')?.textContent ?? '') ? ' bm-cols-top' : ''));
      target().append(row);
      stack.push({ kind: 'columns', depth, layout, el: row, target: row });
      if (onlyArgs(node)) continue;
    }
    if (BLOCKS[layout] && !(stack.length && stack[stack.length - 1].kind === 'block' && stack[stack.length - 1].depth === depth && stack[stack.length - 1].layout === layout)) {
      const blk = div(BLOCKS[layout]);
      const bt = div('bm-block-title'), bb = div('bm-block-body');
      const t = argContent(view, pos, '2');
      const fixed = THEOREM_TITLES[layout];
      if (fixed) { bt.append(fixed); if (t) bt.append(' (', t, ')'); if (layout !== 'Proof') bt.append('.'); }
      else if (t) bt.append(t);
      if (fixed || t) blk.append(bt);
      blk.append(bb);
      target().append(blk);
      stack.push({ kind: 'block', depth, layout, el: blk, target: bb });
    }
    const c = copyOf(view, pos);
    if (!c) continue;
    // the paragraph's depth below its frame / container (list indentation)
    const base = stack.length ? stack[stack.length - 1].depth + 1 : 1;
    c.dataset.rel = String(Math.max(0, depth - base));
    target().append(c);
    pars.push(c);
  }
  if (titlePage) {
    // a frame with \titlepage: the title page (its other content is rare)
    return { ...titleFromDoc(view, f.pos), notes };
  }
  if (!plain && (titleEl.childNodes.length || subEl.childNodes.length)) {
    head.append(titleEl);
    if (subEl.childNodes.length) head.append(subEl);
    el.append(head);
  }
  el.append(body);
  const steps = annotateOverlays(pars, new OverlayCounter());
  // a block with an overlay specification is covered as a whole (its title too)
  for (const blk of el.querySelectorAll<HTMLElement>('.bm-block, .bm-quote')) {
    const first = blk.querySelector<HTMLElement>('.lyx-par[data-ov-block]');
    if (first?.dataset.ov) { blk.dataset.ov = first.dataset.ov; blk.dataset.ovMode = 'uncover'; }
  }
  return { el, steps, notes, name: null, transition: null, pos: f.pos };
}

let titleBlock: Par[] = [];
let deckPreamble = '';
function titleFromDoc(view: EditorView, pos: number): BuiltSlide { return titleSlide(view, titleBlock, pos, deckPreamble); }

/** The deck: title page(s) and frames in document order. */
export function beamerSlides(view: EditorView, preamble = ''): BuiltSlide[] {
  const doc = view.state.doc;
  titleBlock = [];
  deckPreamble = preamble;
  doc.forEach((node, pos) => { if (node.type.name === 'paragraph' && node.attrs.depth === 0 && TITLE_LAYOUTS[node.attrs.layout]) titleBlock.push({ node, pos }); });
  const out: BuiltSlide[] = [];
  // LyX writes \makebeamertitle after the title block: a title page there
  const hasTitle = titleBlock.some(p => TITLE_LAYOUTS[p.node.attrs.layout] === 'title');
  const titleAt = hasTitle ? titleBlock[titleBlock.length - 1].pos : -1;
  let titleDone = !hasTitle;
  const transparent = /\\setbeamercovered\{\s*(transparent|dynamic|highly dynamic)/.test(preamble.replace(/(^|[^\\])%.*$/gm, '$1'));
  for (const f of beamerFrames(doc)) {
    if (!titleDone && f.pos > titleAt) { out.push(titleSlide(view, titleBlock, titleAt)); titleDone = true; }
    const sl = frameSlide(view, f);
    if (transparent && !sl.el.classList.contains('bm-transparent')) sl.el.classList.add('bm-transparent');
    out.push(sl);
  }
  if (!titleDone) out.push(titleSlide(view, titleBlock, titleAt));
  return out;
}
