/**
 * The Docs API requests (documents.batchUpdate) that turn a Google Doc into the blocks it should
 * hold (model.ts), touching as little as possible: an edited paragraph is edited word by word —
 * the comments and suggestions anchored in the rest of it stay — and unchanged paragraphs are not
 * touched at all. Requests are made from the end of the document towards its start, so the indices
 * read with the document stay valid while the batch is applied.
 *
 * A round does what it can with the indices it knows; what needs the document's new state comes
 * in the next round, which reads the document again: a new table is inserted empty and filled in
 * the next round, a new footnote likewise, and the bullets of lists (whose numbering needs all
 * items in one list) are set once every paragraph is right. `planRound` returns no requests once
 * the document is what it should be.
 */
import { tokenize, diffTokens } from '@overlyx/core';
import { blockKey, mergeRuns, sameRuns, readGoogle, type DocsDocument, type DocsParagraphElement, type GBlock, type GPara, type GRun, type ReadBlock, type ReadDoc } from './model.ts';

export type Request = Record<string, unknown>;

const FOOT = '￼';
const MONO_FONT = 'Roboto Mono';

/** the text of runs as Docs indexes it: a footnote reference is one character */
const atomText = (runs: GRun[]) => runs.map(r => (r.foot !== undefined ? FOOT : r.text)).join('');

/** a run's text style as the Docs API sets it (every field named, so what is not set is cleared) */
function textStyle(r: GRun): { textStyle: Record<string, unknown>; fields: string } {
  const st: Record<string, unknown> = {};
  if (r.b) st.bold = true;
  if (r.i) st.italic = true;
  if (r.u) st.underline = true;
  if (r.s) st.strikethrough = true;
  if (r.code) st.weightedFontFamily = { fontFamily: MONO_FONT, weight: 400 };
  if (r.link) st.link = { url: r.link };
  if (r.sup || r.sub) st.baselineOffset = r.sup ? 'SUPERSCRIPT' : 'SUBSCRIPT';
  return { textStyle: st, fields: 'bold,italic,underline,strikethrough,weightedFontFamily,link,baselineOffset' };
}

const styleKey = (r: GRun) => JSON.stringify([!!r.b, !!r.i, !!r.u, !!r.s, !!r.code, r.link ?? '', !!r.sup, !!r.sub]);

/** per character (atom) of the runs: the run it belongs to */
function atomRuns(runs: GRun[]): GRun[] {
  const out: GRun[] = [];
  for (const r of runs) {
    if (r.foot !== undefined) { out.push(r); continue; }
    for (let k = 0; k < r.text.length; k++) out.push(r);
  }
  return out;
}

/**
 * The paragraph style of a block (named style, indent, alignment, code shading). The indent of a
 * paragraph with bullets is the list's (`bulleted`: it has them already); one that is to get them is
 * set back to none until then.
 */
function paragraphStyle(b: GPara, range: { startIndex: number; endIndex: number }, bulleted = false): Request {
  const ps: Record<string, unknown> = { namedStyleType: b.style, alignment: b.center ? 'CENTER' : 'START' };
  const fields = ['namedStyleType', 'alignment', 'shading'];
  if (b.code) ps.shading = { backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } } };
  if (!b.list || !bulleted) {
    ps.indentStart = { magnitude: b.quote ? 36 : 0, unit: 'PT' };
    ps.indentFirstLine = { magnitude: b.quote ? 36 : 0, unit: 'PT' };
    fields.push('indentStart', 'indentFirstLine');
  }
  return { updateParagraphStyle: { range, paragraphStyle: ps, fields: fields.join(',') } };
}

const sameParaStyle = (a: GPara, b: GPara) => a.style === b.style && !!a.quote === !!b.quote && !!a.code === !!b.code && !!a.center === !!b.center;
const sameList = (a: GPara, b: GPara) => (!a.list && !b.list) || (!!a.list && !!b.list && a.list.ordered === b.list.ordered && a.list.level === b.list.level);

interface Plan { requests: Request[]; deferredLists: boolean }

/**
 * The text of a paragraph (`old`: its elements, from `start`) made `runs`, word by word: deleted and
 * inserted words, then the style of the words that stayed. Footnote references are atoms.
 */
function editText(plan: Plan, raw: DocsDocument, start: number, oldElements: DocsParagraphElement[], oldRuns: GRun[], newRuns: GRun[]): void {
  const oldText = atomText(oldRuns), newText = atomText(newRuns);
  const oldAtoms = atomRuns(oldRuns), newAtoms = atomRuns(newRuns);
  const footIds: string[] = oldElements.filter(e => e.footnoteReference).map(e => e.footnoteReference!.footnoteId);
  const ops = trimChanges(diffTokens(tokenize(oldText), tokenize(newText)));
  // positions of each op in the old and the new text
  type Op = { type: 'same' | 'add' | 'del'; text: string; o: number; n: number };
  const seq: Op[] = [];
  let o = 0, n = 0;
  for (const t of ops) {
    seq.push({ ...t, o, n });
    if (t.type !== 'add') o += t.text.length;
    if (t.type !== 'del') n += t.text.length;
  }
  let footBefore = (pos: number) => [...oldText.slice(0, pos)].filter(c => c === FOOT).length;
  footBefore = (pos: number) => { let c = 0; for (let k = 0; k < pos; k++) if (oldText[k] === FOOT) c++; return c; };
  for (let k = seq.length - 1; k >= 0; k--) {
    const op = seq[k];
    const at = start + op.o;
    if (op.type === 'del') { plan.requests.push({ deleteContentRange: { range: { startIndex: at, endIndex: at + op.text.length } } }); continue; }
    if (op.type === 'add') { insertRuns(plan, at, newAtoms.slice(op.n, op.n + op.text.length), op.text); continue; }
    // the same words: their styles, and the text of their footnotes
    let s = 0;
    while (s < op.text.length) {
      const want = newAtoms[op.n + s], have = oldAtoms[op.o + s];
      if (op.text[s] === FOOT) {
        if ((want.foot ?? '') !== (have.foot ?? '')) setFootnote(plan, raw, footIds[footBefore(op.o + s)], want.foot ?? '');
        s++;
        continue;
      }
      let e = s + 1;
      while (e < op.text.length && op.text[e] !== FOOT && styleKey(newAtoms[op.n + e]) === styleKey(want) && styleKey(oldAtoms[op.o + e]) === styleKey(have)) e++;
      if (styleKey(want) !== styleKey(have)) plan.requests.push({ updateTextStyle: { range: { startIndex: at + s, endIndex: at + e }, ...textStyle(want) } });
      s = e;
    }
  }
}

/**
 * Word changes narrowed to the characters that changed ("bold," → "strong," deletes "bold" and
 * inserts "strong"; the comma stays, and whatever is anchored to it).
 */
function trimChanges(ops: { type: 'same' | 'add' | 'del'; text: string }[]): { type: 'same' | 'add' | 'del'; text: string }[] {
  const out: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  for (let k = 0; k < ops.length;) {
    if (ops[k].type === 'same') { out.push(ops[k]); k++; continue; }
    let del = '', add = '';
    for (; k < ops.length && ops[k].type !== 'same'; k++) { if (ops[k].type === 'del') del += ops[k].text; else add += ops[k].text; }
    let p = 0;
    while (p < del.length && p < add.length && del[p] === add[p] && del[p] !== FOOT) p++;
    let q = 0;
    while (q < del.length - p && q < add.length - p && del[del.length - 1 - q] === add[add.length - 1 - q] && del[del.length - 1 - q] !== FOOT) q++;
    if (p) out.push({ type: 'same', text: del.slice(0, p) });
    if (del.length - p - q > 0) out.push({ type: 'del', text: del.slice(p, del.length - q) });
    if (add.length - p - q > 0) out.push({ type: 'add', text: add.slice(p, add.length - q) });
    if (q) out.push({ type: 'same', text: del.slice(del.length - q) });
  }
  return out;
}

/** `text` (atoms of `atoms`) inserted at `at`, styled, with its new footnotes (filled in the next round) */
function insertRuns(plan: Plan, at: number, atoms: GRun[], text: string): void {
  const plain = text.split(FOOT).join('');
  if (plain) {
    plan.requests.push({ insertText: { location: { index: at }, text: plain } });
    // style per run of equal style (in the text without footnote atoms)
    const styles = atoms.filter(a => a.foot === undefined);
    for (let s = 0; s < styles.length;) {
      let e = s + 1;
      while (e < styles.length && styleKey(styles[e]) === styleKey(styles[s])) e++;
      plan.requests.push({ updateTextStyle: { range: { startIndex: at + s, endIndex: at + e }, ...textStyle(styles[s]) } });
      s = e;
    }
  }
  // footnote references from the last to the first (each shifts what follows it)
  const positions: number[] = [];
  let chars = 0;
  for (const c of text) { if (c === FOOT) positions.push(chars); else chars += c.length; }
  for (let k = positions.length - 1; k >= 0; k--) plan.requests.push({ createFootnote: { location: { index: at + positions[k] } } });
}

/** a footnote's text replaced */
function setFootnote(plan: Plan, raw: DocsDocument, id: string | undefined, text: string): void {
  const fn = id ? raw.footnotes?.[id] : undefined;
  if (!fn || !id) return;
  const paras = fn.content.filter(s => s.paragraph);
  if (!paras.length) return;
  const start = paras[0].startIndex ?? 0, end = paras[paras.length - 1].endIndex;
  if (end - 1 > start) plan.requests.push({ deleteContentRange: { range: { segmentId: id, startIndex: start, endIndex: end - 1 } } });
  if (text) plan.requests.push({ insertText: { location: { segmentId: id, index: start }, text } });
}

/** paragraphs inserted at `at` as one piece of text; `atEnd`: into the document's (empty) last paragraph */
function insertParagraphs(plan: Plan, at: number, blocks: GPara[], lead: boolean, atEnd: boolean): void {
  const texts = blocks.map(b => atomText(b.runs));
  const plain = texts.map(t => t.split(FOOT).join(''));
  const whole = (lead ? '\n' : '') + plain.join('\n') + (atEnd || lead ? '' : '\n');
  if (!whole) return;
  // footnotes first would shift the text; the text goes in first, then styles, then footnotes (last first)
  plan.requests.push({ insertText: { location: { index: at }, text: whole } });
  let pos = at + (lead ? 1 : 0);
  const starts: number[] = [];
  blocks.forEach((b, i) => {
    starts.push(pos);
    const len = plain[i].length;
    // (bullets first: taking them away indents the paragraph, which its style then sets)
    plan.requests.push({ deleteParagraphBullets: { range: { startIndex: pos, endIndex: pos + len + 1 } } });
    plan.requests.push(paragraphStyle(b, { startIndex: pos, endIndex: pos + len + 1 }));
    if (b.list) plan.deferredLists = true;
    // reset the inherited text style, then the runs' own
    if (len) plan.requests.push({ updateTextStyle: { range: { startIndex: pos, endIndex: pos + len }, ...textStyle({ text: '' }) } });
    const atoms = atomRuns(b.runs).filter(a => a.foot === undefined);
    for (let s = 0; s < atoms.length;) {
      let e = s + 1;
      while (e < atoms.length && styleKey(atoms[e]) === styleKey(atoms[s])) e++;
      if (styleKey(atoms[s]) !== styleKey({ text: '' })) plan.requests.push({ updateTextStyle: { range: { startIndex: pos + s, endIndex: pos + e }, ...textStyle(atoms[s]) } });
      s = e;
    }
    pos += len + 1;
  });
  // the footnote references, from the last paragraph to the first
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = texts[i];
    const positions: number[] = [];
    let chars = 0;
    for (const c of t) { if (c === FOOT) positions.push(chars); else chars += c.length; }
    for (let k = positions.length - 1; k >= 0; k--) plan.requests.push({ createFootnote: { location: { index: starts[i] + positions[k] } } });
  }
}

/**
 * The requests of one round: `doc` (as read: documents.get) towards `want`. Empty when nothing is
 * left to do. Lists are made last, when everything else matches (their numbering spans paragraphs).
 */
export function planRound(raw: DocsDocument, want: GBlock[]): Request[] {
  const read = readGoogle(raw);
  const plan: Plan = { requests: [], deferredLists: false };
  const old = read.blocks;
  const pairs = alignBlocks(old.map(blockKey), want.map(blockKey));
  // the changed regions, last first
  const regions: { a: number; b: number; c: number; d: number }[] = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [old.length, want.length] as [number, number]]) {
    if (pi > i || pj > j) regions.push({ a: i, b: pi, c: j, d: pj });
    i = pi + 1; j = pj + 1;
  }
  let structural = false;
  const sameShape = (ob: ReadBlock, nb: GBlock) => ob.t === nb.t && (ob.t === 'p' || (ob.t === 'table' && nb.t === 'table' && ob.cells.length === nb.cells.length && ob.cells.every((row, ri) => row.length === nb.cells[ri].length)));
  /** old[a..b) → want[c..d): edited in place where the blocks pair up, else replaced */
  const planRegion = (a: number, b: number, c: number, d: number): void => {
    const olds = old.slice(a, b), news = want.slice(c, d);
    // blocks with suggestions pending in Google Docs are not touched (their indices are not the text's)
    if (olds.some(ob => ob.locked)) return;
    if (olds.length === news.length && olds.every((ob, k) => sameShape(ob, news[k]))) {
      for (let k = olds.length - 1; k >= 0; k--) updateBlock(plan, raw, olds[k], news[k]);
      return;
    }
    // a table of the same shape on both sides stays (its cells are edited): the parts around it on their own, the later one first
    for (let x = 0; x < olds.length; x++) {
      if (olds[x].t !== 'table') continue;
      const y = news.findIndex(nb => sameShape(olds[x], nb));
      if (y < 0) continue;
      planRegion(a + x + 1, b, c + y + 1, d);
      updateBlock(plan, raw, olds[x], news[y]);
      planRegion(a, a + x, c, c + y);
      return;
    }
    if (!olds.length && !news.length) return;
    structural = true;
    replaceRegion(plan, raw, a, olds, news, old);
  };
  for (let r = regions.length - 1; r >= 0; r--) planRegion(regions[r].a, regions[r].b, regions[r].c, regions[r].d);
  if (plan.requests.length || structural) return plan.requests;
  // everything else matches: the lists
  return listRequests(read, raw, want);
}

/** LCS pairs of equal keys (core's paragraph aligner does the same for the document model) */
function alignBlocks(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length;
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) dp[x * W + y] = a[x] === b[y] ? dp[(x + 1) * W + y + 1] + 1 : Math.max(dp[(x + 1) * W + y], dp[x * W + y + 1]);
  const out: [number, number][] = [];
  let x = 0, y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) { out.push([x, y]); x++; y++; }
    else if (dp[(x + 1) * W + y] >= dp[x * W + y + 1]) x++;
    else y++;
  }
  return out;
}

function updateBlock(plan: Plan, raw: DocsDocument, ob: ReadBlock, nb: GBlock): void {
  if (ob.t === 'table' && nb.t === 'table') {
    for (let r = ob.cells.length - 1; r >= 0; r--) {
      for (let c = ob.cells[r].length - 1; c >= 0; c--) {
        const have = ob.cells[r][c], want = mergeRuns(nb.cells[r][c] ?? []);
        if (sameRuns(have, want)) continue;
        const cell = ob.cellParas[r][c];
        editText(plan, raw, cell.start, cell.elements, have, want);
      }
    }
    return;
  }
  if (ob.t !== 'p' || nb.t !== 'p') return;
  if (!sameParaStyle(ob, nb) || (ob.list && !nb.list)) {
    // (bullets first: taking them away indents the paragraph, which its style then sets)
    if (ob.list && !nb.list) plan.requests.push({ deleteParagraphBullets: { range: { startIndex: ob.start, endIndex: ob.end } } });
    plan.requests.push(paragraphStyle(nb, { startIndex: ob.start, endIndex: ob.end }, !!ob.list && !!nb.list));
  }
  if (!sameList(ob, nb)) plan.deferredLists = true;
  if (!sameRuns(ob.runs, nb.runs)) editText(plan, raw, ob.start, ob.elements, ob.runs, mergeRuns(nb.runs));
}

/**
 * Blocks `olds` (old[a..)) replaced by `news`: the old ones deleted, the new paragraphs up to the
 * first table inserted (a table first: inserted empty, alone — the next round fills it and goes on).
 *
 * Text can only be inserted inside a paragraph, and the body's last newline (and the paragraph
 * that separates two tables) cannot be deleted. So a region that ends with a paragraph keeps that
 * paragraph's newline — an empty paragraph the new blocks are written into — and new blocks go
 * before the paragraph that follows, into an empty one, or after the one before a table.
 */
function replaceRegion(plan: Plan, raw: DocsDocument, a: number, olds: ReadBlock[], news: GBlock[], old: ReadBlock[]): void {
  let at: number;
  let mode: 'before' | 'into' | 'after';
  let restore: ReadBlock | null = null;
  if (olds.length) {
    const start = olds[0].start, last = olds[olds.length - 1];
    if (last.t === 'p') {
      if (last.end - 1 > start) plan.requests.push({ deleteContentRange: { range: { startIndex: start, endIndex: last.end - 1 } } });
      at = start; mode = 'into';
      if (!news.length || news[0].t === 'table') {
        // the empty paragraph left over: no heading, no bullet
        plan.requests.push({ deleteParagraphBullets: { range: { startIndex: start, endIndex: start + 1 } } });
        plan.requests.push(paragraphStyle({ t: 'p', style: 'NORMAL_TEXT', runs: [] }, { startIndex: start, endIndex: start + 1 }));
      }
    } else {
      // a table at the end: deleted whole; the paragraph after it (there always is one) now starts here
      plan.requests.push({ deleteContentRange: { range: { startIndex: start, endIndex: last.end } } });
      at = start; mode = 'before';
    }
  } else {
    const prevEnd = a > 0 ? old[a - 1].end : 1;
    const next = raw.body.content.find(el => (el.startIndex ?? 0) === prevEnd && (el.paragraph || el.table));
    if (next?.paragraph && isEmptyParagraph(next)) { at = prevEnd; mode = 'into'; }
    else if (next?.paragraph) { at = prevEnd; mode = 'before'; }
    else if (a > 0 && old[a - 1].t === 'p') { at = old[a - 1].end - 1; mode = 'after'; restore = old[a - 1]; }
    else return;   // (nothing to write into before a leading table: a later round)
  }
  if (!news.length) return;
  const firstTable = news.findIndex(nb => nb.t === 'table');
  if (firstTable === 0) {
    const t = news[0] as Extract<GBlock, { t: 'table' }>;
    plan.requests.push({ insertTable: { rows: t.cells.length, columns: Math.max(1, ...t.cells.map(r => r.length)), location: { index: at } } });
    return;
  }
  const paras = (firstTable < 0 ? news : news.slice(0, firstTable)) as GPara[];
  insertParagraphs(plan, at, paras, mode === 'after', mode === 'into');
  // the paragraph before keeps its own style (its newline is a new one now)
  if (restore && restore.t === 'p') plan.requests.push(paragraphStyle(restore, { startIndex: restore.start, endIndex: restore.end }));
}

const isEmptyParagraph = (el: { paragraph?: { elements: DocsParagraphElement[] } }) =>
  !!el.paragraph && el.paragraph.elements.map(e => e.textRun?.content ?? (e.footnoteReference ? FOOT : '')).join('') === '\n';

/**
 * Bullets: each run of consecutive list paragraphs of one kind (bulleted / numbered) is one list
 * with the items' nesting levels; one that is not is made again (createParagraphBullets reads a
 * paragraph's level from the tabs in front of it, and takes them out).
 */
function listRequests(read: ReadDoc, raw: DocsDocument, want: GBlock[]): Request[] {
  const out: Request[] = [];
  const blocks = read.blocks;
  // (blocks and want are aligned one to one here: every key matched but for the lists)
  const runs: { from: number; to: number; ordered: boolean }[] = [];
  for (let k = 0; k < want.length;) {
    const w = want[k];
    if (w.t !== 'p' || !w.list) { k++; continue; }
    let e = k + 1;
    while (e < want.length && want[e].t === 'p' && (want[e] as GPara).list?.ordered === w.list.ordered) e++;
    runs.push({ from: k, to: e, ordered: w.list.ordered });
    k = e;
  }
  const listIdOf = (rb: ReadBlock) => (rb.t === 'p' ? listIds(raw).get(rb.start) : undefined);
  for (let r = runs.length - 1; r >= 0; r--) {
    const { from, to, ordered } = runs[r];
    const have = blocks.slice(from, to);
    if (have.length !== to - from || have.some(h => h.t !== 'p')) continue;
    const ids = new Set(have.map(listIdOf));
    const ok = ids.size === 1 && !ids.has(undefined) && have.every((h, k) => h.t === 'p' && h.list && h.list.ordered === ordered && h.list.level === (want[from + k] as GPara).list!.level);
    // the paragraphs around the run must not be in the same list
    if (ok) continue;
    const start = (have[0] as Extract<ReadBlock, { t: 'p' }>).start, end = (have[have.length - 1] as Extract<ReadBlock, { t: 'p' }>).end;
    out.push({ deleteParagraphBullets: { range: { startIndex: start, endIndex: end } } });
    let tabs = 0;
    for (let k = have.length - 1; k >= 0; k--) {
      const level = (want[from + k] as GPara).list!.level;
      if (level > 0) { out.push({ insertText: { location: { index: (have[k] as Extract<ReadBlock, { t: 'p' }>).start }, text: '\t'.repeat(level) } }); tabs += level; }
    }
    out.push({ createParagraphBullets: { range: { startIndex: start, endIndex: end + tabs }, bulletPreset: ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE' } });
  }
  return out;
}

/** paragraph start index → its list id */
function listIds(raw: DocsDocument): Map<number, string> {
  const out = new Map<number, string>();
  for (const s of raw.body.content) if (s.paragraph?.bullet) out.set(s.startIndex ?? 0, s.paragraph.bullet.listId);
  return out;
}

/** Does the Google Doc hold `want` (nothing left to do)? */
export function inSync(raw: DocsDocument, want: GBlock[]): boolean {
  return planRound(raw, want).length === 0;
}
