/**
 * Which projects are end-to-end encrypted (the project list says so; kept for deep links and offline).
 * Light on purpose: editor modules shared with the VS Code extension ask it (fold.ts, rawpreview.ts),
 * and nothing of the rest of e2e/ comes along.
 */
import { projectOfDoc } from '@overlyx/core/projectKey.ts';

const KNOWN = 'ol.e2eProjects';
const known = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(KNOWN) ?? '[]') as string[]; } catch { return []; } })());
/** each project's role for this user */
export const roles = new Map<string, string>();

/** The project list said which projects are encrypted (`complete`: the whole list — others are not). */
export function noteProjects(list: { name: string; e2e?: boolean; role?: string }[], complete = true): void {
  let changed = false;
  for (const p of list) {
    if (p.role) roles.set(p.name, p.role);
    if (p.e2e && !known.has(p.name)) { known.add(p.name); changed = true; }
    if (!p.e2e && complete && known.has(p.name)) { known.delete(p.name); changed = true; }
  }
  if (complete) for (const k of [...known]) if (!list.some(p => p.name === k)) { known.delete(k); changed = true; }
  if (changed) try { localStorage.setItem(KNOWN, JSON.stringify([...known])); } catch { /* private mode */ }
}
export function markE2eProject(project: string, role = 'owner'): void { noteProjects([{ name: project, e2e: true, role }], false); }
export function isE2eProject(project: string): boolean { return known.has(project); }
export function isE2eDocId(docId: string): boolean { return known.has(projectOfDoc(docId)); }
export function knownE2eProjects(): string[] { return [...known]; }
