/**
 * Finding text in a project's files (the files panel's Search: projectsearch.ts) — VS Code's "Find in
 * Files": a plain query, or with match case / whole word / a regular expression. Pure apart from
 * reading the files it is handed, so that it runs in a worker thread (searchworker.ts): a regular
 * expression that backtracks without end stops that worker, never the server.
 *
 * What is searched is the file's text as the file has it — a .tex document's LaTeX, a .bib's
 * entries — except web pages (decks, posters, pages, articles): their tags, scripts and styles are
 * left out (blanked, so lines and columns stay those of the file), and a match on a deck or poster
 * says which slide it is on.
 */
import fs from 'node:fs';
import { outerRange, parseSource } from '@overlyx/core/html/source.ts';
import { slideElements } from '@overlyx/core/html/deliverable.ts';

export interface SearchQuery { q: string; matchCase?: boolean; wholeWord?: boolean; regex?: boolean }
export interface SearchMatch {
  /** 1-based line, 0-based column of the match's start (UTF-16 units, as the editors count) */
  line: number; col: number; len: number;
  /** the match in its line: `preview.slice(from, to)` is the match (whitespace runs collapsed, long lines cut with …) */
  preview: string; from: number; to: number;
  /** a deck's or poster's page the match is on (1-based) */
  slide?: number;
}
export interface SearchFileResult { path: string; count: number; matches: SearchMatch[] }
export interface SearchResult {
  files: SearchFileResult[];
  /** matches counted (all of them, also beyond what is shown) */
  total: number;
  /** stopped early: too many matches or files, too much text, or out of time */
  truncated: boolean;
  /** files read, and files left out (too large, binary) */
  searched: number; skipped: number;
}
/** a file to search: `abs` is checked to lie inside its project before it gets here */
export interface SearchTarget { path: string; abs: string; size: number; html: boolean }

export const SEARCH_LIMITS = {
  queryMax: 300,
  /** larger files are skipped (a .bib of 5 MB is not) */
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 96 * 1024 * 1024,
  /** matches listed per file (counted further, up to countPerFile) */
  perFile: 100,
  countPerFile: 10000,
  /** matches listed in all */
  shown: 2000,
  /** files with matches listed */
  files: 500,
  /** stop between files after this long */
  softMs: 3000,
  /** a search still running then is stopped, its worker with it (a pattern that never finishes: projectsearch.ts) */
  hardMs: 8000,
};
export type SearchLimits = typeof SEARCH_LIMITS;

/** a query the user must change (bad pattern, nothing to search for): its message is shown as it is */
export class SearchError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** what counts as a word character for "whole word" (letters of the Latin, Greek and Cyrillic scripts, digits, _) */
const WORD = 'A-Za-z0-9_\\u00C0-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF';

export function compileQuery(o: SearchQuery): RegExp {
  const q = String(o.q ?? '');
  if (!q) throw new SearchError('Type what to search for');
  if (q.length > SEARCH_LIMITS.queryMax) throw new SearchError(`The search is too long (at most ${SEARCH_LIMITS.queryMax} characters)`);
  let src = o.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) src = `(?<![${WORD}])(?:${src})(?![${WORD}])`;
  try {
    return new RegExp(src, 'gm' + (o.matchCase ? '' : 'i'));
  } catch (e) {
    throw new SearchError('Not a valid regular expression: ' + String((e as Error).message).replace(/^Invalid regular expression: /, ''));
  }
}

/** Tags, comments, scripts and styles of an HTML text as spaces (newlines kept): what remains is what the page shows. */
export function maskHtml(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return text.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)|<[^>]*>?/gi, blank);
}

const PREVIEW_BEFORE = 24, PREVIEW_AFTER = 120;   // (a few words before the match: it stays in view in a narrow panel)

/** The match `col`…`col+len` of `line`, with some of the line around it: whitespace runs as one space, cut ends as "…". */
export function previewOf(line: string, col: number, len: number): { preview: string; from: number; to: number } {
  let start = Math.max(0, col - PREVIEW_BEFORE);
  const end = Math.min(line.length, col + len + PREVIEW_AFTER);
  if (start > 0) { const sp = line.lastIndexOf(' ', col - 1); if (sp >= start - 10 && sp < col) start = sp + 1; }
  let out = start > 0 ? '…' : '';
  let from = -1, to = -1, space = false;
  for (let i = start; i < end; i++) {
    if (i === col) { from = out.length; space = false; }
    if (i === col + len) to = out.length;
    const c = line[i];
    if (/\s/.test(c) && (i < col || i >= col + len)) {
      if (!space && out.length && !out.endsWith('…')) out += ' ';
      space = true;
      continue;
    }
    space = false;
    out += c;
  }
  if (from < 0) from = out.length;
  if (to < 0) to = out.length;
  if (end < line.length) out = out.trimEnd() + '…';
  return { preview: out, from, to };
}

/** The matches of `re` in one file's text (`html`: only what the page shows, and the slide of each). */
export function searchText(text: string, re: RegExp, o: { html?: boolean; perFile?: number; countPerFile?: number } = {}): { count: number; matches: SearchMatch[] } {
  const perFile = o.perFile ?? SEARCH_LIMITS.perFile, countMax = o.countPerFile ?? SEARCH_LIMITS.countPerFile;
  const hay = o.html ? maskHtml(text) : text;
  const matches: (SearchMatch & { at: number })[] = [];
  let count = 0, line = 0, lineStart = 0;
  re.lastIndex = 0;
  for (let m = re.exec(hay); m; m = re.exec(hay)) {
    if (!m[0].length) { re.lastIndex++; if (re.lastIndex > hay.length) break; continue; }
    count++;
    if (matches.length < perFile) {
      for (let nl = hay.indexOf('\n', lineStart); nl >= 0 && nl < m.index; nl = hay.indexOf('\n', lineStart)) { line++; lineStart = nl + 1; }
      const lineEnd = hay.indexOf('\n', m.index);
      const text = hay.slice(lineStart, lineEnd < 0 ? hay.length : lineEnd).replace(/\r$/, '');
      const col = m.index - lineStart, len = Math.max(1, Math.min(m[0].length, text.length - col));
      matches.push({ line: line + 1, col, len, ...previewOf(text, col, len), at: m.index });
    }
    if (count >= countMax) break;
  }
  if (o.html && matches.length) {
    try {
      const slides = slideElements(parseSource(text).doc).map(outerRange);
      if (slides.length) for (const m of matches) { const k = slides.findIndex(r => m.at >= r.from && m.at < r.to); if (k >= 0) m.slide = k + 1; }
    } catch { /* an unreadable page: no slide numbers */ }
  }
  return { count, matches: matches.map(({ at: _at, ...m }) => m) };
}

/** Search the files in order, within the limits (`truncated` when one stopped it). Binary and too-large files are skipped. */
export function searchFiles(targets: SearchTarget[], query: SearchQuery, limits: SearchLimits = SEARCH_LIMITS, now: () => number = Date.now): SearchResult {
  const re = compileQuery(query);
  const t0 = now();
  const out: SearchResult = { files: [], total: 0, truncated: false, searched: 0, skipped: 0 };
  let bytes = 0, shown = 0;
  for (const t of targets) {
    if (now() - t0 > limits.softMs || bytes > limits.totalBytes || shown >= limits.shown || out.files.length >= limits.files) { out.truncated = true; break; }
    if (t.size > limits.fileBytes) { out.skipped++; continue; }
    let buf: Buffer;
    try { buf = fs.readFileSync(t.abs); } catch { out.skipped++; continue; }
    if (buf.length > limits.fileBytes || buf.subarray(0, 8000).includes(0)) { out.skipped++; continue; }
    bytes += buf.length;
    out.searched++;
    const r = searchText(buf.toString('utf8'), re, { html: t.html, perFile: Math.min(limits.perFile, limits.shown - shown), countPerFile: limits.countPerFile });
    if (!r.count) continue;
    out.total += r.count;
    shown += r.matches.length;
    out.files.push({ path: t.path, count: r.count, matches: r.matches });
  }
  return out;
}
