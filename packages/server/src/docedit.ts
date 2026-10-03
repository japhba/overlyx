/**
 * Agent edits of a document's LaTeX source, applied as tracked changes (or, as the fallback,
 * directly: applyPlainSource).
 *
 * An agent edits text: it replaces a passage of the source (edit_document), writes the whole
 * source (write_document), or patches its private copy of the file (the agent panel). Whatever
 * the route, the edited source is parsed and diffed against the live document (trackDiff in
 * @overlyx/core), so only what actually changed is marked — a word, a digit, a table cell — and
 * attributed to the agent; everybody else's concurrent edits elsewhere in the document survive.
 *
 * replaceInSource is the text-replacement step, tolerant the way agents need it to be: the
 * passage may be quoted with or without the tracked-change markup (\lyxadded / \lyxdeleted
 * wrappers) the source contains, and with different whitespace.
 */
import {
  mergeLyx, mergeInPlace, trackDiff, changeStats, addAuthor, lyxAuthorId, setHeaderValue, writeParagraphs, collectMacros, getPreamble,
  type LyxDocument, type Paragraph, type RegionMerge, type Item,
} from '@overlyx/core';
import type { OpenDoc } from './docs.ts';

/* ------------------------------------------------------------------ applying an edited source */

export interface TrackedResult {
  /** characters (and paragraph breaks) marked inserted / deleted by this edit */
  inserted: number;
  deleted: number;
  /** the document changed (also when nothing needed a mark: the preamble, one's own pending insertion taken back) */
  changed: boolean;
  /** parts of the edit applied without tracked-change marks, in words for the agent */
  direct: string[];
  /** the edited passage as the document now reads (a few lines around the change), or '' */
  excerpt: string;
  /** the live document's source right before and right after the edit */
  before: string;
  after: string;
}

/**
 * `before` is the source the agent edited (what it read), `after` its version. Regions it changed
 * are diffed against the live document and applied as tracked changes by `author`. The preamble is
 * never change-tracked (mergeLyx takes it over as it is): that part is applied directly, and said so.
 */
export function applyTrackedSource(doc: OpenDoc, before: string, after: string, author: string): TrackedResult {
  const base = doc.parse(before), theirs = doc.parse(after);
  const ours = doc.toLyxDocument();
  // the live document with the agent's changed paragraphs taken over (untracked; a neighbouring
  // paragraph somebody changed meanwhile keeps their version) …
  const target: LyxDocument = mergeLyx(base, ours, theirs, mergeInPlace);
  const direct: string[] = [];
  if (getPreamble(target) !== getPreamble(ours)) direct.push('the preamble (it is never change-tracked)');
  retireMacros(doc, ours, target);
  // … and then the difference to the live document as the agent's tracked changes
  const authorId = lyxAuthorId(author, '');
  addAuthor(target.header, authorId, author, '');
  setHeaderValue(target.header, 'tracking_changes', 'true');
  const as = { author: authorId, time: Math.floor(Date.now() / 1000) };
  target.body = trackDiff(ours.body, target.body, as);
  direct.push(...dropUncompilableDeletions(doc, target, authorId));
  const oldText = doc.toText();
  doc.loadFromLyx(target, 'mcp');
  doc.dirty = true;
  void doc.saveToFile();
  const st = changeStats(target.body, as);
  const newText = doc.toText();
  direct.push(...stillUsedRetired(doc, target));
  return { ...st, changed: newText !== oldText, direct, excerpt: excerptOfChange(oldText, newText), before: oldText, after: newText };
}

/* ------------------------------------------------------------------ macros an edit stops defining */

const definedMacros = (d: LyxDocument): Set<string> => new Set(collectMacros(d).map(m => m.name));
const usesAny = (latex: string, names: Set<string>): string[] => [...new Set([...latex.matchAll(/\\([A-Za-z@]+)/g)].map(m => m[1]))].filter(n => names.has(n));

/** Every formula of a body (inside insets and table cells too), with the item that holds it. */
function eachFormula(pars: Paragraph[], fn: (it: Item, latex: string, items: Item[]) => void): void {
  for (const p of pars) {
    for (const it of [...p.items]) {
      if (it.kind !== 'inset') continue;
      const ins = it.inset;
      if (ins.type === 'Formula') fn(it, ins.latex, p.items);
      else if (ins.type === 'Text') eachFormula(ins.paragraphs, fn);
      else if (ins.type === 'Tabular') for (const r of ins.rows) for (const c of r.cells) eachFormula(c.paragraphs, fn);
    }
  }
}

/**
 * Commands the document defined itself (preamble, macro insets) and an edit — this one or an earlier
 * one — stopped defining: renamed (\newcommand{\R} → \newcommand{\Real}) or removed. Remembered on the
 * open document, since the uses are typically changed by later edits.
 */
function retireMacros(doc: OpenDoc, from: LyxDocument, to: LyxDocument): void {
  const was = definedMacros(from), now = definedMacros(to);
  for (const n of was) if (!now.has(n)) doc.retiredMacros.add(n);
  for (const n of now) doc.retiredMacros.delete(n);
}

/**
 * A struck-out formula is still typeset (\lyxdeleted), so one that uses a command the document no
 * longer defines breaks the build — a tracked macro rename never compiled. Such deletions of the
 * agent's own are applied directly (the formula goes); somebody else's are left and named.
 */
function dropUncompilableDeletions(doc: OpenDoc, target: LyxDocument, authorId: number): string[] {
  if (!doc.retiredMacros.size) return [];
  let dropped = 0;
  const names = new Set<string>(), others = new Set<string>();
  let othersCount = 0;
  eachFormula(target.body, (it, latex, items) => {
    if (it.change?.type !== 'deleted') return;
    const used = usesAny(latex, doc.retiredMacros);
    if (!used.length) return;
    if (it.change.author === authorId) { items.splice(items.indexOf(it), 1); dropped++; used.forEach(n => names.add(n)); }
    else { othersCount++; used.forEach(n => others.add(n)); }
  });
  const list = (s: Set<string>) => [...s].map(n => '\\' + n).join(', ');
  const out: string[] = [];
  if (dropped) out.push(`${dropped} old formula${dropped > 1 ? 's' : ''} removed instead of struck out: ${dropped > 1 ? 'they use' : 'it uses'} ${list(names)}, which the document no longer defines (a struck-out formula is still typeset, so it would break the build)`);
  if (othersCount) out.push(`note: ${othersCount} formula${othersCount > 1 ? 's' : ''} struck out by somebody else still use${othersCount > 1 ? '' : 's'} ${list(others)}, which the document no longer defines — the build fails until those changes are accepted or rejected`);
  return out;
}

/** Retired commands the document still uses in formulas that are not struck out: the agent has to update them. */
function stillUsedRetired(doc: OpenDoc, target: LyxDocument): string[] {
  if (!doc.retiredMacros.size) return [];
  const counts = new Map<string, number>();
  eachFormula(target.body, (it, latex) => { if (it.change?.type !== 'deleted') for (const n of usesAny(latex, doc.retiredMacros)) counts.set(n, (counts.get(n) ?? 0) + 1); });
  return [...counts].map(([n, c]) => `note: \\${n} is no longer defined, but ${c} formula${c > 1 ? 's' : ''} still use${c > 1 ? '' : 's'} it — update ${c > 1 ? 'them' : 'it'} (tracked edits are fine: the old formulas are removed, not struck out)`);
}

/**
 * The same edit applied directly, without tracked-change marks — the fallback when tracked editing
 * gets in the way (an edit that will not match around markup, a construct the tracked diff mangles,
 * a build the markup breaks). Merged like the tracked form, so concurrent edits elsewhere survive;
 * other people's tracked changes stay as they are.
 */
export function applyPlainSource(doc: OpenDoc, before: string, after: string): { changed: boolean; excerpt: string; before: string; after: string } {
  const ours = doc.toLyxDocument();
  const target: LyxDocument = mergeLyx(doc.parse(before), ours, doc.parse(after), mergeInPlace);
  retireMacros(doc, ours, target);
  const oldText = doc.toText();
  doc.loadFromLyx(target, 'mcp');   // clients apply it like an agent edit
  doc.dirty = true;
  void doc.saveToFile();
  const newText = doc.toText();
  return { changed: newText !== oldText, excerpt: excerptOfChange(oldText, newText), before: oldText, after: newText };
}

/* ------------------------------------------------------------------ taking an edit back */

/**
 * `shadow` — another version of the document, e.g. as it was before an agent's changes — with
 * the edits that turned `base` into `live` carried over: what people changed meanwhile (typing,
 * accepting or rejecting a change) survives. Where `shadow` and those edits touch the same
 * paragraph, the live paragraph wins; `conflicts` counts those paragraphs.
 */
export function foldEdits(doc: OpenDoc, shadow: string, base: string, live: string): { text: string; conflicts: number } {
  if (live === base) return { text: shadow, conflicts: 0 };
  if (shadow === base) return { text: live, conflicts: 0 };
  let conflicts = 0;
  const w = (ps: Paragraph[]) => ps.map(p => writeParagraphs([p]));
  const combine: RegionMerge = (b, o, t) => {
    const kb = w(b), ko = w(o), kt = w(t);
    if (kb.length === ko.length && kb.length === kt.length) conflicts += kb.filter((x, k) => ko[k] !== x && kt[k] !== x && kt[k] !== ko[k]).length;
    else if (ko.join('\n') !== kb.join('\n') && ko.join('\n') !== kt.join('\n')) conflicts += Math.max(1, ko.filter((x, k) => x !== kb[k]).length);
    return mergeInPlace(b, o, t);
  };
  return { text: doc.textOf(mergeLyx(doc.parse(base), doc.parse(shadow), doc.parse(live), combine)), conflicts };
}

/** Put `text` in place of the live document (not as a tracked change: it restores an earlier state, marks and all). */
export function restoreSource(doc: OpenDoc, text: string): string {
  doc.loadFromLyx(doc.parse(text), 'mcp');   // clients apply it like an agent edit: Ctrl+Z takes it back
  doc.dirty = true;
  void doc.saveToFile();
  return doc.toText();
}

/** The lines of `next` that differ from `prev` (after the preamble — or in the preamble above the OverLyX block when only that changed), with two lines of context. */
export function excerptOfChange(prev: string, next: string, maxLines = 60): string {
  const bodyOf = (t: string) => { const i = t.indexOf('\\begin{document}'); return i >= 0 ? t.slice(i) : t; };
  const body = changedLines(bodyOf(prev), bodyOf(next), maxLines);
  if (body) return body;
  const userPreamble = (t: string) => { const i = t.indexOf('\\begin{document}'), m = t.indexOf('%% OverLyX ---'); return t.slice(0, m >= 0 && (i < 0 || m < i) ? m : i >= 0 ? i : 0); };
  return changedLines(userPreamble(prev), userPreamble(next), maxLines);
}

function changedLines(prev: string, next: string, maxLines: number): string {
  const a = prev.split('\n'), b = next.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (p === b.length && p === a.length) return '';
  const from = Math.max(0, p - 2), to = Math.min(b.length, b.length - s + 2);
  const lines = b.slice(from, to);
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`].join('\n') : lines.join('\n');
}

/* ------------------------------------------------------------------ text replacement */

/** A \lyxadded / \lyxdeleted wrapper in the source: [start, end), content [contentStart, contentEnd). */
interface Wrapper { start: number; contentStart: number; contentEnd: number; end: number; deleted: boolean }

/** index just past the group starting at `open` (a '{'), or -1 */
function groupEnd(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

export function changeWrappers(src: string): Wrapper[] {
  const out: Wrapper[] = [];
  const re = /\\lyx(added|deleted)(?:\[[^\]]*\])?\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const a = groupEnd(src, m.index + m[0].length - 1);
    if (a < 0 || src[a] !== '{') continue;
    const t = groupEnd(src, a);
    if (t < 0) continue;
    let c = t;
    while (c < src.length && /\s/.test(src[c]) && src[c] !== '\n') c++;
    if (src[c] !== '{') continue;
    const e = groupEnd(src, c);
    if (e < 0) continue;
    out.push({ start: m.index, contentStart: c + 1, contentEnd: e - 1, end: e, deleted: m[1] === 'deleted' });
    re.lastIndex = e;
  }
  return out;
}

interface View { text: string; start: number[]; end: number[] }

/**
 * The source as an agent may have quoted it: without the change wrappers (deleted text left out,
 * or kept), optionally with every whitespace run collapsed to one space. Each view character
 * knows the source range it came from.
 */
function makeView(src: string, wrappers: Wrapper[], keepDeleted: boolean, collapse: boolean): View {
  const chars: string[] = [], start: number[] = [], end: number[] = [];
  let w = 0, inSpace = false;
  for (let i = 0; i < src.length; i++) {
    while (w < wrappers.length && wrappers[w].end <= i) w++;
    const W = wrappers[w];
    if (W && i >= W.start) {
      if (i < W.contentStart || i >= W.contentEnd) continue;         // the macro, its arguments, its closing brace
      if (W.deleted && !keepDeleted) continue;
    }
    const ch = src[i];
    if (collapse && /\s/.test(ch)) {
      if (inSpace) { end[end.length - 1] = i + 1; continue; }   // one space for the whole run
      inSpace = true;
      chars.push(' '); start.push(i); end.push(i + 1);
      continue;
    }
    inSpace = false;
    chars.push(ch); start.push(i); end.push(i + 1);
  }
  return { text: chars.join(''), start, end };
}

const collapseWs = (s: string) => s.replace(/\s+/g, ' ');

function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

function braceBalance(s: string): number {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') d++; else if (s[i] === '}') d--;
  }
  return d;
}

export class EditError extends Error {}

/**
 * `src` with `oldText` replaced by `newText` — exactly once unless `all`. Tries the source as is,
 * then without tracked-change markup (deleted text omitted, then kept), then whitespace-insensitive.
 * A match that cuts into a change wrapper splits it, so the part outside the match keeps its mark.
 */
export function replaceInSource(src: string, oldText: string, newText: string, all = false): string {
  if (!oldText) throw new EditError('old_text is empty — to add text, include a unique neighbouring passage in old_text and repeat it in new_text.');
  if (oldText === newText) throw new EditError('old_text and new_text are identical — nothing to change.');
  if (braceBalance(oldText) === 0 && braceBalance(newText) !== 0) throw new EditError(`new_text has unbalanced braces (${braceBalance(newText) > 0 ? 'a { is not closed' : 'a } has no {'}) while old_text is balanced — the edit would break the LaTeX.`);
  const exact = occurrences(src, oldText);
  if (exact.length === 1 || (all && exact.length)) {
    let out = src;
    for (const at of exact.reverse()) out = out.slice(0, at) + newText + out.slice(at + oldText.length);
    return out;
  }
  if (exact.length > 1) throw new EditError(`old_text occurs ${exact.length} times in the document — include more of the surrounding text to make it unique (or set replace_all).`);
  const wrappers = changeWrappers(src);
  for (const [keepDeleted, collapse] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    if (!collapse && !wrappers.length) continue;
    const view = makeView(src, wrappers, keepDeleted, collapse);
    const needle = collapse ? collapseWs(oldText) : oldText;
    const hits = occurrences(view.text, needle);
    if (!hits.length) continue;
    if (hits.length > 1 && !all) throw new EditError(`old_text occurs ${hits.length} times in the document — include more of the surrounding text to make it unique (or set replace_all).`);
    let out = src, lastStart = Infinity;
    for (const vs of hits.reverse()) {
      let rs = view.start[vs], re = view.end[vs + needle.length - 1];
      let prefix = '', suffix = '';
      for (const W of wrappers) {
        // a match starting / ending inside a wrapper's content: the part outside keeps its wrapper
        if (W.start < rs && rs < W.end) { prefix = rs > W.contentStart ? src.slice(W.start, rs) + '}' : ''; rs = W.start; }
        if (W.start < re && re < W.end) { suffix = re < W.contentEnd ? src.slice(W.start, W.contentStart) + src.slice(re, W.end) : ''; re = W.end; }
      }
      if (re > lastStart) throw new EditError('Two matches of old_text overlap in one tracked change — replace them one at a time.');
      out = out.slice(0, rs) + prefix + newText + suffix + out.slice(re);
      lastStart = rs;
    }
    return out;
  }
  throw new EditError(notFoundHint(src, oldText));
}

/** Where the quoted passage stops matching: the longest prefix of old_text found, and how the source continues there. */
function notFoundHint(src: string, oldText: string): string {
  const view = makeView(src, changeWrappers(src), false, true);
  const needle = collapseWs(oldText);
  let lo = 0, hi = needle.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (view.text.includes(needle.slice(0, mid))) lo = mid; else hi = mid - 1; }
  const base = 'old_text was not found in the document. It must be copied from the source as read_document returns it (tracked-change markup may be left out; whitespace differences are tolerated). Re-read the document before retrying.';
  if (lo < 15) return base;
  const at = view.text.indexOf(needle.slice(0, lo));
  const line = src.slice(0, view.start[at]).split('\n').length;
  return `${base} The first ${lo} characters match (line ${line}), then the source reads «${view.text.slice(at + lo, at + lo + 80)}» where old_text has «${needle.slice(lo, lo + 80)}».`;
}
