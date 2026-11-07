/**
 * Go to File (Ctrl/⌘+P, app/QuickOpen.tsx), VS Code's Quick Open: the project's files matched by a
 * few typed letters in order — `mtex` finds main.tex, `figplot` figures/plot.pdf — ranked by where the
 * letters fall (the file name before its folder, word starts, runs of letters), recently shown files
 * first. Pure, tested without a browser.
 */
import { fileTabId, isAuxFile, type Project, type ProjectFile } from '../api';

export interface FuzzyHit { score: number; /** matched character indices in the target */ positions: number[] }

const SEPARATOR = /[/\\_\-. ]/;
const isWordStart = (s: string, i: number) => i === 0 || SEPARATOR.test(s[i - 1]) || (/[a-z0-9]/.test(s[i - 1]) && /[A-Z]/.test(s[i]));

/**
 * The letters of `query` (spaces ignored) found in `target` in order, case-insensitive, or null. At
 * each letter a word start is taken over an earlier plain occurrence when the rest still fits after it.
 */
export function fuzzyMatch(query: string, target: string): FuzzyHit | null {
  const typed = query.replace(/\s+/g, ''), q = typed.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const t = target.toLowerCase();
  /** can q[k…] be found in order from position `from` on? */
  const fits = (k: number, from: number) => { for (let i = from; k < q.length && i < t.length; i++) if (t[i] === q[k]) k++; return k === q.length; };
  if (!fits(0, 0)) return null;
  const positions: number[] = [];
  let score = 0, at = 0;
  for (let k = 0; k < q.length; k++) {
    let i = t.indexOf(q[k], at);
    // a word start a little further on reads better (`mt` → *m*ain.*t*ex, not *m*ain.*t*ex's "ma*t*h")
    if (i >= 0 && !isWordStart(target, i) && positions.at(-1) !== i - 1) {
      for (let j = t.indexOf(q[k], i + 1); j >= 0; j = t.indexOf(q[k], j + 1)) {
        if (isWordStart(target, j) && fits(k + 1, j + 1)) { i = j; break; }
      }
    }
    positions.push(i);
    score += 1;
    if (isWordStart(target, i)) score += 6;
    if (positions.length > 1 && positions.at(-2) === i - 1) score += 5;
    if (target[i] === typed[k]) score += 0.5;   // the same case as typed
    at = i + 1;
  }
  // a gap between the first and last letter costs a little; matches in the file name count more
  score -= (positions.at(-1)! - positions[0] - q.length + 1) * 0.05;
  const nameStart = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')) + 1;
  const inName = positions.filter(p => p >= nameStart).length;
  score += inName * 2 + (inName === q.length ? 10 : 0);
  if (positions[0] === nameStart) score += 4;
  return { score, positions };
}

export interface QuickFile {
  /** what opening it means: a tab id (`#/<id>`), else a file to open in a browser tab */
  id: string | null;
  project: string; path: string; name: string; dir: string;
  file: ProjectFile;
}

const isBackup = (name: string) => name.endsWith('~') || name.startsWith('#') || name.endsWith('.emergency');

/** The files Go to File offers: every file of the projects but folders, LaTeX's build products and backups. */
export function quickFiles(projects: Project[]): QuickFile[] {
  const out: QuickFile[] = [];
  for (const p of projects) {
    for (const f of p.files) {
      if (f.kind === 'dir' || isAuxFile(f.name) || isBackup(f.name)) continue;
      const cut = f.path.lastIndexOf('/');
      out.push({ id: fileTabId(p.name, f), project: p.name, path: f.path, name: f.name, dir: cut < 0 ? '' : f.path.slice(0, cut), file: f });
    }
  }
  return out;
}

export interface QuickHit extends QuickFile { positions: number[]; score: number }

/**
 * The files for `query`, best first: with no query the recently shown ones (`recent`: tab ids, newest
 * first), then documents, then the rest by path; with one the matches by score, recent ones lifted.
 */
export function rankFiles(files: QuickFile[], query: string, recent: string[] = [], limit = 60): QuickHit[] {
  const recency = (f: QuickFile) => { const i = f.id ? recent.indexOf(f.id) : -1; return i < 0 ? 0 : Math.max(1, 8 - i); };
  if (!query.trim()) {
    const doc = (f: QuickFile) => (f.file.kind === 'doc' || (f.file.kind === 'html' && !!f.file.deliverable) || f.file.kind === 'board' ? 1 : 0);
    return [...files].sort((a, b) => recency(b) - recency(a) || doc(b) - doc(a) || a.path.localeCompare(b.path, undefined, { numeric: true }))
      .slice(0, limit).map(f => ({ ...f, positions: [], score: 0 }));
  }
  const hits: QuickHit[] = [];
  for (const f of files) {
    const target = f.path;
    const m = fuzzyMatch(query, target);
    if (m) hits.push({ ...f, positions: m.positions, score: m.score + recency(f) });
  }
  return hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path)).slice(0, limit);
}
