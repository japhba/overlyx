/**
 * The Pages view (View ▸ Pages): the document on the PDF's pages, as Google Docs' print layout
 * shows it, with TeX deciding where they break. The text column takes the PDF's line width and
 * baseline distance; each page begins where the last build began it (core pagebreaks.ts: SyncTeX
 * and the PDF's words, matched to the paragraphs as inverse search does, app/sourcelocate.ts). A
 * widget there keeps the room of the page's foot, the gap and the next page's head — inside the
 * paragraph when the page breaks it — and the sheets are painted behind the text on the editor
 * host. A page holding less in the editor than in the PDF is filled out to its height; one holding
 * more grows. A break after the first edit since that build may move: it is faded until the next
 * build places it again. Line breaks inside paragraphs stay the browser's: the PDF is the exact view.
 */
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type { PageBreaks, PageFrame, PageStart } from '@overlyx/core';
import { locateSourceLine, plainWords, type LocateBlock } from '../../app/sourcelocate';

/** where a page begins in the document: before a block, or inside a paragraph (`inline`) */
export interface PageMark { pos: number; page: number; inline: boolean }

interface PagesState {
  on: boolean;
  data: PageBreaks | null;
  marks: PageMark[];
  /** the first place edited since the breaks were placed: breaks after it may have moved */
  editedFrom: number | null;
  /** the LaTeX the build compiled, and the document's size when the breaks were placed in it */
  tex: string | null;
  placedSize: number;
  /** margins / line spacing being dragged, or saved and waiting for the build that shows them */
  adjust: PageAdjust | null;
  deco: DecorationSet;
}

/** the page setup as dragged on the sheets: margins (pt, LaTeX's geometry: to the text block) and the line spacing's stretch */
export interface PageAdjust {
  left?: number; right?: number; top?: number; bottom?: number;
  /** the stretch (`\spacing other …`, markdown's linestretch) and the one the build had */
  stretch?: number; stretch0?: number;
  /** saved: the next build will show it */
  pending?: boolean;
}

/** what the shell does with a page setup dragged on the sheets: writes it into the document (true: done) */
export interface PagesHost {
  /** the document's line spacing stretch now (1: single) */
  stretch(): number;
  save(change: { margins?: { left: number; right: number; top: number; bottom: number }; stretch?: number }): Promise<boolean>;
}
let pagesHost: PagesHost | null = null;
/** the shell that saves page setups (the web client); without one the sheets cannot be adjusted */
export function setPagesHost(h: PagesHost | null): void { pagesHost = h; }

export const pagesKey = new PluginKey<PagesState>('ol-pages');

type PagesMeta = { on: boolean } | { data: PageBreaks | null; tex: string | null } | { adjust: PageAdjust | null };

/** room between the sheets (px) */
const GAP = 16;

/** turn the Pages view on or off */
export function setPagesView(view: EditorView, on: boolean): void {
  view.dispatch(view.state.tr.setMeta(pagesKey, { on } satisfies PagesMeta));
}

/** the pages of a new build and the LaTeX it compiled (null: no build to show) */
export function setPageBreaks(view: EditorView, data: PageBreaks | null, tex: string | null): void {
  view.dispatch(view.state.tr.setMeta(pagesKey, { data, tex } satisfies PagesMeta));
}

/** the page of the cursor and the page count, in the last build — null when the view is off or knows no pages */
export function pageAtCursor(state: EditorState): { page: number; pages: number; stale: boolean } | null {
  const st = pagesKey.getState(state);
  if (!st?.on || !st.data?.pages || isLayoutDoc(state.doc)) return null;
  const at = state.selection.from;
  let page = 1;
  for (const m of st.marks) if (m.pos <= at) page = m.page;
  return { page, pages: st.data.pages, stale: !!st.adjust?.pending || (st.editedFrom !== null && st.editedFrom < at) };
}

/* ------------------------------------------------------------------ placing the breaks */

interface Block extends LocateBlock { pos: number; map?: number[] }

/** the document's paragraphs and display formulas as sourcelocate.ts sees them (app/SourcePane.tsx docBlocks, on a document) */
function blocksOf(doc: PMNode): Block[] {
  const blocks: Block[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'math_display') { blocks.push({ kind: 'math', text: String(node.attrs.latex ?? ''), pos }); return false; }
    if (node.isTextblock) {
      let text = '';
      const map: number[] = [];
      node.forEach((child, off) => {
        const start = pos + 1 + off;
        if (child.isText) { const t = child.text!; for (let i = 0; i < t.length; i++) { text += t[i]; map.push(start + i); } }
        else { text += '\u0000'; map.push(start); }
      });
      map.push(pos + 1 + node.content.size);
      blocks.push({ kind: 'text', text, pos: pos + 1, map });
    }
    return true;
  });
  return blocks;
}
const blockPos = (b: Block, offset: number): number => (b.map ? b.map[Math.max(0, Math.min(offset, b.map.length - 1))] : b.pos + offset);

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
function tokens(s: string): { t: string; at: number }[] {
  const out: { t: string; at: number }[] = [];
  for (const m of s.matchAll(/[\p{L}\p{N}]+/gu)) out.push({ t: fold(m[0]), at: m.index! });
  return out;
}

/**
 * Where the PDF line's words begin in a paragraph's text, and how many of them were found there in
 * a row: the longest such run, nearest to `expected` among equally long ones. The page's first word
 * may be the second half of a word hyphenated across the break (the break then goes before the
 * whole word), a section number or a list label the editor draws itself (skipped); a formula's
 * glyphs in the PDF line are skipped too.
 */
function findWords(text: string, words: string[], expected: number): { at: number; score: number; all: boolean } | null {
  const et = tokens(text), pt = tokens(words.join(' ')).map(x => x.t);
  if (!pt.length) return null;
  let best: { at: number; score: number; all: boolean } | null = null;
  for (let i = 0; i < et.length; i++) {
    for (let j0 = 0; j0 < Math.min(3, pt.length); j0++) {
      const whole = et[i].t === pt[j0];
      const tail = j0 === 0 && pt[0].length >= 2 && et[i].t.length > pt[0].length && et[i].t.endsWith(pt[0]);
      if (!whole && !tail) continue;
      let n = 1, a = i + 1, b = j0 + 1, miss = 0;
      while (a < et.length && b < pt.length && miss < 2) {
        if (et[a].t === pt[b]) { n++; a++; b++; miss = 0; }
        else if (b + 1 < pt.length && et[a].t === pt[b + 1]) { n++; a++; b += 2; miss = 0; }
        else { miss++; b++; }
      }
      if (n < Math.min(3, pt.length - j0)) continue;
      const score = n - j0 * 0.5;
      // the whole paragraph is the line (a heading): its words and nothing else
      const all = i === 0 && n === et.length && b >= pt.length;
      if (!best || score > best.score || (score === best.score && Math.abs(et[i].at - expected) < Math.abs(best.at - expected))) best = { at: et[i].at, score, all };
    }
  }
  return best;
}

/** where the PDF line's words begin in a paragraph's text (findWords), or null */
export function matchWords(text: string, words: string[], expected: number): number | null {
  return findWords(text, words, expected)?.at ?? null;
}

/** the start of the word at or after `at` */
function wordStart(text: string, at: number): number {
  if (at <= 0) return 0;
  if (at >= text.length) return text.length;
  if (/\s/.test(text[at - 1])) return at;
  const m = /\s+/.exec(text.slice(at));
  return m ? Math.min(text.length, at + m.index + m[0].length) : text.length;
}

/** the position before a block, moved out of the containers it is the first thing of */
function before(doc: PMNode, pos: number): number {
  let $p = doc.resolve(pos);
  while ($p.depth > 0 && $p.index() === 0) { pos = $p.before(); $p = doc.resolve(pos); }
  return pos;
}

/** the position before the top-level block holding `pos` */
const topLevel = (doc: PMNode, pos: number): number => { const $p = doc.resolve(pos); return $p.depth > 0 ? $p.before(1) : pos; };

/** a float's caption (what the editor shows of a figure whose page begins with it), from the lines around `line` (0-based) */
function floatCaption(lines: string[], line: number): string | null {
  let inFloat = false;
  for (let k = line; k >= Math.max(0, line - 8); k--) {
    if (/\\end\{(figure|table)\*?\}/.test(lines[k]) && k < line) break;
    if (/\\begin\{(figure|table)\*?\}/.test(lines[k])) { inFloat = true; break; }
  }
  if (!inFloat) return null;
  for (let k = line; k < Math.min(lines.length, line + 20); k++) {
    const m = /\\caption(?:\[[^\]]*\])?\{([^{}]{3,})/.exec(lines[k]);
    if (m) return plainWords(m[1]);
    if (/\\end\{(figure|table)\*?\}/.test(lines[k])) break;
  }
  return null;
}

/** a mark at a character of a paragraph: before the paragraph when nothing of it comes before */
function markAt(doc: PMNode, b: Block, off: number, page: number): PageMark {
  if (off <= 0 || !b.text.slice(0, off).trim()) return { pos: before(doc, b.pos - 1), page, inline: false };
  return { pos: blockPos(b, off), page, inline: true };
}

/** where a page begins in the document after position `after`, or null when its text is not found */
function placeStart(doc: PMNode, lines: string[], tex: string, blocks: Block[], s: PageStart, after: number): PageMark | null {
  const caption = floatCaption(lines, s.line - 1);
  if (caption && caption.length >= 3) {
    const at = blocks.findIndex(b => b.kind === 'text' && b.pos > after && b.text.replace(/\s+/g, ' ').trim().startsWith(caption.slice(0, 40)));
    if (at >= 0) return { pos: topLevel(doc, blocks[at].pos), page: s.page, inline: false };
  }
  const hit = locateSourceLine(tex, s.line - 1, blocks);
  const b = hit ? blocks[hit.index] : null;
  if (b && hit && b.pos > after) {
    if (b.kind === 'math') return { pos: b.pos, page: s.page, inline: true };
    const lineLen = Math.min(b.text.length - hit.offset, Math.max(1, plainWords(lines[s.line - 1] ?? '').length));
    const expected = hit.offset + (s.before > 0 ? Math.round(lineLen * s.before / Math.max(1, s.total)) : 0);
    const found = s.words?.length ? matchWords(b.text, s.words, expected) : null;
    if (found !== null || !s.words?.length) return markAt(doc, b, found ?? (s.before === 0 ? hit.offset : wordStart(b.text, expected)), s.page);
  }
  // the line's text was not where the source line said (LaTeX the words do not show, a paragraph
  // the source wraps): the first paragraph after the previous break holding the page's first words
  if (s.words?.length) {
    for (const c of blocks) {
      if (c.kind !== 'text' || c.pos <= after) continue;
      const f = findWords(c.text, s.words, 0);
      if (f && (f.score >= 3 || f.all)) return markAt(doc, c, f.at, s.page);
    }
  }
  return null;
}

/** where the pages of a build begin in the document (in order; a page whose text is not found has none) */
export function placeBreaks(doc: PMNode, tex: string, data: PageBreaks): PageMark[] {
  const blocks = blocksOf(doc), lines = tex.split('\n');
  const marks: PageMark[] = [];
  for (const s of data.starts) {
    let m: PageMark | null = null;
    try { m = placeStart(doc, lines, tex, blocks, s, marks.length ? marks[marks.length - 1].pos : 0); } catch { m = null; }
    if (!m || m.pos <= 0 || m.pos > doc.content.size) continue;
    if (marks.length && m.pos <= marks[marks.length - 1].pos) continue;   // out of order: the words were found in the wrong place
    marks.push(m);
  }
  return marks;
}

/* ------------------------------------------------------------------ the widgets */

function breakDom(mark: PageMark): () => HTMLElement {
  return () => {
    const el = document.createElement('span');
    el.className = 'ol-pagebreak' + (mark.inline ? ' inline' : '');
    el.dataset.page = String(mark.page);
    el.setAttribute('aria-hidden', 'true');
    for (const k of ['foot', 'gap', 'head']) { const l = document.createElement('span'); l.className = 'ol-pg-label ol-pg-' + k; el.appendChild(l); }
    return el;
  };
}
function endDom(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'ol-pagebreak ol-pageend';
  el.setAttribute('aria-hidden', 'true');
  const l = document.createElement('span'); l.className = 'ol-pg-label ol-pg-foot'; el.appendChild(l);
  return el;
}

/** slides and posters are pages already (editor/layout) */
const isLayoutDoc = (doc: PMNode) => doc.firstChild?.type.name === 'ol_page';

function decorations(doc: PMNode, st: Omit<PagesState, 'deco'>): DecorationSet {
  if (!st.on || !st.data?.pages || isLayoutDoc(doc)) return DecorationSet.empty;
  // (whether a break may have moved is the layout's business: the widget stays as it is)
  const ws = st.marks.map(m => Decoration.widget(m.pos, breakDom(m), { side: -1, ignoreSelection: true, key: `pg${m.page}${m.inline ? 'i' : 'b'}` }));
  ws.push(Decoration.widget(doc.content.size, endDom, { side: 1, ignoreSelection: true, key: 'pg-end' }));
  return DecorationSet.create(doc, ws);
}

/* ------------------------------------------------------------------ the sheets */

const frameOf = (d: PageBreaks, page: number): PageFrame | undefined => d.frames.find(f => f.page === page) ?? d.frames[0];
const setStyle = (el: HTMLElement, prop: string, value: string) => { if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value); };

/** a page's frame with the margins being dragged */
function adjusted(f: PageFrame, a: PageAdjust | null): PageFrame {
  if (!a || !f.paperW || !f.paperH || (a.left === undefined && a.right === undefined && a.top === undefined && a.bottom === undefined)) return f;
  const left = a.left ?? f.left, right = a.right ?? f.paperW - f.left - f.width;
  const top = a.top ?? f.top, bottom = a.bottom ?? f.paperH - f.top - f.height;
  return { ...f, left, top, width: f.paperW - left - right, height: f.paperH - top - bottom };
}

/** a sheet as laid out (px from the editor host's top-left): its first page and frame */
interface Sheet { page: number; x: number; y: number; w: number; h: number; f: PageFrame }

/** size the widgets (each page filled out to its text height) and paint the sheets behind the text */
function layout(view: EditorView, ui: PagesUi | null): void {
  const host = view.dom.parentElement;
  if (!host) return;
  const st = pagesKey.getState(view.state);
  const data = st?.on && !isLayoutDoc(view.state.doc) ? st.data : null;
  host.classList.toggle('ol-pages', !!data?.pages);
  if (!data?.pages) {
    for (const p of ['background-image', 'background-position', 'background-size', 'padding-top', 'min-width']) host.style.removeProperty(p);
    delete host.dataset.pgCentred;
    ui?.draw([], 0, view);
    return;
  }
  // (px per pt: the editor's font size is the document's base size, --ol-basept, as editor/fontsize.ts reads it)
  const cs = getComputedStyle(view.dom);
  const ptpx = parseFloat(cs.fontSize) / (Number(cs.getPropertyValue('--ol-basept')) || 10);
  const frame = (page: number) => adjusted(frameOf(data, Math.min(data.pages, Math.max(1, page)))!, st!.adjust);
  const first = frame(1);
  // the room of page 1's head; and the sheet at its size in a pane narrower than the paper (the page
  // scrolls sideways, as Google Docs' does): squeezed, its column could not sit where the margins put
  // it, and dragging one margin moved the other side
  setStyle(host, 'padding-top', `${GAP + first.top * ptpx}px`);
  setStyle(host, 'min-width', `${Math.ceil((first.paperW ?? first.left * 2 + first.width) * ptpx + 2 * GAP)}px`);
  const hostR = host.getBoundingClientRect(), colR = view.dom.getBoundingClientRect();
  if (!colR.height) return;   // hidden
  const colLeft = colR.left - hostR.left, colW = colR.width;
  // wider than the pane: the text column in the middle of it, once for each width of pane and paper
  const pane = host.closest<HTMLElement>('.editor-scroll');
  if (pane && pane.scrollWidth > pane.clientWidth + 1) {
    const key = `${pane.clientWidth}:${host.style.minWidth}`;
    if (host.dataset.pgCentred !== key && !host.classList.contains('ol-pg-dragging')) {
      host.dataset.pgCentred = key;
      pane.scrollLeft = colR.left - pane.getBoundingClientRect().left + pane.scrollLeft + colW / 2 - pane.clientWidth / 2;
    }
  } else if (host.dataset.pgCentred) delete host.dataset.pgCentred;
  const widgets = Array.from(view.dom.querySelectorAll<HTMLElement>('.ol-pagebreak')).filter(w => w.offsetParent !== null);
  // read everything first (the positions as they are), then write: a widget's new height moves what follows by the difference
  const rects = widgets.map(w => w.getBoundingClientRect());
  const sheets: Sheet[] = [];
  let shift = 0, start = colR.top - hostR.top, page = 1;
  const sheetX = (f: PageFrame) => colLeft - f.left * ptpx;
  const sheetW = (f: PageFrame) => (f.paperW ?? f.left * 2 + f.width) * ptpx;
  for (let i = 0; i < widgets.length; i++) {
    const w = widgets[i], r = rects[i];
    const end = w.classList.contains('ol-pageend');
    const next = end ? data.pages + 1 : Number(w.dataset.page) || page + 1;
    const f = frame(next - 1), g = frame(next);
    const top = r.top - hostR.top + shift;
    // the page(s) above: at least their text height (a page the editor could not place shares the sheet before it)
    const fill = Math.max(0, Math.max(1, next - page) * f.height * ptpx - (top - start));
    const foot = Math.max(0, ((f.paperH ?? f.top + f.height + f.top * 0.8) - f.top - f.height) * ptpx);
    const head = end ? 0 : g.top * ptpx;
    const height = fill + foot + (end ? GAP : GAP + head);
    shift += height - r.height;
    setStyle(w, 'height', `${height}px`);
    const x = colLeft - (r.left - hostR.left);
    const sy = start - frame(page).top * ptpx;
    sheets.push({ page, x: sheetX(f), y: sy, w: sheetW(f), h: Math.max(0, top + fill + foot - sy), f: frame(page) });
    const labels = w.children as HTMLCollectionOf<HTMLElement>;
    const label = (el: HTMLElement | undefined, text: string, y: number) => {
      if (!el) return;
      if (el.textContent !== text) el.textContent = text;
      setStyle(el, 'top', `${y}px`); setStyle(el, 'left', `${x}px`); setStyle(el, 'width', `${colW}px`);
    };
    label(labels[0], f.footer ?? '', fill + foot / 2 - 7);
    if (!end) {
      // edited above the break since the build (or the page setup changed): TeX may break the page elsewhere now
      const mark = st!.marks.find(m => m.page === next);
      const stale = !!st!.adjust?.pending || (!!mark && st!.editedFrom !== null && st!.editedFrom <= mark.pos);
      w.classList.toggle('stale', stale);
      label(labels[1], `Page ${next} of ${data.pages}` + (stale ? ' · may move: changed since the PDF was built' : ''), fill + foot + GAP / 2 - 7);
      label(labels[2], g.header ?? '', fill + foot + GAP + head / 2 - 7);
    }
    start = top + height;
    page = next;
  }
  setStyle(host, 'background-image', sheets.flatMap(() => ['linear-gradient(var(--pg-sheet), var(--pg-sheet))', 'linear-gradient(var(--pg-edge), var(--pg-edge))']).join(', '));
  setStyle(host, 'background-position', sheets.flatMap(s => [`${s.x}px ${s.y}px`, `${s.x - 1}px ${s.y - 1}px`]).join(', '));
  setStyle(host, 'background-size', sheets.flatMap(s => [`${s.w}px ${s.h}px`, `${s.w + 2}px ${s.h + 2}px`]).join(', '));
  ui?.draw(sheets, ptpx, view);
}

/* ------------------------------------------------------------------ dragging the page setup */

const PT_PER_CM = 72.27 / 2.54;
const cm = (pt: number) => `${(pt / PT_PER_CM).toFixed(1)} cm`;
/** margins in whole millimetres, at least 3 mm and leaving the text 2 cm */
const snapMargin = (pt: number, room: number) => Math.round(Math.min(Math.max(pt, 0.3 * PT_PER_CM), room - 2 * PT_PER_CM) / PT_PER_CM * 10) / 10 * PT_PER_CM;
/** line spacing: hundredths, caught by the usual ones on the way */
const SPACING_RUNGS = [1, 1.15, 1.25, 1.5, 2];
const snapStretch = (s: number) => { const r = SPACING_RUNGS.find(v => Math.abs(v - s) < 0.025); return r ?? Math.round(Math.min(3, Math.max(0.8, s)) * 100) / 100; };

type Edge = 'left' | 'right' | 'top' | 'bottom';
interface Drag { kind: Edge | 'spacing'; el: HTMLElement; sheet: Sheet; ptpx: number; startY: number; base: PageAdjust; d0: number; id: number }

/** a margin of a frame (pt) */
const marginOf = (f: PageFrame, e: Edge): number => e === 'left' ? f.left : e === 'top' ? f.top : e === 'right' ? f.paperW! - f.left - f.width : f.paperH! - f.top - f.height;
const noAdjust = (a: PageAdjust) => a.left === undefined && a.right === undefined && a.top === undefined && a.bottom === undefined && a.stretch === undefined;

/**
 * The page setup on the sheets, while Ctrl (⌘) is held: dashed guides on the text block's edges,
 * dragged to set the margins, and a grip in the left margin dragged to set the line spacing. The
 * editor shows the result as it is dragged; let go, the shell writes it into the document (a .tex
 * document's geometry and \spacing, a markdown document's geometry and linestretch) and builds the PDF.
 */
class PagesUi {
  readonly dom = document.createElement('div');
  private guides: HTMLElement[] = [];
  private grip = document.createElement('div');
  private tag = document.createElement('div');
  private hint = document.createElement('div');
  private sheets: Sheet[] = [];
  private ptpx = 1;
  private drag: Drag | null = null;
  private timer = 0;
  private raf = 0;

  constructor(private view: EditorView) {
    this.dom.className = 'ol-pg-ui';
    this.grip.className = 'ol-pg-spacing';
    this.grip.title = 'Drag up or down: the line spacing';
    this.tag.className = 'ol-pg-tag';
    this.hint.className = 'ol-pg-hint';
    this.hint.textContent = `Hold ${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} to drag the margins and the line spacing`;
    this.dom.append(this.hint, this.grip, this.tag);
    this.dom.addEventListener('pointerdown', this.down);
    window.addEventListener('keydown', this.key, true);
    window.addEventListener('keyup', this.keyUp, true);
    window.addEventListener('blur', this.off);
  }

  private get host(): HTMLElement | null { return this.view.dom.parentElement; }

  /** show the guides: after the key has been held a moment alone (Ctrl+S, Ctrl+B … do not flash them) */
  private key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.drag) { this.cancel(); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Control' || e.key === 'Meta') {
      if (e.repeat || !pagesHost || !this.sheets.length) return;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.host?.classList.add('ol-pg-adjust'), 220);
    } else if (!this.drag) this.off();
  };
  private keyUp = (e: KeyboardEvent) => { if ((e.key === 'Control' || e.key === 'Meta') && !this.drag) this.off(); };
  private off = () => { clearTimeout(this.timer); if (!this.drag) this.host?.classList.remove('ol-pg-adjust'); };

  /** the guides of the sheets as laid out, the grip beside the pointer's line */
  draw(sheets: Sheet[], ptpx: number, view: EditorView): void {
    this.view = view;
    this.sheets = sheets; this.ptpx = ptpx;
    const host = this.host;
    if (host && this.dom.parentElement !== host) host.appendChild(this.dom);
    const can = !!pagesHost && sheets.some(s => s.f.paperW && s.f.paperH);
    this.dom.hidden = !sheets.length;
    this.hint.hidden = !can;
    const n = can ? sheets.length * 4 : 0;
    while (this.guides.length < n) { const g = document.createElement('div'); g.className = 'ol-pg-guide'; this.dom.appendChild(g); this.guides.push(g); }
    while (this.guides.length > n) this.guides.pop()!.remove();
    if (!can) return;
    sheets.forEach((s, i) => {
      const tx = s.x + s.f.left * ptpx, tw = s.f.width * ptpx, ty = s.y + s.f.top * ptpx, th = s.f.height * ptpx;
      const place = (g: HTMLElement, edge: Edge, l: number, t: number, w: number, h: number) => {
        g.dataset.edge = edge; g.dataset.sheet = String(i);
        g.title = `Drag: the ${edge} margin`;
        setStyle(g, 'left', `${l}px`); setStyle(g, 'top', `${t}px`); setStyle(g, 'width', `${w}px`); setStyle(g, 'height', `${h}px`);
      };
      const [gl, gr, gt, gb] = this.guides.slice(i * 4, i * 4 + 4);
      place(gl, 'left', tx - 5, s.y, 10, s.h);
      place(gr, 'right', tx + tw - 5, s.y, 10, s.h);
      place(gt, 'top', s.x, ty - 5, s.w, 10);
      place(gb, 'bottom', s.x, ty + th - 5, s.w, 10);
    });
    const s1 = sheets[0];
    setStyle(this.hint, 'left', `${s1.x}px`); setStyle(this.hint, 'top', `${s1.y + 8}px`); setStyle(this.hint, 'width', `${s1.w - 14}px`);
    if (!this.drag) this.placeGrip(null);
  }

  /** the grip in the left margin, beside the line under the pointer (or where it was) */
  private placeGrip(clientY: number | null): void {
    const host = this.host;
    if (!host || !this.sheets.length) return;
    const hr = host.getBoundingClientRect();
    const y = clientY === null ? Number(this.grip.dataset.y ?? NaN) : clientY - hr.top;
    const s = this.sheets.find(x => y >= x.y && y < x.y + x.h) ?? this.sheets[0];
    const top = s.y + s.f.top * this.ptpx;
    const at = Number.isFinite(y) ? Math.min(Math.max(y, top), top + s.f.height * this.ptpx - 20) : top + 40;
    this.grip.dataset.y = String(at); this.grip.dataset.sheet = String(this.sheets.indexOf(s));
    setStyle(this.grip, 'left', `${s.x + s.f.left * this.ptpx - 30}px`); setStyle(this.grip, 'top', `${at - 10}px`);
    const st = pagesKey.getState(this.view.state);
    this.grip.textContent = '↕ ' + (st?.adjust?.stretch ?? pagesHost?.stretch() ?? 1).toFixed(2).replace(/0$/, '');
  }

  /** follow the pointer with the grip while the guides are shown */
  move(e: PointerEvent): void {
    if (this.drag) return;
    if (this.host?.classList.contains('ol-pg-adjust')) this.placeGrip(e.clientY);
  }

  private down = (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    const kind = t.classList.contains('ol-pg-spacing') ? 'spacing' : (t.dataset.edge as Edge | undefined);
    const st = pagesKey.getState(this.view.state);
    if (!kind || !st?.data || !pagesHost) return;
    const sheet = this.sheets[Number(t.dataset.sheet) || 0];
    if (!sheet) return;
    e.preventDefault(); e.stopPropagation();
    t.setPointerCapture(e.pointerId);
    const hr = this.host!.getBoundingClientRect();
    const textTop = sheet.y + sheet.f.top * this.ptpx;
    const stretch0 = st.adjust?.stretch0 ?? pagesHost.stretch();
    this.drag = { kind, el: t, sheet, ptpx: this.ptpx, startY: e.clientY, base: { ...(st.adjust ?? {}), stretch0, pending: false }, d0: Math.max(160, e.clientY - hr.top - textTop), id: e.pointerId };
    this.host!.classList.add('ol-pg-dragging');
    t.addEventListener('pointermove', this.dragMove);
    t.addEventListener('pointerup', this.up);
    t.addEventListener('pointercancel', this.cancelEvt);
  };

  private next(e: PointerEvent): PageAdjust {
    const d = this.drag!, f = d.sheet.f, hr = this.host!.getBoundingClientRect();
    const x = e.clientX - hr.left, y = e.clientY - hr.top, k = d.ptpx;
    const W = f.paperW!, H = f.paperH!;
    const right = W - f.left - f.width, bottom = H - f.top - f.height;
    const a: PageAdjust = { ...d.base };
    switch (d.kind) {
      case 'left': a.left = snapMargin((x - d.sheet.x) / k, W - right); break;
      case 'right': a.right = snapMargin((d.sheet.x + W * k - x) / k, W - f.left); break;
      case 'top': a.top = snapMargin((y - d.sheet.y) / k, H - bottom); break;
      case 'bottom': a.bottom = snapMargin(H - (y - d.sheet.y) / k, H - f.top); break;
      case 'spacing': a.stretch = snapStretch((d.base.stretch ?? d.base.stretch0 ?? 1) * (d.d0 + (e.clientY - d.startY)) / d.d0); break;
    }
    return a;
  }
  private show(a: PageAdjust, e: PointerEvent): void {
    const d = this.drag!, f = adjusted(d.sheet.f, a);
    const text = d.kind === 'spacing' ? `Line spacing ${(a.stretch ?? 1).toFixed(2)}` : `${d.kind[0].toUpperCase() + d.kind.slice(1)} margin ${cm(marginOf(f, d.kind))}`;
    this.tag.textContent = text;
    const hr = this.host!.getBoundingClientRect();
    setStyle(this.tag, 'left', `${e.clientX - hr.left + 14}px`); setStyle(this.tag, 'top', `${e.clientY - hr.top + 14}px`);
    this.tag.classList.add('on');
  }
  private dragMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const a = this.next(e);
    this.show(a, e);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.view.dispatch(this.view.state.tr.setMeta(pagesKey, { adjust: a } satisfies PagesMeta)));
  };
  /** the drag is over; the guides stay while the key is still held */
  private end(held = false): void {
    const t = this.drag?.el;
    if (t) { t.removeEventListener('pointermove', this.dragMove); t.removeEventListener('pointerup', this.up); t.removeEventListener('pointercancel', this.cancelEvt); }
    this.drag = null;
    this.tag.classList.remove('on');
    this.host?.classList.remove('ol-pg-dragging');
    if (!held) this.host?.classList.remove('ol-pg-adjust');
  }
  private up = (e: PointerEvent) => {
    if (!this.drag) return;
    const d = this.drag, a = this.next(e), f = adjusted(d.sheet.f, a);
    cancelAnimationFrame(this.raf);
    this.end(e.ctrlKey || e.metaKey);
    const moved = d.kind === 'spacing'
      ? Math.abs((a.stretch ?? 1) - (d.base.stretch ?? d.base.stretch0 ?? 1)) > 0.004
      : Math.abs(marginOf(f, d.kind) - marginOf(adjusted(d.sheet.f, d.base), d.kind)) > 0.5;
    // a click on a guide or the grip: nothing changes
    if (!moved) { this.view.dispatch(this.view.state.tr.setMeta(pagesKey, { adjust: noAdjust(d.base) ? null : { ...d.base, pending: true } } satisfies PagesMeta)); return; }
    this.view.dispatch(this.view.state.tr.setMeta(pagesKey, { adjust: { ...a, pending: true } } satisfies PagesMeta));
    const change = d.kind === 'spacing'
      ? { stretch: a.stretch ?? 1 }
      : { margins: { left: f.left, right: marginOf(f, 'right'), top: f.top, bottom: marginOf(f, 'bottom') } };
    void (pagesHost?.save(change) ?? Promise.resolve(false)).then(ok => { if (!ok) this.view.dispatch(this.view.state.tr.setMeta(pagesKey, { adjust: null } satisfies PagesMeta)); });
  };
  private cancelEvt = () => { this.cancel(); };
  /** Esc while dragging: the page setup as it was */
  private cancel(): void {
    if (!this.drag) return;
    const base = this.drag.base;
    cancelAnimationFrame(this.raf);
    this.end(true);
    this.view.dispatch(this.view.state.tr.setMeta(pagesKey, { adjust: noAdjust(base) ? null : { ...base, pending: true } } satisfies PagesMeta));
  }

  destroy(): void {
    clearTimeout(this.timer); cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.key, true);
    window.removeEventListener('keyup', this.keyUp, true);
    window.removeEventListener('blur', this.off);
    this.dom.remove();
  }
}

/* ------------------------------------------------------------------ the plugin */

export function pagesPlugin(): Plugin<PagesState> {
  let raf = 0;
  return new Plugin<PagesState>({
    key: pagesKey,
    state: {
      init: () => ({ on: false, data: null, marks: [], editedFrom: null, tex: null, placedSize: 0, adjust: null, deco: DecorationSet.empty }),
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(pagesKey) as PagesMeta | undefined;
        let { on, data, marks, editedFrom, tex, placedSize, adjust } = prev;
        if (meta && 'on' in meta) on = meta.on;
        if (meta && 'adjust' in meta) adjust = meta.adjust;
        // a new build — or the document arrived after its pages did (it was still loading: placed in next to nothing)
        if ((meta && 'data' in meta) || (tr.docChanged && data && tex && state.doc.content.size > 2 * placedSize + 50)) {
          if (meta && 'data' in meta) { data = meta.data; tex = meta.tex; adjust = null; }
          marks = data && tex ? placeBreaks(state.doc, tex, data) : [];
          placedSize = state.doc.content.size;
          editedFrom = null;
        } else if (tr.docChanged) {
          marks = marks.map(m => ({ ...m, pos: tr.mapping.map(m.pos, -1) }));
          let from = editedFrom === null ? null : tr.mapping.map(editedFrom, -1);
          tr.mapping.maps.forEach((map, i) => map.forEach((_a, _b, start) => {
            const at = tr.mapping.slice(i + 1).map(start, -1);
            from = from === null ? at : Math.min(from, at);
          }));
          editedFrom = from;
        } else if (!meta) return prev;
        const next = { on, data, marks, editedFrom, tex, placedSize, adjust };
        return { ...next, deco: meta && 'adjust' in meta && !tr.docChanged ? prev.deco : decorations(state.doc, next) };
      },
    },
    props: {
      decorations: state => pagesKey.getState(state)?.deco,
      attributes: (state): Record<string, string> => {
        const st = pagesKey.getState(state);
        if (!st?.on || !st.data?.pages || isLayoutDoc(state.doc)) return {};
        const d = st.data, f0 = d.frames[0];
        const vars: string[] = [];
        // the text column: the PDF's line, its margins as dragged; on the sheet, which is centred
        const f = f0 ? adjusted(f0, st.adjust) : null;
        const w = (d.lineWidth ?? f0?.width ?? 0) * (f && f0 && f0.width ? f.width / f0.width : 1);
        if (w) vars.push(`--pg-text-w: ${w.toFixed(2)}`);
        if (f?.paperW) vars.push(`--pg-paper-w: ${f.paperW.toFixed(2)}`, `--pg-left: ${f.left.toFixed(2)}`);
        // (the baseline distance, with the line spacing as dragged; the CSS divides it by the document's base size, the editor's font size)
        if (d.lead) vars.push(`--pg-lead-pt: ${(d.lead * (st.adjust?.stretch && st.adjust.stretch0 ? st.adjust.stretch / st.adjust.stretch0 : 1)).toFixed(2)}`);
        return { class: 'ol-paged', style: vars.join('; ') };
      },
    },
    view(view) {
      const ui = new PagesUi(view);
      const schedule = (v: EditorView) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { try { layout(v, ui); } catch { /* torn down */ } }); };
      const ro = new ResizeObserver(() => { if (pagesKey.getState(view.state)?.on) schedule(view); });
      ro.observe(view.dom);
      const move = (e: PointerEvent) => ui.move(e);
      const host = view.dom.parentElement;
      host?.addEventListener('pointermove', move);
      return {
        update: (v, prev) => {
          const now = pagesKey.getState(v.state), was = pagesKey.getState(prev);
          if (now?.on || was?.on) schedule(v);
        },
        destroy: () => { ro.disconnect(); cancelAnimationFrame(raf); host?.removeEventListener('pointermove', move); ui.destroy(); },
      };
    },
  });
}
