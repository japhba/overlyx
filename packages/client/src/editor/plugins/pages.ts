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
import { baseSize } from '../fontsize';

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
  deco: DecorationSet;
}

export const pagesKey = new PluginKey<PagesState>('ol-pages');

type PagesMeta = { on: boolean } | { data: PageBreaks | null; tex: string | null };

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
  return { page, pages: st.data.pages, stale: st.editedFrom !== null && st.editedFrom < at };
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
 * Where the PDF line's words begin in a paragraph's text: the run of them found there, nearest to
 * `expected` among equally long runs. The page's first word may be the second half of a word
 * hyphenated across the break (the break then goes before the whole word), a section number or a
 * list label the editor draws itself (skipped); a formula's glyphs in the PDF line are skipped too.
 */
export function matchWords(text: string, words: string[], expected: number): number | null {
  const et = tokens(text), pt = tokens(words.join(' ')).map(x => x.t);
  if (!pt.length) return null;
  let best: { at: number; score: number } | null = null;
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
      if (!best || score > best.score || (score === best.score && Math.abs(et[i].at - expected) < Math.abs(best.at - expected))) best = { at: et[i].at, score };
    }
  }
  return best?.at ?? null;
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

/** where a page begins in the document, or null when its text is not found */
function placeStart(doc: PMNode, lines: string[], tex: string, blocks: Block[], s: PageStart): PageMark | null {
  const caption = floatCaption(lines, s.line - 1);
  if (caption && caption.length >= 3) {
    const at = blocks.findIndex(b => b.kind === 'text' && b.text.replace(/\s+/g, ' ').trim().startsWith(caption.slice(0, 40)));
    if (at >= 0) return { pos: topLevel(doc, blocks[at].pos), page: s.page, inline: false };
  }
  const hit = locateSourceLine(tex, s.line - 1, blocks);
  if (!hit) return null;
  const b = blocks[hit.index];
  if (b.kind === 'math') return { pos: b.pos, page: s.page, inline: true };
  const lineLen = Math.min(b.text.length - hit.offset, Math.max(1, plainWords(lines[s.line - 1] ?? '').length));
  const expected = hit.offset + (s.before > 0 ? Math.round(lineLen * s.before / Math.max(1, s.total)) : 0);
  const found = s.words?.length ? matchWords(b.text, s.words, expected) : null;
  const off = found ?? (s.before === 0 ? hit.offset : wordStart(b.text, expected));
  if (off <= 0 || !b.text.slice(0, off).trim()) return { pos: before(doc, b.pos - 1), page: s.page, inline: false };
  return { pos: blockPos(b, off), page: s.page, inline: true };
}

/** where the pages of a build begin in the document (in order; a page whose text is not found has none) */
export function placeBreaks(doc: PMNode, tex: string, data: PageBreaks): PageMark[] {
  const blocks = blocksOf(doc), lines = tex.split('\n');
  const marks: PageMark[] = [];
  for (const s of data.starts) {
    let m: PageMark | null = null;
    try { m = placeStart(doc, lines, tex, blocks, s); } catch { m = null; }
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

/** size the widgets (each page filled out to its text height) and paint the sheets behind the text */
function layout(view: EditorView): void {
  const host = view.dom.parentElement;
  if (!host) return;
  const st = pagesKey.getState(view.state);
  const data = st?.on && !isLayoutDoc(view.state.doc) ? st.data : null;
  host.classList.toggle('ol-pages', !!data?.pages);
  if (!data?.pages) {
    for (const p of ['background-image', 'background-position', 'background-size', 'padding-top']) host.style.removeProperty(p);
    return;
  }
  const hostR = host.getBoundingClientRect(), colR = view.dom.getBoundingClientRect();
  if (!colR.height) return;   // hidden
  const ptpx = parseFloat(getComputedStyle(view.dom).fontSize) / baseSize(view);
  const first = frameOf(data, 1)!;
  const padTop = GAP + first.top * ptpx;
  // (the column's top moves with the padding: measure as if it were set already)
  const dy = padTop - (parseFloat(host.style.paddingTop) || 0);
  setStyle(host, 'padding-top', `${padTop}px`);
  const colLeft = colR.left - hostR.left, colW = colR.width;
  const widgets = Array.from(view.dom.querySelectorAll<HTMLElement>('.ol-pagebreak')).filter(w => w.offsetParent !== null);
  // read everything first (the positions as they are), then write: a widget's new height moves what follows by the difference
  const rects = widgets.map(w => w.getBoundingClientRect());
  const sheets: { x: number; y: number; w: number; h: number }[] = [];
  let shift = dy, start = colR.top - hostR.top + dy, page = 1;
  const sheetX = (f: PageFrame) => colLeft - f.left * ptpx;
  const sheetW = (f: PageFrame) => (f.paperW ?? f.left * 2 + f.width) * ptpx;
  for (let i = 0; i < widgets.length; i++) {
    const w = widgets[i], r = rects[i];
    const end = w.classList.contains('ol-pageend');
    const next = end ? data.pages + 1 : Number(w.dataset.page) || page + 1;
    const f = frameOf(data, Math.min(data.pages, Math.max(1, next - 1)))!, g = frameOf(data, Math.min(data.pages, next))!;
    const top = r.top - hostR.top + shift;
    // the page(s) above: at least their text height (a page the editor could not place shares the sheet before it)
    const fill = Math.max(0, Math.max(1, next - page) * f.height * ptpx - (top - start));
    const foot = Math.max(0, ((f.paperH ?? f.top + f.height + f.top * 0.8) - f.top - f.height) * ptpx);
    const head = end ? 0 : g.top * ptpx;
    const height = fill + foot + (end ? GAP : GAP + head);
    shift += height - r.height;
    setStyle(w, 'height', `${height}px`);
    const x = colLeft - (r.left - hostR.left);
    const sy = start - frameOf(data, page)!.top * ptpx;
    sheets.push({ x: sheetX(f), y: sy, w: sheetW(f), h: Math.max(0, top + fill + foot - sy) });
    const labels = w.children as HTMLCollectionOf<HTMLElement>;
    const label = (el: HTMLElement | undefined, text: string, y: number) => {
      if (!el) return;
      if (el.textContent !== text) el.textContent = text;
      setStyle(el, 'top', `${y}px`); setStyle(el, 'left', `${x}px`); setStyle(el, 'width', `${colW}px`);
    };
    label(labels[0], f.footer ?? '', fill + foot / 2 - 7);
    if (!end) {
      // edited above the break since the build: TeX may break the page elsewhere now
      const mark = st!.marks.find(m => m.page === next);
      const stale = !!mark && st!.editedFrom !== null && st!.editedFrom <= mark.pos;
      w.classList.toggle('stale', stale);
      label(labels[1], `Page ${next} of ${data.pages}` + (stale ? ' · may move: edited since the PDF was built' : ''), fill + foot + GAP / 2 - 7);
      label(labels[2], g.header ?? '', fill + foot + GAP + head / 2 - 7);
    }
    start = top + height;
    page = next;
  }
  setStyle(host, 'background-image', sheets.flatMap(() => ['linear-gradient(var(--pg-sheet), var(--pg-sheet))', 'linear-gradient(var(--pg-edge), var(--pg-edge))']).join(', '));
  setStyle(host, 'background-position', sheets.flatMap(s => [`${s.x}px ${s.y}px`, `${s.x - 1}px ${s.y - 1}px`]).join(', '));
  setStyle(host, 'background-size', sheets.flatMap(s => [`${s.w}px ${s.h}px`, `${s.w + 2}px ${s.h + 2}px`]).join(', '));
}

/* ------------------------------------------------------------------ the plugin */

export function pagesPlugin(): Plugin<PagesState> {
  let raf = 0;
  const schedule = (view: EditorView) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { try { layout(view); } catch { /* torn down */ } }); };
  return new Plugin<PagesState>({
    key: pagesKey,
    state: {
      init: () => ({ on: false, data: null, marks: [], editedFrom: null, tex: null, placedSize: 0, deco: DecorationSet.empty }),
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(pagesKey) as PagesMeta | undefined;
        let { on, data, marks, editedFrom, tex, placedSize } = prev;
        if (meta && 'on' in meta) on = meta.on;
        // a new build — or the document arrived after its pages did (it was still loading: placed in next to nothing)
        if ((meta && 'data' in meta) || (tr.docChanged && data && tex && state.doc.content.size > 2 * placedSize + 50)) {
          if (meta && 'data' in meta) { data = meta.data; tex = meta.tex; }
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
        const next = { on, data, marks, editedFrom, tex, placedSize };
        return { ...next, deco: decorations(state.doc, next) };
      },
    },
    props: {
      decorations: state => pagesKey.getState(state)?.deco,
      attributes: (state): Record<string, string> => {
        const st = pagesKey.getState(state);
        if (!st?.on || !st.data?.pages || isLayoutDoc(state.doc)) return {};
        const vars: string[] = [];
        const w = st.data.lineWidth ?? st.data.frames[0]?.width;
        if (w) vars.push(`--pg-text-w: ${w.toFixed(2)}`);
        // (the baseline distance; the CSS divides it by the document's base size, the editor's font size)
        if (st.data.lead) vars.push(`--pg-lead-pt: ${st.data.lead.toFixed(2)}`);
        return { class: 'ol-paged', style: vars.join('; ') };
      },
    },
    view(view) {
      const ro = new ResizeObserver(() => { if (pagesKey.getState(view.state)?.on) schedule(view); });
      ro.observe(view.dom);
      return {
        update: (v, prev) => {
          const now = pagesKey.getState(v.state), was = pagesKey.getState(prev);
          if (now?.on || was?.on) schedule(v);
        },
        destroy: () => { ro.disconnect(); cancelAnimationFrame(raf); },
      };
    },
  });
}
