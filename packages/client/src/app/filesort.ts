/**
 * The order of a project's files where they are listed for opening — the start page's projects and a
 * project's own page (Home.tsx): the most recent first (the later of when the file last changed —
 * anyone's edit, a push, an agent — and when this person last opened it), or by name (the main
 * document first, then the others; the order there was before). The choice is remembered per browser.
 */
import type { Project } from '../api';

export type FileSort = 'recent' | 'name';
const KEY = 'ol.fileSort';

export function storedFileSort(): FileSort {
  try { return localStorage.getItem(KEY) === 'name' ? 'name' : 'recent'; } catch { return 'recent'; }
}
export function rememberFileSort(s: FileSort): void {
  try { localStorage.setItem(KEY, s); } catch { /* the choice is just not remembered */ }
}

/** when a file of the project was last changed or opened by this person (0: not known) */
export function fileRecency(p: Project, path: string): number {
  const f = p.files.find(x => x.path === path);
  let t = f?.mtime ?? 0;
  const opened = p.opened?.[path];
  if (opened && opened > t) t = opened;
  // the file noted last (a tab id: `text:`/`pdf:` before the document id) was opened at least as late as the project
  const last = p.lastFile?.replace(/^(text|pdf):/, '');
  if (last === `${p.name}/${path}` && p.lastOpened && p.lastOpened > t) t = p.lastOpened;
  return t;
}

/** `paths` (in their name order) as `sort` asks: by recency, newest first, else unchanged */
export function sortFiles(p: Project, paths: string[], sort: FileSort): string[] {
  if (sort === 'name') return paths;
  const at = new Map(paths.map((x, i) => [x, { t: fileRecency(p, x), i }]));
  return [...paths].sort((a, b) => at.get(b)!.t - at.get(a)!.t || at.get(a)!.i - at.get(b)!.i);
}
