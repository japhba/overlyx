/**
 * Projects by recency (the start screen): the later of when you last opened a project and when any
 * of its files last changed (a collaborator's edit, a git push, an agent counts too).
 */
import type { Project } from '../api';
import { formatAge } from './pdfstatus';

export function projectRecency(p: Project): number {
  let t = p.lastOpened ?? 0;
  for (const f of p.files) if (f.kind !== 'dir' && f.mtime > t) t = f.mtime;
  return t;
}

/** newest first; equally recent (or never touched) projects by title */
export function sortByRecency<P extends Project>(list: P[]): P[] {
  return [...list].sort((a, b) => projectRecency(b) - projectRecency(a) || (a.title ?? a.name).localeCompare(b.title ?? b.name));
}

/** "opened 3 min ago" / "edited 2 days ago" — what put the project where it is */
export function recencyLabel(p: Project, now = Date.now()): string {
  const t = projectRecency(p);
  if (!t) return '';
  const a = formatAge(now - t);
  const verb = p.lastOpened && p.lastOpened >= t ? 'opened' : 'changed';
  return `${verb} ${a === 'just now' ? a : a + ' ago'}`;
}
