/**
 * A document as Google Docs holds it, and back (the model of the Google Docs sync, sync.ts).
 *
 * `project` turns the document model into blocks — paragraphs with a named style (headings),
 * list membership, quote / code / centring, and runs of styled text; tables of such runs — the
 * subset of a Google Doc the Docs API can write. What Docs has no counterpart for is written as
 * text that reads back: a formula as `$…$` (`$$…$$` centred on its own line), a citation as
 * `[@key]`, an image as `[image: file]`. Tracked changes are shown as they would be accepted
 * (Docs cannot hold suggestions written through the API); comment threads become Google comments.
 *
 * `readGoogle` reads a Google Doc (documents.get) into the same blocks, with the index ranges the
 * Docs API edits by; `toParagraphs` turns blocks that changed in Google Docs back into paragraphs.
 * `editRequests` (edits.ts) diffs a Google Doc against the blocks it should hold.
 */
import type { FontState, Inset, Item, LyxDocument, Paragraph, TabularInset } from '@overlyx/core';
import { paramMap, unquote, itemText, parseThread } from '@overlyx/core';
import { headingLevel } from '@overlyx/core/md/common.ts';

/* ------------------------------------------------------------------ blocks */

export interface GRun {
  text: string;
  b?: true; i?: true; u?: true; s?: true;
  /** monospace (inline code, raw LaTeX) */
  code?: true;
  link?: string;
  sup?: true; sub?: true;
  /** a footnote reference (`text` is '' — the reference is one character in Docs); its text */
  foot?: string;
}

export type ParaStyle = 'NORMAL_TEXT' | 'TITLE' | 'SUBTITLE' | 'HEADING_1' | 'HEADING_2' | 'HEADING_3' | 'HEADING_4' | 'HEADING_5' | 'HEADING_6';

export interface GPara {
  t: 'p';
  style: ParaStyle;
  list?: { ordered: boolean; level: number };
  quote?: true;
  /** a line of a code block */
  code?: true;
  center?: true;
  runs: GRun[];
}
export interface GTable { t: 'table'; cells: GRun[][][] }
export type GBlock = GPara | GTable;

/** a block and the body paragraph it shows (lines of one code block share it) */
export type Projected = GBlock & { src: number };

export interface Projection {
  blocks: Projected[];
  /** heading layouts by level: HEADING_n is headings[n - 1] */
  headings: string[];
}

/** a run as a key (the same run, whatever order its properties were set in) */
export const runKey = (r: GRun) => JSON.stringify([r.text, !!r.b, !!r.i, !!r.u, !!r.s, !!r.code, r.link ?? '', !!r.sup, !!r.sub, r.foot ?? null]);
const runsKey = (runs: GRun[]) => '[' + mergeRuns(runs).map(runKey).join(',') + ']';

/** a block's identity for diffing: everything the Docs API writes */
export function blockKey(b: GBlock): string {
  if (b.t === 'table') return 'T[' + b.cells.map(r => '[' + r.map(runsKey).join(',') + ']').join(',') + ']';
  return JSON.stringify([b.style, b.list ? [b.list.ordered, b.list.level] : null, !!b.quote, !!b.code, !!b.center]) + runsKey(b.runs);
}

/** do two run lists show the same text the same way? */
export const sameRuns = (a: GRun[], b: GRun[]) => runsKey(a) === runsKey(b);

const sameStyle = (a: GRun, b: GRun) => !!a.b === !!b.b && !!a.i === !!b.i && !!a.u === !!b.u && !!a.s === !!b.s && !!a.code === !!b.code && (a.link ?? '') === (b.link ?? '') && !!a.sup === !!b.sup && !!a.sub === !!b.sub;

/** adjacent runs of the same style joined, empty ones dropped */
export function mergeRuns(runs: GRun[]): GRun[] {
  const out: GRun[] = [];
  for (const r of runs) {
    if (r.foot === undefined && !r.text) continue;
    const last = out[out.length - 1];
    if (last && last.foot === undefined && r.foot === undefined && sameStyle(last, r)) { out[out.length - 1] = { ...last, text: last.text + r.text }; continue; }
    out.push({ ...r });
  }
  return out;
}

/* ------------------------------------------------------------------ document → blocks */

const HEADING_LADDER = ['Part', 'Chapter', 'Section', 'Subsection', 'Subsubsection', 'Paragraph', 'Subparagraph'];

/** the heading layouts of a document, top level first (the first one present is Heading 1) */
function headingsOf(body: Paragraph[]): string[] {
  const used = new Set(body.map(p => p.layout.replace(/\*$/, '')));
  const top = HEADING_LADDER.findIndex(l => used.has(l));
  return top < 0 ? HEADING_LADDER.slice(2) : HEADING_LADDER.slice(top);
}

function formulaText(latex: string): { text: string; display: boolean } {
  const t = latex.trim();
  let m = /^\$\$([\s\S]*)\$\$$/.exec(t) ?? /^\\\[([\s\S]*)\\\]$/.exec(t);
  if (m) return { text: m[1].trim(), display: true };
  m = /^\$([\s\S]*)\$$/.exec(t) ?? /^\\\(([\s\S]*)\\\)$/.exec(t);
  if (m) return { text: m[1].trim(), display: false };
  return { text: t, display: true };
}

function runStyle(f: FontState): Omit<GRun, 'text'> {
  const r: Omit<GRun, 'text'> = {};
  if (f.series === 'bold') r.b = true;
  if (f.emph === 'on' || f.shape === 'italic' || f.shape === 'slanted') r.i = true;
  if (f.bar === 'under' || f.uuline === 'on' || f.uwave === 'on') r.u = true;
  if (f.strikeout === 'on' || f.xout === 'on') r.s = true;
  if (f.family === 'typewriter') r.code = true;
  return r;
}

/** the runs of a paragraph's items (deleted text left out, as if the changes were accepted) */
export function itemRuns(items: Item[], inherited: Omit<GRun, 'text'> = {}): GRun[] {
  const out: GRun[] = [];
  for (const it of items) {
    if (it.change?.type === 'deleted') continue;
    const st = { ...inherited, ...runStyle(it.font) };
    if (it.kind === 'text') { out.push({ ...st, text: it.text.replace(/\n/g, ' ') }); continue; }
    if (it.kind === 'special') { out.push({ ...st, text: itemText(it) || (it.arg === 'LaTeX' || it.arg === 'TeX' || it.arg === 'LyX' ? it.arg : '') }); continue; }
    if (it.kind !== 'inset') continue;
    out.push(...insetRuns(it.inset, st));
  }
  return out;
}

function insetRuns(ins: Inset, st: Omit<GRun, 'text'>): GRun[] {
  switch (ins.type) {
    case 'Formula': {
      const f = formulaText(ins.latex);
      return [{ ...st, text: f.display ? `$$${f.text.replace(/\s*\n\s*/g, ' ')}$$` : `$${f.text}$` }];
    }
    case 'Leaf': {
      const pm = paramMap(ins.params);
      if (ins.name === 'Newline') return [{ ...st, text: '\u000b' }];
      if (ins.name === 'Quotes') return [{ ...st, text: ins.arg[2] === 's' ? (ins.arg[1] === 'l' ? '‘' : '’') : (ins.arg[1] === 'l' ? '“' : '”') }];
      if (ins.name === 'space') return [{ ...st, text: ' ' }];
      if (ins.name === 'Graphics') return [{ ...st, text: `[image: ${(pm.get('filename') ?? '').trim()}]` }];
      if (ins.name !== 'CommandInset') return [];
      switch (ins.arg) {
        case 'href': {
          const target = unquote(pm.get('target'));
          const name = unquote(pm.get('name')) || target;
          return [{ ...st, text: name, link: target }];
        }
        case 'citation': return [{ ...st, text: '[' + unquote(pm.get('key')).split(',').map(k => '@' + k.trim()).join('; ') + ']' }];
        case 'ref': return [{ ...st, text: `[ref: ${unquote(pm.get('reference'))}]` }];
        case 'line': return [{ ...st, text: '———' }];
        default: return [];
      }
    }
    case 'Text': {
      switch (ins.name) {
        case 'Note': return [];   // notes are not part of the text; comment threads become Google comments
        case 'Foot': return [{ ...st, text: '', foot: plainPars(ins.paragraphs) }];
        case 'ERT': return [{ ...st, code: true, text: ins.paragraphs.map(p => p.items.map(itemText).join('')).join(' ') }];
        case 'Flex':
          if (ins.arg === 'URL') { const url = plainPars(ins.paragraphs); return [{ ...st, text: url, link: url }]; }
          return itemRuns(flat(ins.paragraphs), st);
        case 'script': return itemRuns(flat(ins.paragraphs), { ...st, ...(ins.arg === 'subscript' ? { sub: true } : { sup: true }) });
        case 'listings': return [{ ...st, code: true, text: ins.paragraphs.map(p => p.items.map(itemText).join('')).join(' ') }];
        default: return itemRuns(flat(ins.paragraphs), st);
      }
    }
    case 'Tabular': return itemRuns(ins.rows.flatMap(r => r.cells.flatMap(c => flat(c.paragraphs))), st);
    default: return [];
  }
}

const flat = (pars: Paragraph[]): Item[] => pars.flatMap((p, i) => (i ? [{ kind: 'text', text: ' ', font: {} } as Item, ...p.items] : p.items));
const plainPars = (pars: Paragraph[]) => pars.map(p => p.items.filter(i => i.change?.type !== 'deleted').map(itemText).join('')).join(' ').trim();

function soleInset(p: Paragraph): Inset | null {
  const items = p.items.filter(i => !(i.kind === 'text' && !i.text.trim()) && i.change?.type !== 'deleted' && !(i.kind === 'inset' && i.inset.type === 'Text' && i.inset.name === 'Note'));
  return items.length === 1 && items[0].kind === 'inset' ? items[0].inset : null;
}

const isList = (l: string) => l === 'Itemize' || l === 'Enumerate' || l === 'Description' || l === 'Labeling';

/** The document's body as Google Docs blocks, each with the body paragraph it came from. */
export function project(doc: LyxDocument): Projection {
  const body = doc.body;
  const headings = headingsOf(body);
  const blocks: Projected[] = [];
  // a list's depths are counted from its first item (a list nested under a quote starts at depth 1)
  let listBase = -1;
  body.forEach((p, src) => {
    // a paragraph that was deleted as a whole (tracked) is not shown
    if (p.items.length && p.items.every(i => i.change?.type === 'deleted')) return;
    const layout = p.layout.replace(/\*$/, '');
    if (!isList(p.layout) && p.depth === 0) listBase = -1;
    const ins = soleInset(p);
    if (ins?.type === 'Tabular') { blocks.push({ t: 'table', cells: tableCells(ins), src }); return; }
    if (ins?.type === 'Text' && ins.name === 'listings') {
      for (const line of ins.paragraphs) {
        const text = line.items.filter(i => i.change?.type !== 'deleted').map(itemText).join('');
        blocks.push({ t: 'p', style: 'NORMAL_TEXT', code: true, runs: [{ text: text || ' ', code: true }], src });
      }
      return;
    }
    if (p.layout === 'LyX-Code') {
      blocks.push({ t: 'p', style: 'NORMAL_TEXT', code: true, runs: [{ text: p.items.map(itemText).join('') || ' ', code: true }], src });
      return;
    }
    const runs = mergeRuns(itemRuns(p.items));
    if (!runs.some(r => r.foot !== undefined || r.text.trim())) return;   // an empty paragraph: nothing in Docs
    const block: Projected = { t: 'p', style: 'NORMAL_TEXT', runs, src };
    const level = headings.indexOf(layout);
    if (level >= 0) block.style = (`HEADING_${Math.min(6, level + 1)}`) as ParaStyle;
    else if (layout === 'Title') block.style = 'TITLE';
    else if (layout === 'Author' || layout === 'Date' || layout === 'Subtitle') block.style = 'SUBTITLE';
    else if (isList(p.layout)) {
      if (listBase < 0 || p.depth < listBase) listBase = p.depth;
      block.list = { ordered: p.layout === 'Enumerate', level: Math.min(8, p.depth - listBase) };
    } else if (p.layout === 'Quote' || p.layout === 'Quotation' || p.layout === 'Verse') block.quote = true;
    if (ins?.type === 'Formula' && !ins.inline) block.center = true;
    else if (p.params.align === 'center') block.center = true;
    blocks.push(block);
  });
  return { blocks, headings };
}

function tableCells(t: TabularInset): GRun[][][] {
  return t.rows.map(r => r.cells.map(c => mergeRuns(c.paragraphs.flatMap((p, i) => [...(i ? [{ text: '\u000b' }] : []), ...itemRuns(p.items)]))));
}

/* ------------------------------------------------------------------ the Google Doc */

/** the parts of the Docs API's Document this sync reads (documents.get) */
export interface DocsTextStyle { bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; link?: { url?: string }; weightedFontFamily?: { fontFamily?: string }; baselineOffset?: string }
export interface DocsParagraphElement {
  startIndex: number; endIndex: number;
  textRun?: { content: string; textStyle?: DocsTextStyle; suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] };
  footnoteReference?: { footnoteId: string };
  [other: string]: unknown;
}
export interface DocsParagraph {
  elements: DocsParagraphElement[];
  paragraphStyle?: { namedStyleType?: string; indentStart?: { magnitude?: number }; alignment?: string };
  bullet?: { listId: string; nestingLevel?: number };
}
export interface DocsStructural { startIndex?: number; endIndex: number; paragraph?: DocsParagraph; table?: { rows: number; columns: number; tableRows: { tableCells: { content: DocsStructural[] }[] }[] }; [other: string]: unknown }
export interface DocsDocument {
  documentId: string; title?: string; revisionId?: string;
  body: { content: DocsStructural[] };
  lists?: Record<string, { listProperties?: { nestingLevels?: { glyphType?: string; glyphSymbol?: string }[] } }>;
  footnotes?: Record<string, { footnoteId?: string; content: DocsStructural[] }>;
}

/** a block of the Google Doc with where it is: the paragraph's / table's index range (a code block: one per line) */
export type ReadBlock = (GPara & { start: number; end: number; elements: DocsParagraphElement[]; locked?: true }) | (GTable & { start: number; end: number; cellParas: { start: number; end: number; elements: DocsParagraphElement[] }[][]; locked?: true });

export interface ReadDoc { blocks: ReadBlock[]; revisionId: string; /** where the body's text ends (the final newline sits at end - 1) */ end: number }

const MONO = /mono|courier|consolas|menlo|monaco|source code|inconsolata|fira code/i;

function readRuns(elements: DocsParagraphElement[], doc: DocsDocument): GRun[] {
  const runs: GRun[] = [];
  for (const el of elements) {
    if (el.footnoteReference) {
      const fn = doc.footnotes?.[el.footnoteReference.footnoteId];
      const text = fn ? fn.content.map(s => s.paragraph ? s.paragraph.elements.map(e => e.textRun?.content ?? '').join('') : '').join('').replace(/\n/g, ' ').trim() : '';
      runs.push({ text: '', foot: text });
      continue;
    }
    const tr = el.textRun;
    if (!tr) continue;
    // a suggested insertion is not (yet) part of the text; a suggested deletion still is
    if (tr.suggestedInsertionIds?.length) continue;
    const st = tr.textStyle ?? {};
    const r: GRun = { text: tr.content.replace(/\n$/, '') };
    if (st.bold) r.b = true;
    if (st.italic) r.i = true;
    if (st.underline && !st.link?.url) r.u = true;
    if (st.strikethrough) r.s = true;
    if (st.weightedFontFamily?.fontFamily && MONO.test(st.weightedFontFamily.fontFamily)) r.code = true;
    if (st.link?.url) r.link = st.link.url;
    if (st.baselineOffset === 'SUPERSCRIPT') r.sup = true;
    if (st.baselineOffset === 'SUBSCRIPT') r.sub = true;
    runs.push(r);
  }
  return mergeRuns(runs);
}

const hasSuggestions = (els: DocsParagraphElement[]) => els.some(e => !!(e.textRun?.suggestedInsertionIds?.length || e.textRun?.suggestedDeletionIds?.length));

function readPara(s: DocsStructural, doc: DocsDocument): (GPara & { start: number; end: number; elements: DocsParagraphElement[]; locked?: true }) | null {
  const p = s.paragraph!;
  const runs = readRuns(p.elements, doc);
  if (!runs.some(r => r.foot !== undefined || r.text.trim())) return null;
  const named = p.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
  const style: ParaStyle = /^(TITLE|SUBTITLE|HEADING_[1-6])$/.test(named) ? named as ParaStyle : 'NORMAL_TEXT';
  const block: GPara & { start: number; end: number; elements: DocsParagraphElement[]; locked?: true } = { t: 'p', style, runs, start: s.startIndex ?? 0, end: s.endIndex, elements: p.elements };
  // a paragraph with suggestions pending is left alone until they are accepted or rejected
  if (hasSuggestions(p.elements)) block.locked = true;
  if (p.bullet) {
    const level = p.bullet.nestingLevel ?? 0;
    const glyph = doc.lists?.[p.bullet.listId]?.listProperties?.nestingLevels?.[level];
    block.list = { ordered: !!glyph?.glyphType && glyph.glyphType !== 'GLYPH_TYPE_UNSPECIFIED' && !glyph.glyphSymbol, level };
  } else if (style === 'NORMAL_TEXT' && runs.every(r => r.code || (!r.text.trim() && r.foot === undefined))) {
    block.code = true;
  } else if ((p.paragraphStyle?.indentStart?.magnitude ?? 0) >= 18 && style === 'NORMAL_TEXT') {
    block.quote = true;
  }
  if (p.paragraphStyle?.alignment === 'CENTER') block.center = true;
  return block;
}

/** A Google Doc's body as blocks (empty paragraphs left out, like empty ones of the document). */
export function readGoogle(doc: DocsDocument): ReadDoc {
  const blocks: ReadBlock[] = [];
  let end = 1;
  for (const s of doc.body.content) {
    end = Math.max(end, s.endIndex);
    if (s.paragraph) { const b = readPara(s, doc); if (b) blocks.push(b); continue; }
    if (s.table) {
      const cellParas = s.table.tableRows.map(r => r.tableCells.map(c => {
        const paras = c.content.filter(x => x.paragraph);
        const first = paras[0], last = paras[paras.length - 1];
        return { start: first?.startIndex ?? 0, end: last?.endIndex ?? 0, elements: paras.flatMap((x, i) => [...(i ? [{ startIndex: x.startIndex ?? 0, endIndex: x.startIndex ?? 0, textRun: { content: '\u000b' } } as DocsParagraphElement] : []), ...x.paragraph!.elements]) };
      }));
      const cells = cellParas.map(r => r.map(c => readRuns(c.elements, doc)));
      const locked = cellParas.some(r => r.some(c => hasSuggestions(c.elements)));
      blocks.push({ t: 'table', cells, start: s.startIndex ?? 0, end: s.endIndex, cellParas, ...(locked ? { locked: true as const } : {}) });
    }
  }
  return { blocks, revisionId: doc.revisionId ?? '', end };
}

/** blocks without their positions (what a sync stores as the Google Doc it left) */
export function strip(blocks: (GBlock & object)[]): GBlock[] {
  return blocks.map(b => (b.t === 'table' ? { t: 'table', cells: b.cells } : { t: 'p', style: b.style, ...(b.list ? { list: b.list } : {}), ...(b.quote ? { quote: true } : {}), ...(b.code ? { code: true } : {}), ...(b.center ? { center: true } : {}), runs: b.runs } as GBlock));
}

/* ------------------------------------------------------------------ blocks → paragraphs (changes made in Google Docs) */

const FORMULA_RE = /\$\$([^$]+)\$\$|\$([^\s$](?:[^$]*[^\s$])?)\$/g;
const TOKEN_RE = /\[image: ([^\]]+)\]|\[(@[^\]]+)\]|\[ref: ([^\]]+)\]/g;

function runFont(r: GRun): FontState {
  const f: FontState = {};
  if (r.code) f.family = 'typewriter';
  if (r.b) f.series = 'bold';
  if (r.i) f.emph = 'on';
  if (r.u) f.bar = 'under';
  if (r.s) f.strikeout = 'on';
  return f;
}

/** a run's text as items: formulas, citations, images and line breaks written as text become insets again */
function runItems(r: GRun): Item[] {
  const font = runFont(r);
  if (r.foot !== undefined) return [{ kind: 'inset', font: {}, inset: { type: 'Text', name: 'Foot', arg: '', params: [], status: 'collapsed', paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: r.foot ? [{ kind: 'text', text: r.foot, font: {} }] : [] }] } }];
  if (r.link) {
    return [{ kind: 'inset', font, inset: { type: 'Leaf', name: 'CommandInset', arg: 'href', params: ['LatexCommand href', `name "${(r.text === r.link ? '' : r.text).replace(/"/g, '\\"')}"`, `target "${r.link.replace(/"/g, '\\"')}"`, 'literal "true"'] } }];
  }
  if (r.sup || r.sub) return [{ kind: 'inset', font: {}, inset: { type: 'Text', name: 'script', arg: r.sup ? 'superscript' : 'subscript', params: [], status: 'open', paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: textItems(r.text, font, false) }] } }];
  return textItems(r.text, font, !r.code);
}

function textItems(text: string, font: FontState, markup: boolean): Item[] {
  const out: Item[] = [];
  const pushText = (t: string) => {
    const parts = t.split('\u000b');
    parts.forEach((p, i) => {
      if (i) out.push({ kind: 'inset', font: {}, inset: { type: 'Leaf', name: 'Newline', arg: 'newline', params: [] } });
      if (p) out.push({ kind: 'text', text: p, font: { ...font } });
    });
  };
  if (!markup) { pushText(text); return out; }
  let at = 0;
  const all = [...text.matchAll(FORMULA_RE), ...text.matchAll(TOKEN_RE)].sort((a, b) => a.index! - b.index!);
  for (const m of all) {
    if (m.index! < at) continue;
    pushText(text.slice(at, m.index));
    at = m.index! + m[0].length;
    if (m[0].startsWith('$')) {
      const display = m[1] !== undefined;
      out.push({ kind: 'inset', font: {}, inset: { type: 'Formula', inline: !display, latex: display ? `\\[${m[1].trim()}\\]` : `$${m[2]}$` } });
    } else if (m[0].startsWith('[image: ')) {
      out.push({ kind: 'inset', font: {}, inset: { type: 'Leaf', name: 'Graphics', arg: '', params: [`\tfilename ${m[1].trim()}`] } });
    } else if (m[2]) {
      const keys = m[2].split(/;\s*/).map(k => k.replace(/^@/, '').trim()).filter(Boolean);
      out.push({ kind: 'inset', font: {}, inset: { type: 'Leaf', name: 'CommandInset', arg: 'citation', params: ['LatexCommand cite', 'after ""', 'before ""', `key "${keys.join(',')}"`, 'literal "false"'] } });
    } else {
      out.push({ kind: 'inset', font: {}, inset: { type: 'Leaf', name: 'CommandInset', arg: 'ref', params: ['LatexCommand ref', `reference "${m[3].trim()}"`, 'plural "false"', 'caps "false"', 'noprefix "false"', 'nolink "false"'] } });
    }
  }
  pushText(text.slice(at));
  return out;
}

/**
 * Blocks (changed in Google Docs) as body paragraphs. `headings`: the document's heading layouts
 * by level; `markdown`: a markdown document (only markdown's layouts).
 */
export function toParagraphs(blocks: GBlock[], headings: string[], markdown: boolean): Paragraph[] {
  const out: Paragraph[] = [];
  const merged = (runs: GRun[]) => normalizeItems(runs.flatMap(runItems));
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.t === 'table') {
      const cols = Math.max(1, ...b.cells.map(r => r.length));
      const tab: TabularInset = {
        type: 'Tabular', attrs: [['version', '3'], ['rows', String(b.cells.length)], ['columns', String(cols)]], features: [['tabularvalignment', 'middle']],
        columns: Array.from({ length: cols }, () => ({ attrs: [['alignment', 'left'], ['valignment', 'top']] as [string, string][] })),
        rows: b.cells.map((r, ri) => ({
          attrs: [],
          cells: Array.from({ length: cols }, (_, c) => ({
            attrs: [['alignment', 'left'], ['valignment', 'top'], ...(ri === 0 ? [['topline', 'true'], ['bottomline', 'true']] as [string, string][] : ri === b.cells.length - 1 ? [['bottomline', 'true']] as [string, string][] : []), ['usebox', 'none']] as [string, string][],
            paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: merged(r[c] ?? []) }],
          })),
        })),
      };
      out.push({ layout: 'Standard', depth: 0, params: {}, items: [{ kind: 'inset', font: {}, inset: tab }] });
      continue;
    }
    if (b.code) {
      // consecutive code lines: one code block
      const lines: string[] = [];
      let j = i;
      for (; j < blocks.length && blocks[j].t === 'p' && (blocks[j] as GPara).code; j++) lines.push((blocks[j] as GPara).runs.map(r => r.text).join('').replace(/^ $/, ''));
      i = j - 1;
      out.push({ layout: 'Standard', depth: 0, params: {}, items: [{ kind: 'inset', font: {}, inset: { type: 'Text', name: 'listings', arg: '', params: ['lstparams ""', 'inline false'], status: 'open', paragraphs: lines.map(l => ({ layout: 'Plain Layout', depth: 0, params: {}, items: l ? [{ kind: 'text', text: l, font: {} }] : [] })) } }] });
      continue;
    }
    let layout = 'Standard', depth = 0;
    const h = /^HEADING_(\d)$/.exec(b.style);
    if (h) layout = headings[Number(h[1]) - 1] ?? headings[headings.length - 1] ?? 'Section';
    else if (b.style === 'TITLE') layout = markdown ? headings[0] ?? 'Section' : 'Title';
    else if (b.style === 'SUBTITLE') layout = markdown ? 'Standard' : 'Author';
    else if (b.list) { layout = b.list.ordered ? 'Enumerate' : 'Itemize'; depth = b.list.level; }
    else if (b.quote) layout = 'Quote';
    if (markdown && headingLevel(layout) && !headings.includes(layout)) layout = headings[0] ?? 'Section';
    const params: Paragraph['params'] = {};
    const items = merged(b.runs);
    const display = items.length === 1 && items[0].kind === 'inset' && items[0].inset.type === 'Formula' && !items[0].inset.inline;
    if (b.center && !display && !markdown) params.align = 'center';
    out.push({ layout, depth, params, items });
  }
  return out;
}

function normalizeItems(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === 'text' && last?.kind === 'text' && JSON.stringify(last.font) === JSON.stringify(it.font)) { out[out.length - 1] = { ...last, text: last.text + it.text }; continue; }
    out.push(it);
  }
  return out;
}

/* ------------------------------------------------------------------ comment threads of the document */

export interface DocThread {
  /** where the inset is: the body paragraph, and the plain text of the paragraph up to it (what the comment is on) */
  par: number;
  before: string;
  messages: { author: string; time: string; text: string }[];
  resolved: boolean;
}

/** the comment threads (structured Note Comment insets) of the body, in order */
export function docThreads(doc: LyxDocument): DocThread[] {
  const out: DocThread[] = [];
  doc.body.forEach((p, par) => {
    let before = '';
    for (const it of p.items) {
      if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Note' && it.inset.arg === 'Comment') {
        const t = parseThread(it.inset.paragraphs);
        if (t.isStructured && t.messages.length) out.push({ par, before, messages: t.messages, resolved: t.resolved });
        continue;
      }
      if (it.change?.type === 'deleted') continue;
      before += itemRuns([it]).map(r => r.text).join('');
    }
  });
  return out;
}
