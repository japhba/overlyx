/**
 * The start page's project search (app/HomeSearch.tsx): what is typed filters the projects as one
 * types — by their name, their owner and the names of the files inside them. Every word typed has to
 * be found somewhere (in any order, any case); a word found only among the files puts those files
 * on the project's line, so that the one looked for can be opened straight away.
 */
import { isAuxFile, type Project } from '../api';
import { projectShortName } from '@overlyx/core';

const isBackup = (name: string) => name.endsWith('~') || name.startsWith('#') || name.endsWith('.emergency');

/** the words of a query, lower case */
export function searchTerms(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

export interface ProjectHit {
  /** files whose names hold the words not found in the project's name or owner (none: the name matched) */
  files: string[];
}

/** Does `p` match all `terms` (searchTerms)? Its matching files, documents first; null: no match. */
export function matchProject(p: Project, terms: string[]): ProjectHit | null {
  if (!terms.length) return { files: [] };
  const head = [p.title ?? '', projectShortName(p.name), p.name, p.owner?.name ?? '', p.owner?.username ?? ''].join('\n').toLowerCase();
  const rest = terms.filter(t => !head.includes(t));
  if (!rest.length) return { files: [] };
  const files = p.files.filter(f => f.kind !== 'dir' && !isAuxFile(f.name) && !isBackup(f.name));
  // every word left is in some file's path …
  if (!rest.every(t => files.some(f => f.path.toLowerCase().includes(t)))) return null;
  // … shown: the files that hold all of them, else those that hold any
  const all = files.filter(f => rest.every(t => f.path.toLowerCase().includes(t)));
  const shown = all.length ? all : files.filter(f => rest.some(t => f.path.toLowerCase().includes(t)));
  const rank = (k: string) => (k === 'doc' ? 0 : k === 'html' ? 1 : 2);
  return { files: shown.sort((a, b) => rank(a.kind) - rank(b.kind) || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path)).map(f => f.path) };
}

/** the parts of `text` that hold a term, for marking them: [plain, marked, plain, …] */
export function markTerms(text: string, terms: string[]): string[] {
  if (!terms.length) return [text];
  const low = text.toLowerCase();
  const on = new Array<boolean>(text.length).fill(false);
  for (const t of terms) for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + 1)) on.fill(true, i, i + t.length);
  const out: string[] = [];
  let run = '', marked = false;
  for (let i = 0; i < text.length; i++) {
    if (on[i] !== marked) { out.push(run); run = ''; marked = on[i]; }
    run += text[i];
  }
  out.push(run);
  return out;
}
