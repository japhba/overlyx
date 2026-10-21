/**
 * A document as a LessWrong draft holds it, and back (the model of the LessWrong sync, sync.ts).
 *
 * LessWrong's agent API (its MCP server, ForumMagnum app/api/mcp/mcpServer.ts) reads a draft as
 * markdown (Lexical → HTML → Turndown, app/api/agent/agentMarkdownView.ts) and edits it by what the
 * text says, not by position: `replace_text` swaps a quoted span of one block's text for inline
 * markdown, `insert_block` puts blocks before / after the top-level block a prefix starts, and
 * `delete_block` removes the block (or list item) a prefix starts. Quotes and prefixes are matched in
 * rendered text, case and punctuation folded, and must match exactly once
 * (app/api/agent/textIndexQuoteLocator.ts).
 *
 * Both sides are compared as this server's markdown: LessWrong's markdown and the document's are
 * read with the markdown parser (core md/parse.ts) and every paragraph written back with the writer
 * (md/write.ts), so the two markdown dialects (`*` vs `-` bullets, `*em*` vs `_em_`, footnote labels)
 * give the same keys.
 *
 * - `projectDocument`: the document as LessWrong is to show it \u2014 tracked changes as accepted; comment
 *   threads (synced on their own), notes, raw LaTeX / HTML, labels, images from the project and the
 *   LaTeX title block left out.
 * - `readBlocks`: markdown → top-level blocks (a list is one block, its items its paragraphs).
 * - `withLessWrongChanges`: what changed on LessWrong since the last sync, onto the document.
 * - `planPush`: the next round of edits that bring the draft towards the document.
 */
import type { Item, LyxDocument, Paragraph, Inset } from '@overlyx/core';
import { paramMap, itemText, resolveChanges } from '@overlyx/core';
import { parseMarkdown, writeMarkdown } from '@overlyx/core/md/index.ts';
import { markdownLayoutFor } from '@overlyx/core/md/common.ts';
import { normalize } from '@overlyx/core/md/parse.ts';
import { lcsPairs, lcsRegions } from '../lcs.ts';

/* ------------------------------------------------------------------ blocks */

export interface LwPar {
  par: Paragraph;
  /** identity: the paragraph as this server writes it (footnote labels left out) */
  key: string;
  /** its text as LessWrong matches quotes in it (`normText`) */
  text: string;
  /** the body paragraph of the document it shows (a projection's), -1 on LessWrong's side */
  src: number;
  /** an open suggestion on LessWrong is in it: the sync does not edit it */
  suggested: boolean;
}

export interface LwBlock { pars: LwPar[]; key: string; list: boolean }

/** where an open suggestion of the draft was (withoutSuggestions) */
const SUGGESTION = '\uE001';

/**
 * LessWrong's markdown of a draft without its open suggestions: they show as `<ins>\u2026</ins>` /
 * `<del>\u2026</del>` (Turndown's suggestion rules, server/editor/conversionUtils.ts) and stay
 * LessWrong's until someone accepts them there \u2014 the text is read as it stands without them, a
 * mark left where each was so that the sync does not edit those paragraphs.
 */
export function withoutSuggestions(md: string): { text: string; count: number } {
  let count = 0;
  const text = md
    .replace(/<ins>[\s\S]*?<\/ins>/g, () => { count++; return SUGGESTION; })
    .replace(/<del>([\s\S]*?)<\/del>/g, (_m, inner: string) => { count++; return SUGGESTION + inner; })
    // (an insertion between two words leaves both spaces)
    .replace(/ \uE001 /g, ' \uE001');
  return { text, count };
}

const isListLayout = (l: string) => l === 'Itemize' || l === 'Enumerate';

/** a paragraph as markdown: its key (and the markdown of a paragraph sent on its own) */
function parMarkdown(ctx: LyxDocument, p: Paragraph): string {
  return writeMarkdown({ ...ctx, body: [p] }).text.trim();
}

/**
 * A paragraph as it looks, for its key: runs of spaces as one and outside any emphasis, formulas
 * without the font around them (`*a $x$ b*` and `*a* $x$ *b*` show the same), footnotes as plain
 * text (LessWrong's read API gives a footnote's text only: Turndown's footnote rule).
 */
function looks(p: Paragraph, plain = false): Paragraph {
  const items: Item[] = [];
  for (const it of p.items) {
    if (it.kind === 'inset' && it.inset.type === 'Formula') { items.push({ ...it, font: {} }); continue; }
    if (it.kind === 'inset' && it.inset.type === 'Text') {
      const foot = it.inset.name === 'Foot';
      items.push({ ...it, inset: { ...it.inset, paragraphs: it.inset.paragraphs.map(q => looks(q, plain || foot)) } });
      continue;
    }
    if (it.kind !== 'text') { items.push(it); continue; }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(it.text.replace(/\s+/g, ' '))!;
    if (m[1]) items.push({ kind: 'text', text: ' ', font: {} });
    if (m[2]) items.push(plain ? { kind: 'text', text: m[2], font: {} } : { ...it, text: m[2] });
    if (m[3]) items.push({ kind: 'text', text: ' ', font: {} });
  }
  const merged = normalize(items).map(it => (it.kind === 'text' ? { ...it, text: it.text.replace(/ {2,}/g, ' ') } : it));
  // (the paragraph's own edges: no spaces)
  const first = merged[0], last = merged[merged.length - 1];
  if (first?.kind === 'text') merged[0] = { ...first, text: first.text.replace(/^ +/, '') };
  if (last?.kind === 'text') merged[merged.length - 1] = { ...last, text: (merged[merged.length - 1] as typeof last).text.replace(/ +$/, '') };
  return { ...p, items: merged.filter(it => !(it.kind === 'text' && !it.text)) };
}
const keyOf = (md: string) => md.replace(/\[\^[^\]\s]*\]/g, '[^]');

/** text as LessWrong's quote matching compares it: punctuation folded, case and spacing ignored */
export function normText(s: string): string {
  return s.replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-').replace(/\u2026/g, '...').replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/** what an item shows on LessWrong as text (formulas as their `$\u2026$` token, footnote references nothing) */
export function shownText(it: Item): string {
  if (it.kind !== 'inset') return itemText(it);
  const ins = it.inset;
  if (ins.type === 'Formula') { const t = ins.latex.replace(/^\$+|\$+$/g, '').replace(/^\\\[|\\\]$/g, '').trim(); return ins.inline ? `$${t}$` : `$$${t}$$`; }
  if (ins.type === 'Text' && ins.name === 'Foot') return '';
  if (ins.type === 'Tabular') return ins.rows.map(r => r.cells.map(c => c.paragraphs.map(p => p.items.map(shownText).join('')).join(' ')).join(' ')).join(' ');
  if (ins.type === 'Leaf' && ins.name === 'CommandInset') {
    const pm = paramMap(ins.params);
    return (pm.get('name') ?? pm.get('target') ?? '').replace(/^"|"$/g, '');
  }
  return itemText(it);
}
export const parText = (p: Paragraph) => normText(p.items.map(shownText).join(''));

/** Markdown (LessWrong's, without its suggestions, or a projection's) as top-level blocks. */
export function readBlocks(markdown: string, src: number[] = []): { blocks: LwBlock[]; doc: LyxDocument } {
  const r = parseMarkdown(markdown);
  const blocks: LwBlock[] = [];
  let node = -1;
  r.doc.body.forEach((p0, i) => {
    const suggested = p0.items.some(it => it.kind === 'text' && it.text.includes(SUGGESTION));
    const p = suggested ? { ...p0, items: normalize(p0.items.map(it => (it.kind === 'text' ? { ...it, text: it.text.split(SUGGESTION).join('') } : it))) } : p0;
    if (!p.items.some(it => shownText(it).trim() || (it.kind === 'inset' && it.inset.type !== 'Text'))) return;   // an empty paragraph (a suggested one)
    const par: LwPar = { par: p, key: keyOf(parMarkdown(r.doc, looks(p))), text: parText(p), src: src[i] ?? -1, suggested };
    const n = r.parNode[i] ?? -1;
    if (n !== node || !blocks.length) { blocks.push({ pars: [], key: '', list: isListLayout(p.layout) }); node = n; }
    blocks[blocks.length - 1].pars.push(par);
  });
  for (const b of blocks) b.key = b.pars.map(x => x.key).join('\n\u2029\n');
  return { blocks, doc: r.doc };
}

/* ------------------------------------------------------------------ the document as LessWrong shows it */

/** the LaTeX title block: LessWrong has the post's own title (and byline) */
const TITLE_LAYOUTS = new Set(['Title', 'Subtitle', 'Author', 'Date']);

/** what LessWrong never shows of a document: comment threads and notes, raw LaTeX / HTML, labels, images from the project */
export function hiddenOnLessWrong(it: Item): boolean {
  if (it.kind !== 'inset') return false;
  const ins = it.inset;
  if (ins.type === 'Text') return ins.name === 'Note' || ins.name === 'ERT';
  if (ins.type === 'Leaf' && ins.name === 'CommandInset' && ins.arg === 'label') return true;
  if (ins.type === 'Leaf' && ins.name === 'Graphics') return !/^https?:\/\//i.test((paramMap(ins.params).get('filename') ?? '').trim());
  return ins.type === 'FormulaMacro' || ins.type === 'Raw';
}

function shown(items: Item[], left: Set<string>): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    if (hiddenOnLessWrong(it)) {
      const ins = (it as Extract<Item, { kind: 'inset' }>).inset;
      if (ins.type === 'Text' && ins.name === 'ERT') left.add('raw LaTeX or HTML');
      else if (ins.type === 'Leaf' && ins.name === 'Graphics') left.add('images from the project (add them on LessWrong)');
      continue;
    }
    if (it.kind === 'inset' && it.inset.type === 'Text') { out.push({ ...it, inset: { ...it.inset, paragraphs: it.inset.paragraphs.map(p => ({ ...p, items: shown(p.items, left) })) } }); continue; }
    if (it.kind === 'inset' && it.inset.type === 'Tabular') {
      const t = it.inset;
      out.push({ ...it, inset: { ...t, rows: t.rows.map(r => ({ ...r, cells: r.cells.map(c => ({ ...c, paragraphs: c.paragraphs.map(p => ({ ...p, items: shown(p.items, left) })) })) })) } as Inset });
      continue;
    }
    // (runs of spaces show as one: sent as one)
    out.push(it.kind === 'text' && /\s{2,}/.test(it.text) ? { ...it, text: it.text.replace(/[ \t]{2,}/g, ' ') } : it);
  }
  return out;
}

export interface Projection {
  /** the markdown LessWrong is to hold */
  markdown: string;
  blocks: LwBlock[];
  /** the parsed markdown (the context the paragraphs are written in) */
  doc: LyxDocument;
  /** what was left out */
  left: string[];
}

export function projectDocument(doc: LyxDocument): Projection {
  const left = new Set<string>();
  const kept: Paragraph[] = [], srcOf: number[] = [];
  doc.body.forEach((p0, i) => {
    if (p0.items.length && p0.items.every(it => it.change?.type === 'deleted')) return;   // a deleted paragraph
    if (TITLE_LAYOUTS.has(p0.layout)) return;
    // the changes as accepted, paragraph by paragraph (a deleted paragraph break does not join them here: each keeps its source)
    const [p] = resolveChanges([{ ...p0, endChange: undefined }], true);
    const items = shown(p.items, left);
    if (!items.some(it => shownText(it).trim() || (it.kind === 'inset' && it.inset.type !== 'Text'))) return;
    kept.push({ ...p, items });
    srcOf.push(i);
  });
  const written = writeMarkdown({ ...doc, body: kept });
  // the parsed markdown's paragraphs → the kept paragraphs they came from (by where they are in the text)
  const r = parseMarkdown(written.text);
  const src = r.parSpans.map(sp => {
    if (!sp) return -1;
    const k = written.spans.findIndex(w => !!w && sp.start >= w.start && sp.start < Math.max(w.end, w.start + 1));
    return k >= 0 ? srcOf[k] : -1;
  });
  const { blocks, doc: parsed } = readBlocks(written.text, src);
  return { markdown: written.text, blocks, doc: parsed, left: [...left] };
}

/* ------------------------------------------------------------------ LessWrong → the document */

/** keys LessWrong holds differently from the document's for the same thing (a link's `equiv`): LessWrong's key → the document's */
export type Equivalences = Record<string, string>;
const eq = (keys: string[], e: Equivalences) => keys.map(k => e[k] ?? k);

/**
 * The base document with what changed on LessWrong since the last sync: the paragraphs where the
 * draft now differs from the one stored then, mapped to the base document's paragraphs (through
 * the base document's projection) and replaced by the paragraphs LessWrong has now. A replaced
 * paragraph keeps its layout when LessWrong's is the markdown form of it (a numbered LaTeX section
 * that came back as a `#` heading), and what LessWrong never showed of it (comment threads, notes,
 * labels, raw LaTeX, images from the project). Null when nothing maps (no change).
 */
export function withLessWrongChanges(baseDoc: LyxDocument, proj: LwBlock[], baseLw: LwBlock[], lwNow: LwBlock[], equiv: Equivalences = {}): LyxDocument | null {
  const B = baseLw.flatMap(b => b.pars), N = lwNow.flatMap(b => b.pars), P = proj.flatMap(b => b.pars);
  const changes = lcsRegions(B.map(x => x.key), N.map(x => x.key));
  if (!changes.length) return null;
  const toProj = new Map(lcsPairs(eq(B.map(x => x.key), equiv), P.map(x => x.key)));
  const srcOf = (k: number) => { const p = toProj.get(k); return p === undefined ? -1 : P[p].src; };
  const body = baseDoc.body.slice();
  const startOf = (k: number) => { for (let x = k; x < B.length; x++) { const s = srcOf(x); if (s >= 0) return s; } return body.length; };
  const edits: { from: number; to: number; pars: Paragraph[] }[] = [];
  for (const { a, b, c, d } of changes) {
    const srcs = [...new Set(Array.from({ length: b - a }, (_, k) => srcOf(a + k)).filter(s => s >= 0))].sort((x, y) => x - y);
    if (b > a && !srcs.length) continue;   // paragraphs that never mapped (shown differently on LessWrong): left alone
    const pars = N.slice(c, d).map((x, k) => {
      const old = b - a === d - c ? body[srcOf(a + k)] : undefined;
      if (!old) return x.par;
      // the document's own form of the paragraph, and what LessWrong never showed of it
      const keep = old.items.filter(hiddenOnLessWrong);
      const same = markdownLayoutFor(old.layout) === x.par.layout && old.depth === x.par.depth;
      return { ...x.par, ...(same ? { layout: old.layout, params: old.params } : {}), items: [...x.par.items, ...keep] };
    });
    if (srcs.length) {
      const from = srcs[0], to = srcs[srcs.length - 1] + 1;
      // what LessWrong never showed of paragraphs that are not replaced one by one
      if (b - a !== d - c) {
        const keep = body.slice(from, to).flatMap(p => p.items.filter(hiddenOnLessWrong));
        if (keep.length && pars.length) pars[pars.length - 1] = { ...pars[pars.length - 1], items: [...pars[pars.length - 1].items, ...keep] };
        // a figure (only what LessWrong does not show) between replaced paragraphs stays
        const figures = body.slice(from, to).filter((p, k) => !srcs.includes(from + k) && p.items.length && p.items.every(hiddenOnLessWrong));
        pars.push(...figures);
      }
      edits.push({ from, to, pars });
    } else {
      const at = startOf(a);
      edits.push({ from: at, to: at, pars });
    }
  }
  if (!edits.length) return null;
  edits.sort((x, y) => y.from - x.from || y.to - x.to);
  for (const e of edits) body.splice(e.from, e.to - e.from, ...e.pars);
  return { ...baseDoc, body };
}

/* ------------------------------------------------------------------ the document → LessWrong */

export type InsertLocation = 'start' | 'end' | { after: string } | { before: string };
export type LwOp =
  | { op: 'delete'; prefix: string; what: string }
  | { op: 'replace'; quote: string; replacement: string; what: string }
  | { op: 'insert'; location: InsertLocation; markdown: string; what: string };

/** an op's identity (one that failed is not tried again in the same sync) */
export const opKey = (o: LwOp) => JSON.stringify(o);

/** a paragraph's items in words: runs of text without spaces, runs of spaces, and each inset (one word) */
export interface Atom { item: Item; key: string; space: boolean }
export function atoms(p: Paragraph): Atom[] {
  const out: Atom[] = [];
  for (const it of p.items) {
    // (a formula is the same in or out of emphasis; a footnote by its text alone — model.ts looks)
    if (it.kind === 'inset' && it.inset.type === 'Formula') { out.push({ item: it, key: JSON.stringify(it.inset), space: false }); continue; }
    if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Foot') { out.push({ item: it, key: 'foot:' + normText(it.inset.paragraphs.map(parText).join(' ')), space: false }); continue; }
    if (it.kind !== 'text') { out.push({ item: it, key: JSON.stringify(it), space: false }); continue; }
    for (const part of it.text.split(/(\s+)/)) {
      if (!part) continue;
      const item: Item = { ...it, text: part };
      const space = /^\s+$/.test(part);
      out.push({ item, key: space ? ' ' : JSON.stringify([part, it.font]), space });
    }
  }
  return out;
}
const isFoot = (a: Atom) => a.item.kind === 'inset' && a.item.inset.type === 'Text' && a.item.inset.name === 'Foot';
const isImage = (a: Atom) => a.item.kind === 'inset' && a.item.inset.type === 'Leaf' && a.item.inset.name === 'Graphics';
const blocky = (a: Atom) => a.item.kind === 'inset' && (a.item.inset.type === 'Tabular' || (a.item.inset.type === 'Formula' && !a.item.inset.inline)
  || (a.item.inset.type === 'Text' && (a.item.inset.name === 'Foot' || a.item.inset.name === 'listings' || a.item.inset.name === 'Float')));

/** inline markdown of some words of a paragraph */
function inlineMd(ctx: LyxDocument, as: Atom[]): string {
  const p: Paragraph = { layout: 'Standard', depth: 0, params: {}, items: normalize(as.map(a => a.item)) };
  return writeMarkdown({ ...ctx, body: [p] }).text.trim();
}
const atomsText = (as: Atom[]) => normText(as.map(a => shownText(a.item)).join(''));

function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0 && n < 3; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/**
 * The words of `O` that differ from `N` (a paragraph's, or a stretch of one between footnotes) as a
 * quote (unique in the draft: `all`) and the markdown that replaces them. 'rebuild': the difference is
 * in something a text replacement cannot write (a table, a display equation, a code block); 'image':
 * the quote would take in an image LessWrong has there (replacing it would remove the image); null:
 * no quote is unique.
 */
function replaceIn(ctx: LyxDocument, O: Atom[], N: Atom[], all: string, what: string): LwOp | 'rebuild' | 'image' | null {
  let p = 0;
  while (p < O.length && p < N.length && O[p].key === N[p].key) p++;
  let s = 0;
  while (s < O.length - p && s < N.length - p && O[O.length - 1 - s].key === N[N.length - 1 - s].key) s++;
  let l = p, rO = O.length - s, rN = N.length - s;
  // the quote begins and ends with a word on both sides (spaces at its edges match unreliably)
  const startOk = () => l < rO && l < rN && !O[l].space && !N[l].space;
  const endOk = () => rO > l && rN > l && !O[rO - 1].space && !N[rN - 1].space;
  while (!(startOk() && endOk())) {
    if (!startOk() && l > 0) l--;
    else if (!endOk() && rO < O.length) { rO++; rN++; }
    else if (l > 0) l--;
    else if (rO < O.length) { rO++; rN++; }
    else break;
  }
  if (!(startOk() && endOk())) return null;
  const check = () => (O.slice(l, rO).some(isImage) ? 'image' : O.slice(l, rO).some(blocky) || N.slice(l, rN).some(blocky) ? 'rebuild' : null);
  if (check()) return check();
  // long enough to be found once
  while (count(all, atomsText(O.slice(l, rO))) !== 1) {
    if (l >= 2) l -= 2;
    else if (rO + 2 <= O.length) { rO += 2; rN += 2; }
    else if (l > 0 || rO < O.length) { l = 0; rO = O.length; rN = N.length; }
    else return null;
    if (check()) return check();
  }
  return { op: 'replace', quote: inlineMd(ctx, O.slice(l, rO)), replacement: inlineMd(ctx, N.slice(l, rN)), what: what.slice(0, 60) };
}

/**
 * The replacements that turn paragraph `o` (the draft's) into `n` (the document's). A paragraph with
 * footnotes is edited between them, stretch by stretch — never written again: LessWrong's API makes
 * footnotes only from inserted markdown, and puts their notes right below the inserted block, not at
 * the end of the post. 'footnote': its footnotes themselves differ (left to LessWrong's editor).
 */
function replaceOps(ctx: LyxDocument, o: LwPar, n: LwPar, all: string): LwOp[] | 'rebuild' | 'image' | 'footnote' | null {
  const O = atoms(o.par), N = atoms(n.par);
  const fo = O.filter(isFoot).map(a => a.key), fn = N.filter(isFoot).map(a => a.key);
  if (!fo.length && !fn.length) return stretchOps(ctx, O, N, all, o.text);
  if (fo.join('\n') !== fn.join('\n')) return 'footnote';
  const stretches = (A: Atom[]) => A.reduce<Atom[][]>((acc, a) => { if (isFoot(a)) acc.push([]); else acc[acc.length - 1].push(a); return acc; }, [[]]);
  const so = stretches(O), sn = stretches(N), ops: LwOp[] = [];
  for (let k = 0; k < so.length; k++) {
    const r = stretchOps(ctx, so[k], sn[k], all, o.text);
    if (r === 'rebuild') return 'footnote';
    if (!r || r === 'image') return r;
    ops.push(...r);
  }
  return ops;
}

const sameAtoms = (A: Atom[], B: Atom[]) => A.length === B.length && A.every((a, k) => a.key === B[k].key);

/**
 * The replacements of one stretch of words: one per place where it differs (cut in the middle of the
 * unchanged words between places at least eight words apart), so that what LessWrong has around them
 * — comments anchored there — stays; the whole stretch at once when a place's quote is not unique.
 */
function stretchOps(ctx: LyxDocument, O: Atom[], N: Atom[], all: string, what: string): LwOp[] | 'rebuild' | 'image' | null {
  if (sameAtoms(O, N)) return [];
  const pieces: [Atom[], Atom[]][] = [];
  if (O.length * N.length <= 4_000_000) {
    const regions = lcsRegions(O.map(a => a.key), N.map(a => a.key));
    let po = 0, pn = 0;
    for (let k = 0; k + 1 < regions.length; k++) {
      const gap = regions[k + 1].a - regions[k].b;
      if (gap < 16) continue;
      const co = regions[k].b + Math.floor(gap / 2), cn = regions[k].d + Math.floor(gap / 2);
      pieces.push([O.slice(po, co), N.slice(pn, cn)]);
      po = co; pn = cn;
    }
    pieces.push([O.slice(po), N.slice(pn)]);
  }
  if (pieces.length > 1) {
    const ops: LwOp[] = [];
    let ok = true;
    for (const [a, b] of pieces) {
      if (sameAtoms(a, b)) continue;
      const r = replaceIn(ctx, a, b, all, what);
      if (r === 'rebuild' || r === 'image') return r;
      if (!r) { ok = false; break; }
      ops.push(r);
    }
    if (ok) return ops;
  }
  const r = replaceIn(ctx, O, N, all, what);
  return r && typeof r === 'object' ? [r] : r;
}
const hasFoot = (b: LwBlock) => b.pars.some(x => atoms(x.par).some(isFoot));

/**
 * The start of a paragraph as a prefix no other paragraph of the draft starts with. A table is
 * found by its cells' text from the first, a code block by its first line, a display equation by its whole
 * `$$…$$` token (app/api/agent/textIndexQuoteLocator.ts $locateBlockByPrefix).
 */
function prefixOf(ctx: LyxDocument, x: LwPar, pars: LwPar[]): string | null {
  let A = atoms(x.par).filter(a => !(a.item.kind === 'inset' && a.item.inset.type === 'Text' && a.item.inset.name === 'Foot'));
  const head = A[0]?.item.kind === 'inset' ? A[0].item.inset : null;
  if (head?.type === 'Formula' && !head.inline && A.length === 1) return `$$\n${shownText(A[0].item).slice(2, -2)}\n$$`;
  // (a table: its cells' text one after the other, as LessWrong's text index has it)
  if (head?.type === 'Tabular') {
    const gap: Atom = { item: { kind: 'text', text: ' ', font: {} }, key: ' ', space: true };
    A = head.rows.flatMap(r => r.cells.flatMap(c => [...atoms(c.paragraphs[0] ?? { layout: 'Standard', depth: 0, params: {}, items: [] }), gap]));
    A.pop();
  }
  else if (head?.type === 'Text' && head.name === 'listings') A = atoms({ layout: 'Standard', depth: 0, params: {}, items: [{ kind: 'text', text: itemText(A[0].item).split('\n')[0], font: {} }] });
  const others = pars.filter(o => o !== x).map(o => o.text);
  for (let k = 1; k <= A.length; k++) {
    if (A[k - 1].space) continue;
    const t = atomsText(A.slice(0, k));
    if (t && (t.length >= 24 || k === A.length) && !others.some(o => o.startsWith(t))) return inlineMd(ctx, A.slice(0, k));
  }
  return null;
}

const sameShape = (h: LwBlock, w: LwBlock) => h.pars.length === w.pars.length && h.pars.every((x, k) => x.par.layout === w.pars[k].par.layout && x.par.depth === w.pars[k].par.depth);

function words(b: LwBlock): Set<string> { return new Set(b.pars.flatMap(x => x.text.split(' ')).filter(Boolean)); }
function similarity(h: LwBlock, w: LwBlock): number {
  const a = words(h), b = words(w);
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

/** blocks of a changed region that are the same block edited (monotone, by their words) */
function alignBlocks(H: LwBlock[], W: LwBlock[]): [number, number][] {
  if (H.length * W.length > 40_000) return [];
  const n = H.length, m = W.length, C = m + 1;
  const dp = new Float64Array((n + 1) * C);
  const sim = (i: number, j: number) => { const v = similarity(H[i], W[j]) + (sameShape(H[i], W[j]) ? 0.2 : 0); return v >= 0.5 ? v : 0; };
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    const v = sim(i, j);
    dp[i * C + j] = Math.max(dp[(i + 1) * C + j], dp[i * C + j + 1], v ? v + dp[(i + 1) * C + j + 1] : 0);
  }
  const out: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    const v = sim(i, j);
    if (v && dp[i * C + j] === v + dp[(i + 1) * C + j + 1]) { out.push([i, j]); i++; j++; } else if (dp[(i + 1) * C + j] >= dp[i * C + j + 1]) i++; else j++;
  }
  return out;
}

/**
 * The draft's blocks the sync works with: not the ones without text that the document does not have
 * — images (and embeds) added on LessWrong, which the document cannot show (its own images from the
 * project are not sent either): those are LessWrong's, never deleted or written around.
 */
function ownBlocks(have: LwBlock[], want: LwBlock[], equiv: Equivalences): LwBlock[] {
  const wk = new Set(want.map(b => b.key));
  return have.filter(b => b.pars.some(x => x.text) || wk.has(equiv[b.key] ?? b.key));
}

/**
 * The next round of edits that bring the draft (`have`) towards the document (`want`), one kind at a
 * time \u2014 deletions, then text replacements, then insertions \u2014 since each finds its place by text the
 * others change: the sync reads the draft again after each round. A list item that came or went
 * means the list is written again (blocks are inserted at the top level only); so does a paragraph
 * whose kind changed, or a change in a table, a display equation, a footnote or a code block.
 * Paragraphs with open LessWrong suggestions are not touched. `skip`: ops that failed already.
 */
export function planPush(have0: LwBlock[], want: LwBlock[], ctx: LyxDocument, equiv: Equivalences = {}, skip: Set<string> = new Set(), warnings: Set<string> = new Set()): LwOp[] {
  const have = ownBlocks(have0, want, equiv);
  const hk = eq(have.map(b => b.key), equiv), wk = want.map(b => b.key);
  const allPars = have.flatMap(b => b.pars);
  const all = allPars.map(x => x.text).join(' ');
  const deletes: LwOp[] = [], replaces: LwOp[] = [], inserts: LwOp[] = [];
  // (what an op of a later kind could not do is said only once that kind's turn has come: the draft changes before)
  const said: Set<string>[] = [new Set(), new Set(), new Set()];
  const [wDel, wRep, wIns] = said;
  const untouchable = (h: LwBlock) => {
    if (!h.pars.some(x => x.suggested)) return false;
    wDel.add('Paragraphs with open suggestions on LessWrong were not updated: accept or reject the suggestions there.');
    return true;
  };
  /** the block's deletion (false: it cannot be deleted — or its deletion failed already) */
  const deleteBlock = (h: LwBlock): boolean => {
    if (untouchable(h)) return false;
    const ops: LwOp[] = [];
    for (const x of h.list ? h.pars : h.pars.slice(0, 1)) {
      const prefix = prefixOf(ctx, x, allPars);
      if (prefix === null) { wDel.add(`A paragraph could not be removed from the LessWrong draft (its text is not unique there): \u201C${x.text.slice(0, 60)}\u201D`); return false; }
      ops.push({ op: 'delete', prefix, what: x.text.slice(0, 60) });
    }
    if (ops.some(o => skip.has(opKey(o)))) return false;
    deletes.push(...ops);
    return true;
  };
  const anchorAfter = (h: LwBlock | null): InsertLocation | null => {
    if (!h) return 'start';
    if (h === have[have.length - 1]) return 'end';
    const prefix = prefixOf(ctx, h.pars[0], allPars);
    return prefix === null ? null : { after: prefix };
  };
  const insertAfter = (h: LwBlock | null, ws: LwBlock[]) => {
    if (!ws.length) return;
    const location = anchorAfter(h);
    if (location === null) { wIns.add('Some paragraphs could not be placed in the LessWrong draft (the text before them is not unique there).'); return; }
    const markdown = writeMarkdown({ ...ctx, body: ws.flatMap(b => b.pars.map(x => x.par)) }).text.trim();
    if (location !== 'end' && ws.some(hasFoot)) wIns.add('New footnotes land right below their paragraph on LessWrong (its API cannot put them at the end of the post): move them there in its editor if you like.');
    inserts.push({ op: 'insert', location, markdown, what: ws[0].pars[0]?.text.slice(0, 60) ?? '' });
  };
  for (const { a, b, c, d } of lcsRegions(hk, wk)) {
    const H = have.slice(a, b), W = want.slice(c, d);
    const pairs = alignBlocks(H, W);
    let anchor: LwBlock | null = a > 0 ? have[a - 1] : null;
    let hi = 0, wi = 0;
    const pending: LwBlock[] = [];
    const flush = () => { insertAfter(anchor, pending.splice(0)); };
    for (const [pi, pj] of [...pairs, [H.length, W.length] as [number, number]]) {
      for (; hi < pi; hi++) deleteBlock(H[hi]);
      for (; wi < pj; wi++) pending.push(W[wi]);
      if (pi === H.length) break;
      const h = H[pi], w = W[pj];
      hi++; wi++;
      if (untouchable(h)) { flush(); anchor = h; continue; }
      let rebuild = !sameShape(h, w);
      const edits: LwOp[] = [];
      if (!rebuild) {
        for (let k = 0; k < h.pars.length && !rebuild; k++) {
          if ((equiv[h.pars[k].key] ?? h.pars[k].key) === w.pars[k].key) continue;
          const r = replaceOps(ctx, h.pars[k], w.pars[k], all);
          if (r === 'rebuild') rebuild = true;
          else if (r === 'footnote') wRep.add(`A footnote changed in \u201C${h.pars[k].text.slice(0, 60)}\u201D: change it on LessWrong too \u2014 its API puts a footnote written again right below its paragraph, not at the end of the post.`);
          else if (r === 'image') wRep.add(`\u201C${h.pars[k].text.slice(0, 60)}\u201D holds an image on LessWrong, so it was not updated there (the edit would remove the image).`);
          else if (r) edits.push(...r);
          else wRep.add(`A paragraph could not be updated on LessWrong (its text is not unique there): \u201C${h.pars[k].text.slice(0, 60)}\u201D`);
        }
      } else if (h.list && w.list) {
        // items removed (and others edited in place): the list stays, the items go
        const items = lcsPairs(h.pars.map(x => x.text), w.pars.map(x => x.text));
        const sameItems = items.length === w.pars.length && items.every(([x, y]) => h.pars[x].par.layout === w.pars[y].par.layout && h.pars[x].par.depth === w.pars[y].par.depth);
        if (sameItems) {
          const kept = new Set(items.map(([x]) => x));
          h.pars.forEach((x, k) => {
            if (kept.has(k)) return;
            const prefix = prefixOf(ctx, x, allPars);
            if (prefix !== null) deletes.push({ op: 'delete', prefix, what: x.text.slice(0, 60) });
            else wDel.add(`A list item could not be removed from the LessWrong draft (its text is not unique there): \u201C${x.text.slice(0, 60)}\u201D`);
          });
          rebuild = false;
        }
      }
      if (rebuild && (hasFoot(h) || hasFoot(w))) {
        // (written again, its footnotes would land right below it: left as it is)
        wRep.add(`\u201C${h.pars[0]?.text.slice(0, 60) ?? ''}\u201D changed in a way LessWrong\u2019s API can only write again, and it has footnotes, which would then land right below it: change it on LessWrong.`);
        flush();
        anchor = h;
        continue;
      }
      if (rebuild) {
        // written again: deleted, then inserted where it was — unless it cannot be deleted (then it stays as it is)
        if (deleteBlock(h)) { pending.push(w); continue; }
        wRep.add(`A paragraph could not be updated on LessWrong: \u201C${h.pars[0]?.text.slice(0, 60) ?? ''}\u201D`);
        flush();
        anchor = h;
        continue;
      }
      replaces.push(...edits);
      flush();
      anchor = h;
    }
    flush();
  }
  const fresh = (ops: LwOp[]) => ops.filter(o => !skip.has(opKey(o)));
  const kinds = [deletes, replaces, inserts];
  const turn = kinds.findIndex(ops => fresh(ops).length);
  for (const w of said.slice(0, turn < 0 ? 3 : turn + 1)) for (const x of w) warnings.add(x);
  return turn < 0 ? [] : fresh(kinds[turn]);
}

/**
 * After a sync: blocks the draft still holds differently although the document's were written into
 * it \u2014 LessWrong keeps them its own way (a link it shortened, a list it renumbered) \u2014 are
 * remembered as the same, so that later syncs do not write them again: pairs of blocks in regions of
 * equal length that are the `same` (the same words); everything else stays a difference (and a
 * warning), tried again by the next sync.
 */
export function settle(have0: LwBlock[], want: LwBlock[], equiv: Equivalences, same: (h: LwBlock, w: LwBlock) => boolean = () => true): { equiv: Equivalences; unsettled: number } {
  // (worked out again from the two as they are, not carried over: a pair that differs after all is not kept)
  const have = ownBlocks(have0, want, equiv);
  const out: Equivalences = {};
  let unsettled = 0;
  for (const { a, b, c, d } of lcsRegions(have.map(x => x.key), want.map(x => x.key))) {
    if (b - a !== d - c) { unsettled += Math.max(b - a, d - c); continue; }
    for (let k = 0; k < b - a; k++) {
      const h = have[a + k], w = want[c + k];
      if (h.pars.some(x => x.suggested) || !same(h, w)) { unsettled++; continue; }
      out[h.key] = w.key;
      if (h.pars.length === w.pars.length) h.pars.forEach((x, i) => { if (x.key !== w.pars[i].key) out[x.key] = w.pars[i].key; });
    }
  }
  return { equiv: out, unsettled };
}
