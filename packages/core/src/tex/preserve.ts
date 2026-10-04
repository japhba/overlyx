/**
 * Saving without reformatting. A .tex file the user brought (an Overleaf or arXiv project, a
 * co-author's paper) is written back as itself wherever the document did not change: the LaTeX of
 * every untouched paragraph, the preamble, the managed block when its content is the same, keep
 * their bytes; only what changed is written by the writer (tex/write.ts). So a save after one
 * typed word changes one paragraph in `git diff`, not the whole file — and a writer bug can only
 * reach the paragraphs somebody edited.
 *
 * How: the base text (what the file holds now) is parsed with the source range of every body
 * paragraph (ParseTexResult.sources) and written by the writer as well. Each paragraph's key is
 * its writer output up to the next paragraph (so it includes the glue after it: an \end{itemize},
 * the \begin of what follows); the base's keys are aligned with the new document's, and every
 * run of paragraphs whose keys are equal keeps its source text. The rest — and the preamble when
 * the writer's preamble changed — comes from the writer's output for the new document.
 *
 * Correctness first: the result is parsed again and must give the document being saved (the
 * same model, or at least the same writer output — which is all a full rewrite would give too).
 * When it does not, the paragraphs around the difference are rewritten as well, and in the end
 * the full writer output is used: never worse than writing the whole file.
 */
import type { LyxDocument } from '../lyx/ast.ts';
import { align } from '../lyx/merge.ts';
import type { ParseTexResult } from './parse.ts';
import type { WriteTexResult } from './write.ts';
import { MANAGED_BEGIN, MANAGED_END, SETTINGS_PREFIX, maskComments } from './preamble.ts';

/** What one document remembers between saves (the base's parse and writer output; the last result). */
export interface PreserveCache {
  base?: { text: string; parsed: ParseTexResult; written?: WriteTexResult };
  last?: { base: string; full: string; result: WriteTexResult };
}

export interface PreserveOptions {
  /** the text the file holds now (null / undefined: none — the writer's output is used) */
  base: string | null | undefined;
  /** parse a text the way the document is loaded (project layouts, the master's header for a child) */
  parse: (text: string) => ParseTexResult;
  /** the full writer, with the document's options */
  write: (doc: LyxDocument) => WriteTexResult;
  cache?: PreserveCache;
  /** filled in for measurements and tests: how the result was made */
  stats?: PreserveStats;
}

export interface PreserveStats {
  /** body paragraphs whose source text was kept */
  kept?: number;
  /** body paragraphs written */
  written?: number;
  /** verification rounds that failed before the result was accepted */
  retries?: number;
  /** 'kept' (all or part preserved), 'full' (writer output), and why a full write was used */
  outcome?: 'kept' | 'full' | 'unchanged';
  reason?: string;
  /** why matched paragraphs were written after all (for measurements) */
  notes?: string[];
}

type Span = { start: number; end: number } | null;

/** Remember a text's parse (as `parse` gives it) as the base of the next save into that text. */
export function primePreserveCache(cache: PreserveCache, text: string, parsed: ParseTexResult): void {
  const T = (text.startsWith('\ufeff') ? text.slice(1) : text).replace(/\r\n/g, '\n');
  if (cache.base?.text !== T) cache.base = { text: T, parsed };
}

/**
 * The document as .tex text, keeping the base text's LaTeX wherever the document did not change.
 * Returns the writer's result (warnings, sidecar files, …) with `text`, `spans` and `bodyRange`
 * describing the text actually produced.
 */
export function writeTexPreserving(doc: LyxDocument, o: PreserveOptions): WriteTexResult {
  const stats = o.stats ?? {};
  const full = o.write(doc);
  if (!o.base) { stats.outcome = 'full'; stats.reason = 'no base'; return full; }
  const cache = o.cache ?? {};
  if (cache.last && cache.last.base === o.base && cache.last.full === full.text) {
    // the same text as last time (the sidecar files, e.g. a sketch's SVG, are this call's)
    stats.outcome = 'unchanged';
    const r = cache.last.result;
    return { ...full, text: r.text, spans: r.spans, bodyRange: r.bodyRange };
  }
  let result: WriteTexResult = full;
  try {
    result = preserve(doc, full, o, cache, stats);
  } catch (e) {
    // a bug here must never cost a save: the writer's output is always a valid answer
    stats.outcome = 'full';
    stats.reason = 'error: ' + String((e as Error)?.message ?? e);
    result = full;
  }
  cache.last = { base: o.base, full: full.text, result };
  return result;
}

function preserve(doc: LyxDocument, full: WriteTexResult, o: PreserveOptions, cache: PreserveCache, stats: PreserveStats): WriteTexResult {
  // the parser's offsets are into the normalised text (no BOM, \n line ends): work there, and give
  // the result the base's line ends back
  const raw = o.base!;
  const bom = raw.startsWith('\ufeff');
  let T = bom ? raw.slice(1) : raw;
  const crlf = T.includes('\r\n') && !/(^|[^\r])\n/.test(T);
  T = T.replace(/\r\n/g, '\n');
  const fullOut = (reason: string): WriteTexResult => { stats.outcome = 'full'; stats.reason = reason; return full; };

  // nothing to keep (a new, empty file): the writer's text, settings line and all
  if (!T.trim()) return fullOut('empty base');
  let base = cache.base && cache.base.text === T ? cache.base : undefined;
  if (!base) { base = { text: T, parsed: o.parse(T) }; cache.base = base; }
  const P0 = base.parsed;
  if (!P0.bodyRange) return fullOut('base body not one slice');
  const fragment = !full.text.slice(full.bodyRange.end).startsWith('\\end{document}');
  if (P0.fragment !== fragment) return fullOut('fragment / document mismatch');
  const Wb = base.written ?? (base.written = o.write(P0.doc));

  const n0 = P0.doc.body.length, n1 = doc.body.length;
  // Each paragraph has its own text — from its first token to where it ends, in the base text (the
  // parser's sources), in the base's writer output and in the new one (the writer's spans). What
  // lies between two paragraphs is glue: blank lines, an \end{itemize}, the next \begin{…}, and the
  // paragraphs the parser made up (no source: a separator between two lists, …).
  const tS = P0.sources.map(x => x?.start), tE = P0.sources.map(x => x?.end);
  const [bS, bE] = bounds(Wb.spans, Wb.bodyRange.end), [nS, nE] = bounds(full.spans, full.bodyRange.end);
  // paragraphs are matched by their own text as the writer writes them
  const ownKey = (w: WriteTexResult, S: Bound, E: Bound, d: LyxDocument, i: number) =>
    S[i] === undefined || E[i] === undefined || S[i] === E[i] ? '\u0000' + canonical(d.body[i]) : w.text.slice(S[i], E[i]);
  const ids = new Map<string, string>();
  const id = (k: string) => { let v = ids.get(k); if (v === undefined) { v = String(ids.size); ids.set(k, v); } return v; };
  const pairs = align(P0.doc.body.map((_, i) => id(ownKey(Wb, bS, bE, P0.doc, i))), doc.body.map((_, j) => id(ownKey(full, nS, nE, doc, j))));
  // match[j + 1]: the base paragraph of unit j; the text before the first paragraph is unit -1 and
  // the end of the body unit n1 (base units -1 and n0), both with nothing of their own
  const match = new Array<number>(n1 + 2).fill(-1);
  match[0] = -1; match[n1 + 1] = n0;
  for (const [i, j] of pairs) match[j + 1] = i;
  const src = (j: number) => match[j + 1];
  const T0 = P0.bodyRange.start, T1 = P0.bodyRange.end;
  const tStartOf = (i: number) => (i < 0 ? T0 : i < n0 ? tS[i] : T1), tEndOf = (i: number) => (i < 0 ? T0 : i < n0 ? tE[i] : T1);
  const bStartOf = (i: number) => (i < 0 ? Wb.bodyRange.start : i < n0 ? bS[i] : Wb.bodyRange.end), bEndOf = (i: number) => (i < 0 ? Wb.bodyRange.start : i < n0 ? bE[i] : Wb.bodyRange.end);
  const nStartOf = (j: number) => (j < 0 ? full.bodyRange.start : j < n1 ? nS[j] : full.bodyRange.end), nEndOf = (j: number) => (j < 0 ? full.bodyRange.start : j < n1 ? nE[j] : full.bodyRange.end);
  /**
   * Between two kept units j < k the base's own glue is kept when the paragraphs between them are
   * the base's made-up ones, in order, and the writer writes the same between them on both sides.
   */
  const baseGlue = (j: number, k: number): boolean => {
    const i = src(j), l = src(k);
    if (l - i !== k - j) return false;
    for (let q = j + 1; q < k; q++) if (src(q) !== i + (q - j) || tS[src(q)] !== undefined) return false;
    const ta = tEndOf(i), tb = tStartOf(l), ba = bEndOf(i), bb = bStartOf(l), na = nEndOf(j), nb = nStartOf(k);
    if (ta === undefined || tb === undefined || ba === undefined || bb === undefined || na === undefined || nb === undefined || ta > tb) return false;
    return Wb.text.slice(ba, bb) === full.text.slice(na, nb);
  };

  /**
   * The base's glue between base paragraphs i and i + 1 (-1: the text before the first one, n0 the
   * end), where the writer writes the same between them as between the new paragraphs j and k.
   */
  const sameGlue = (i: number, j: number, i1: number, k: number): [number, number] | undefined => {
    if (i < -1 || i1 !== i + 1 || i1 > n0) return undefined;
    const ta = tEndOf(i), tb = tStartOf(i1), ba = bEndOf(i), bb = bStartOf(i1), na = nEndOf(j), nb = nStartOf(k);
    if (ta === undefined || tb === undefined || ba === undefined || bb === undefined || na === undefined || nb === undefined || ta > tb) return undefined;
    return Wb.text.slice(ba, bb) === full.text.slice(na, nb) ? [ta, tb] : undefined;
  };

  const parts = splitOuter(T, P0, Wb, full, fragment);

  // `forced` units are written whatever their key (after a verification failure)
  const forced = new Set<number>();
  let preAt = 0;   // which of the preamble candidates (parts.pres) is tried
  let PF: ParseTexResult | undefined;
  let retries = 0;
  for (;;) {
    // the kept units: matched, with a range in the base text; -1 and n1 always
    const kept: number[] = [-1];
    for (let j = 0; j < n1; j++) {
      const i = src(j);
      if (i >= 0 && !forced.has(j) && tS[i] !== undefined && tE[i] !== undefined) kept.push(j);
    }
    kept.push(n1);
    // what lies between two kept units comes from the writer's text unless it is the base's own
    // glue: it needs a range there, or the unit on that side is written too
    // — and the base text a written stretch replaces must have balanced braces: a brace of a kept
    // stretch whose partner was replaced would stray (and a stray brace reads back as nothing, so
    // reading back cannot tell); the replaced stretch grows towards the partner
    for (let changed = true; changed;) {
      changed = false;
      for (let x = 0; x + 1 < kept.length && !changed; x++) {
        const j = kept[x], k = kept[x + 1];
        if (baseGlue(j, k)) continue;
        if (nEndOf(j) === undefined && j >= 0) { kept.splice(x, 1); changed = true; stats.notes?.push(`${j}: no end in the writer's text`); continue; }
        if (nStartOf(k) === undefined && k < n1) { kept.splice(x + 1, 1); changed = true; stats.notes?.push(`${k}: no start in the writer's text`); continue; }
        const d = braceDepth(T, tEndOf(src(j))!, tStartOf(src(k))!);
        if (d.delta === 0 && d.min >= 0) continue;
        // unmatched closing braces: their partners are before (j's side); opening ones: after
        const drop = d.min < 0 ? (j >= 0 ? x : k < n1 ? x + 1 : -1) : (k < n1 ? x + 1 : j >= 0 ? x : -1);
        if (drop >= 0) { stats.notes?.push(`${kept[drop]}: braces`); kept.splice(drop, 1); changed = true; }
      }
    }

    // compose
    let R = '';   // the body (the preamble goes before it below)
    const spans: Span[] = new Array(n1).fill(null);
    const segments: Segment[] = [];
    let keptPars = 0;
    let seg: Segment | null = null;
    const open = (isKept: boolean, j: number) => {
      if (seg && seg.kept === isKept) return seg;
      if (seg) segments.push(seg);
      seg = { kept: isKept, j0: j, j1: j, rFrom: R.length, rTo: R.length, nFrom: 0, nTo: 0 };
      return seg;
    };
    for (let x = 0; x < kept.length; x++) {
      const j = kept[x], i = src(j);
      if (j >= 0 && j < n1) {
        // the kept paragraph's own text
        const sg = open(true, j);
        spans[j] = { start: R.length, end: R.length + tE[i]! - tS[i]! };
        R += T.slice(tS[i], tE[i]);
        keptPars++;
        sg.j1 = j; sg.rTo = R.length;
      }
      if (x + 1 === kept.length) break;
      const k = kept[x + 1];
      if (baseGlue(j, k)) {
        // the base's glue (with the made-up paragraphs in it)
        const sg = open(true, Math.max(j, 0));
        R += T.slice(tEndOf(i), tStartOf(src(k)));
        sg.j1 = Math.max(sg.j1, k - 1); sg.rTo = R.length;
        for (let q = j + 1; q < k; q++) keptPars++;
      } else {
        // the writer's text: the glue after j, the paragraphs between, the glue before k — the
        // glue at either end the base's own where the writer's is the same as for the base
        const from = nEndOf(j)!, to = nStartOf(k)!;
        const sg = open(false, j + 1);
        let head = k > j + 1 ? sameGlue(src(j), j, src(j) + 1, j + 1) : undefined;
        let tail = k > j + 1 ? sameGlue(src(k) - 1, k - 1, src(k), k) : undefined;
        // (the base text replaced must stay balanced with them: else they are the writer's too)
        if (head && !balanced(T, head[1], tail ? tail[0] : tStartOf(src(k))!)) head = undefined;
        if (tail && !balanced(T, head ? head[1] : tEndOf(src(j))!, tail[0])) tail = undefined;
        const mFrom = head ? nStartOf(j + 1)! : from, mTo = tail ? nEndOf(k - 1)! : to;
        if (head) R += T.slice(head[0], head[1]);
        const delta = R.length - mFrom;
        for (let q = j + 1; q < k; q++) { const y = full.spans[q]; spans[q] = y ? { start: y.start + delta, end: y.end + delta } : null; }
        // (blanks at the end of the old paragraph's last line went with it)
        R += tail ? full.text.slice(mFrom, mTo) + T.slice(tail[0], tail[1]).replace(/^[ \t]+/, '') : withBaseBlanks(full.text.slice(mFrom, mTo), T, tStartOf(src(k)), k >= n1);
        sg.nFrom = from; sg.nTo = to; sg.j1 = k - 1; sg.rTo = R.length;
      }
    }
    if (seg) segments.push(seg);
    // a file without a managed block gets one when its body uses what only the block defines (the
    // layout macros, the change-tracking ones, \guillemotleft in OT1, …): it would not compile
    if (!parts.pres[preAt].includes(MANAGED_BEGIN) && usesDefined(R, parts.blockNames)) {
      const k = parts.pres.findIndex((x, i) => i > preAt && x.includes(MANAGED_BEGIN));
      if (k >= 0) preAt = k;
    }
    const pre = parts.pres[preAt];
    for (const sg of segments) { sg.rFrom += pre.length; sg.rTo += pre.length; }
    for (let q = 0; q < n1; q++) { const x = spans[q]; if (x) spans[q] = { start: x.start + pre.length, end: x.end + pre.length }; }
    const bodyRange = { start: pre.length, end: pre.length + R.length };
    R = pre + R + parts.post;

    if (R === full.text) return fullOut(retries ? 'verification' : 'nothing kept');
    // verify: the text must read back as the document being saved — or, where the writer itself
    // does not reproduce a paragraph it wrote (its own output reads back differently), as what a
    // full rewrite reads back as: never worse than writing the whole file
    const PR = R === T ? P0 : o.parse(R);
    const exact = sameDocument(PR.doc, doc);
    const bad = (exact ? null : verify(PR, doc, segments, () => (PF ??= o.parse(full.text)))) ?? regenerated(R, bodyRange, T, P0.bodyRange, full, segments);
    // reading back the same is not enough: the parser tolerates a stray \end{center}, TeX does not
    // (a kept closing line next to a rewritten one once doubled it). The environments and braces
    // must balance as in the user's file or as in the full rewrite, else the full rewrite is written.
    if (!bad) { const b = texBalance(R); if (b !== texBalance(full.text) && b !== texBalance(T)) return fullOut('environment balance'); }
    if (!bad) {
      // the next save's base: this text, its parse, and — reading back as exactly this document —
      // the writer's output for it, which is the one just made
      cache.base = { text: R, parsed: PR, written: R === T ? Wb : exact ? full : undefined };
      stats.outcome = 'kept'; stats.kept = keptPars; stats.written = n1 - keptPars; stats.retries = retries;
      const text = (bom ? '\ufeff' : '') + (crlf ? R.replace(/\n/g, '\r\n') : R);
      if (!bom && !crlf) return { ...full, text, spans, bodyRange };
      const nl = crlf ? newlines(R) : [];
      const at = (off: number) => off + (bom ? 1 : 0) + countBelow(nl, off);
      return { ...full, text, spans: spans.map(s => s && { start: at(s.start), end: at(s.end) }), bodyRange: { start: at(bodyRange.start), end: at(bodyRange.end) } };
    }
    stats.notes?.push(`verification failed: ${bad.outer ? 'preamble, ' : ''}${bad.segments.map(g => `${g.kept ? 'kept' : 'written'} ${g.j0}..${g.j1}`).join(', ')}`);
    if (++retries > 3) return fullOut('verification');
    // rewrite more around what did not read back right
    if (bad.outer) preAt = Math.min(preAt + 1, parts.pres.length - 1);
    const pad = 4 ** (retries - 1);
    for (const seg of bad.segments) {
      for (let j = Math.max(-1, seg.j0 - pad); j <= Math.min(n1 - 1, seg.j1 + pad); j++) forced.add(j);
    }
  }
}

/** A stretch of the result: kept from the base text, or the writer's text for the new document. */
interface Segment {
  kept: boolean;
  /** the new document's paragraphs it holds (-1: the text before the first paragraph) */
  j0: number;
  j1: number;
  /** its range in the result */
  rFrom: number;
  rTo: number;
  /** a written one: its range in the writer's output */
  nFrom: number;
  nTo: number;
}

/**
 * The segments of the result that do not read back right: a kept one must give its paragraphs of
 * `want` exactly, a written one those or what the full rewrite gives for the same text (`fallback`,
 * parsed only when needed). Null when everything reads back right.
 */
function verify(got: ParseTexResult, want: LyxDocument, segments: Segment[], fallback: () => ParseTexResult): { outer: boolean; segments: Segment[] } | null {
  const alt = fallback();
  const outer = !sameOuter(got.doc, want) && !sameOuter(got.doc, alt.doc);
  const mine = bySegment(got, segments, s => [s.rFrom, s.rTo]);
  const theirs = bySegment(alt, segments, s => (s.kept ? [0, 0] : [s.nFrom, s.nTo]));
  const failed = segments.filter((s, k) => {
    const w = want.body.slice(Math.max(s.j0, 0), s.j1 + 1).map(canonical);
    const g = mine[k].map(canonical);
    if (same(g, w)) return false;
    return s.kept || !same(g, theirs[k].map(canonical));
  });
  return failed.length || outer ? { outer, segments: failed } : null;
}

/**
 * Commands the parser reads without a trace in the document because the writer generates them
 * itself (\maketitle after the title block): reading back cannot tell one lost or doubled where a
 * kept and a written segment meet, so the result must have as many as the base or the writer's text.
 */
const REGENERATED = /\\maketitle(?![a-zA-Z])/g;

function regenerated(R: string, body: { start: number; end: number }, T: string, tBody: { start: number; end: number }, full: WriteTexResult, segments: Segment[]): { outer: boolean; segments: Segment[] } | null {
  const count = (s: string) => (maskComments(s).match(REGENERATED) ?? []).length;
  const mine = count(R.slice(body.start, body.end));
  if (mine === count(T.slice(tBody.start, tBody.end)) || mine === count(full.text.slice(full.bodyRange.start, full.bodyRange.end))) return null;
  // rewrite where they are, and next to what was written
  const masked = maskComments(R);
  const at = [...masked.matchAll(REGENERATED)].map(m => m.index!);
  return { outer: false, segments: segments.filter(s => !s.kept || at.some(a => a >= s.rFrom && a < s.rTo)) };
}

/** A parse's body paragraphs grouped by the segment their source lies in (one without a source goes with the one before). */
function bySegment(p: ParseTexResult, segments: Segment[], range: (s: Segment) => [number, number]): LyxDocument['body'][] {
  const out: LyxDocument['body'][] = segments.map(() => []);
  let k = -1;
  p.doc.body.forEach((par, q) => {
    const s = p.sources[q];
    if (s) {
      const hit = segments.findIndex(seg => { const [a, b] = range(seg); return s.start >= a && s.start < b; });
      k = hit;
    }
    if (k >= 0) out[k].push(par);
  });
  return out;
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The blanks a written stretch ends with, as the base text `T` has them before what follows (its
 * next kept paragraph at `next`, \end{document}): a paragraph break stays a paragraph break.
 */
function withBaseBlanks(text: string, T: string, next: number | undefined, atEnd: boolean): string {
  if (next === undefined) return text;
  // from the line end on (a blank at the end of a paragraph's line is the writer's business)
  const mine = /(\n\s*)?$/.exec(text)![0], theirs = /(\n\s*)?$/.exec(T.slice(0, next))![0];
  if (!mine || !theirs) return text;
  const isBreak = (w: string) => /\n[ \t]*\n/.test(w);
  if (mine === theirs || (!atEnd && isBreak(mine) !== isBreak(theirs))) return text;
  return text.slice(0, text.length - mine.length) + theirs;
}

type Bound = (number | undefined)[];

/**
 * The writer's paragraph spans as starts and ends, keeping only starts that increase through the
 * text; a paragraph that wrote nothing (a definition the writer moves elsewhere, a deleted one) is
 * empty, at the place where the next one starts.
 */
function bounds(spans: Span[], end: number): [Bound, Bound] {
  let last = -1;
  const S: Bound = [], E: Bound = [];
  for (const x of spans) {
    if (!x || x.start <= last) { S.push(undefined); E.push(undefined); continue; }
    last = x.start;
    S.push(x.start); E.push(x.end);
  }
  let next = end;
  for (let i = spans.length - 1; i >= 0; i--) {
    if (S[i] !== undefined) next = S[i]!;
    else if (!spans[i]) S[i] = E[i] = next;
  }
  return [S, E];
}

interface Outer {
  /**
   * The text before the body (up to \begin{document}, a fragment's settings line), best first:
   * the base's own with the writer's changes merged in (with the managed block left out when it
   * holds nothing but the settings line, and with it), last the writer's own.
   */
  pres: string[];
  /** \end{document} and what follows */
  post: string;
  /** commands and environments the writer's managed block defines (LyX's and OverLyX's own) */
  blockNames: Set<string>;
}

/** The names a managed block defines; \tabularnewline is LaTeX's own (LyX provides it for old versions). */
function definedIn(block: string): Set<string> {
  const out = new Set<string>();
  const re = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|ProvideTextCommandDefault|DeclareTextSymbolDefault|DeclareTextCommandDefault|newenvironment|renewenvironment|def)\*?\s*\{?\\?([A-Za-z@]+)\}?/g;
  for (const m of maskComments(block).matchAll(re)) if (m[1] !== 'tabularnewline') out.add(m[1]);
  return out;
}

/** Does `body` use one of `names` (as a command, or as an environment)? */
function usesDefined(body: string, names: Set<string>): boolean {
  if (!names.size) return false;
  const masked = maskComments(body);
  for (const m of masked.matchAll(/\\(?:begin\{([A-Za-z@*]+)\}|([A-Za-z@]+))/g)) if (names.has(m[1] ?? m[2])) return true;
  return false;
}

/** The preamble and trailer of the result: the base's own, with the writer's changes merged in. */
function splitOuter(T: string, P0: ParseTexResult, Wb: WriteTexResult, Wn: WriteTexResult, fragment: boolean): Outer {
  const preT = T.slice(0, P0.bodyRange!.start), preB = Wb.text.slice(0, Wb.bodyRange.start), preN = Wn.text.slice(0, Wn.bodyRange.start);
  const postT = T.slice(P0.bodyRange!.end), postB = Wb.text.slice(Wb.bodyRange.end), postN = Wn.text.slice(Wn.bodyRange.end);
  const post = postB === postN ? postT : postN;
  const t = managedParts(preT), b = managedParts(preB), n = managedParts(preN);
  const blockNames = fragment ? new Set<string>() : definedIn(n.block);
  const out = (...pres: string[]): Outer => ({ pres: [...pres, preN], post, blockNames });
  if (fragment) return preB === preN ? out(preT) : out();
  if (!b.block || !n.block || b.after !== n.after) return preB === preN ? out(preT) : out();
  const before = b.before === n.before ? t.before : merge3(t.before, b.before, n.before);
  if (before === null) return out();
  // the new block in place of the base's — or, when there is none, on the lines right before
  // \begin{document} (taking it out again gives the file back)
  const withBlock = before + (before === '' || before.endsWith('\n') ? '' : '\n') + n.block + t.after;
  // the file's managed block is OverLyX's own: it is what the writer makes of the document now
  // (also after an update of OverLyX's macros); a file without one gets one when the content comes
  // to need it — or uses what it defines (see preserve)
  const blockSame = t.block ? t.block === n.block : b.block === n.block;
  if (blockSame) return t.block ? out(before + t.block + t.after) : out(before + t.after, withBlock);
  if (!trivialBlock(n.block)) return out(withBlock);
  // nothing in it but the settings line: the file may well do without (when reading it back
  // without one gives the same settings); two blank lines around a removed block become one
  const without = before + (before.endsWith('\n\n') && t.after.startsWith('\n') ? t.after.slice(1) : t.after);
  return out(without, withBlock);
}

/** A managed block with no packages or macros in it: the markers, the settings line, the comment. */
function trivialBlock(block: string): boolean {
  return block.split('\n').every(l => !l.trim() || l.startsWith(MANAGED_BEGIN) || l.startsWith(MANAGED_END) || l.startsWith(SETTINGS_PREFIX) || l.startsWith('%% Packages and macros needed by the content'));
}

/** A preamble split around its managed block (`block` ends with the newline after the end marker; '' when there is none). */
function managedParts(pre: string): { before: string; block: string; after: string } {
  const b = pre.indexOf(MANAGED_BEGIN);
  const e = b >= 0 ? pre.indexOf(MANAGED_END, b) : -1;
  if (b >= 0 && e >= 0 && (b === 0 || pre[b - 1] === '\n')) {
    let end = e + MANAGED_END.length;
    if (pre[end] === '\n') end++;
    return { before: pre.slice(0, b), block: pre.slice(b, end), after: pre.slice(end) };
  }
  // no block: everything before the line of \begin{document} (the text ends with it)
  const d = pre.endsWith('\\begin{document}') ? pre.length - '\\begin{document}'.length : pre.length;
  const lineStart = pre.lastIndexOf('\n', d - 1) + 1;
  const at = pre.slice(lineStart, d).trim() === '' ? lineStart : d;
  return { before: pre.slice(0, at), block: '', after: pre.slice(at) };
}

/**
 * Three-way merge of lines: the change from `b` to `n` applied to `t`, when every changed run of
 * `b` lies in `t` unchanged between the same neighbours; null otherwise.
 */
export function merge3(t: string, b: string, n: string): string | null {
  const T = t.split('\n'), B = b.split('\n'), N = n.split('\n');
  const bn = align(B, N), bt = align(B, T);
  const inT = new Array<number>(B.length).fill(-1);
  for (const [i, j] of bt) inT[i] = j;
  // hunks of b → n: base [b0, b1) replaced by new [n0, n1)
  const hunks: { b0: number; b1: number; n0: number; n1: number }[] = [];
  let bi = 0, ni = 0;
  for (const [i, j] of [...bn, [B.length, N.length] as [number, number]]) {
    if (i > bi || j > ni) hunks.push({ b0: bi, b1: i, n0: ni, n1: j });
    bi = i + 1; ni = j + 1;
  }
  const out: string[] = [];
  let tPos = 0;
  for (const h of hunks) {
    // where the hunk sits in t: right after the line before it, and its base lines unchanged there
    const before = h.b0 > 0 ? inT[h.b0 - 1] : -1;
    if (h.b0 > 0 && before < 0) return null;
    const start = before + 1;
    for (let k = h.b0; k < h.b1; k++) if (inT[k] !== start + (k - h.b0)) return null;
    const end = start + (h.b1 - h.b0);
    if (h.b1 < B.length && inT[h.b1] !== end) return null;
    if (start < tPos) return null;
    out.push(...T.slice(tPos, start), ...N.slice(h.n0, h.n1));
    tPos = end;
  }
  out.push(...T.slice(tPos));
  return out.join('\n');
}

/**
 * Are the braces of `s` between `from` and `to` balanced (comments and \{ \} left out)? Only such
 * stretches of the base are put next to the writer's text: a stray brace reads back as nothing,
 * so reading back would not tell that it moved.
 */
function balanced(s: string, from: number, to: number): boolean {
  const d = braceDepth(s, from, to);
  return d.delta === 0 && d.min >= 0;
}

/** The brace depth at the end of `s` between `from` and `to` and the lowest it gets, starting at 0. */
function braceDepth(s: string, from: number, to: number): { delta: number; min: number } {
  let depth = 0, min = 0;
  for (let i = from; i < to; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '%') { while (i < to && s[i] !== '\n') i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth < min) min = depth;
  }
  return { delta: depth, min };
}

/** Where `s` has its newlines. */
function newlines(s: string): number[] {
  const out: number[] = [];
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) out.push(i);
  return out;
}

/** How many of the sorted `xs` are below `v`. */
function countBelow(xs: number[], v: number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/* ------------------------------------------------------------ comparing documents */

/**
 * JSON with sorted keys, leaving out undefined and empty objects (`font: {}` and no font are the
 * same) — and a sketch's strokes, which are not in the text but in its SVG (written with it).
 */
export function canonical(v: unknown): string {
  return JSON.stringify(normalize(v));
}

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    const sketch = (v as { type?: unknown }).type === 'Leaf' && (v as { name?: unknown }).name === 'Sketch';
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined || (sketch && k === 'params')) continue;
      if (x && typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length) continue;
      out[k] = normalize(x);
    }
    return out;
  }
  return v;
}

function sameOuter(a: LyxDocument, b: LyxDocument): boolean {
  return canonical(a.header.lines) === canonical(b.header.lines) && canonical(a.preamble) === canonical(b.preamble) && canonical(a.trailer) === canonical(b.trailer);
}

function sameDocument(a: LyxDocument, b: LyxDocument): boolean {
  if (a.body.length !== b.body.length || !sameOuter(a, b)) return false;
  for (let i = 0; i < a.body.length; i++) if (canonical(a.body[i]) !== canonical(b.body[i])) return false;
  return true;
}

/**
 * How the text's environments and braces balance, as a comparable key: per environment name the
 * number of `\begin` minus `\end`, and the brace depth at the end — comments (`%` to the end of
 * the line) and escaped braces left out.
 */
export function texBalance(text: string): string {
  const env = new Map<string, number>();
  let braces = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|[^\\])%.*$/, '$1');
    for (const m of line.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) env.set(m[2], (env.get(m[2]) ?? 0) + (m[1] === 'begin' ? 1 : -1));
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\') { i++; continue; }
      if (c === '{') braces++; else if (c === '}') braces--;
    }
  }
  return JSON.stringify([[...env].filter(([, n]) => n !== 0).sort(), braces]);
}

