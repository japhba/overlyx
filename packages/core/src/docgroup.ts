/**
 * Document groups: several documents that belong together and read as one — the tabs of a Google
 * Doc, the chapters of a report. A group is a folder holding a manifest, GROUP_MANIFEST, that lists
 * its documents in order with the titles shown for them and how deep each is nested (a Google Doc's
 * tabs can have child tabs). Being a file, a group travels with the project through git, synced
 * clones and VS Code; the file browser shows the folder as one entry with its documents under it.
 *
 *   { "version": 1, "title": "Grant proposal",
 *     "members": [ { "file": "summary.md", "title": "Summary" }, { "file": "aims.md", "title": "Aims", "level": 1 } ] }
 *
 * `file` is a name in the folder (no path). A manifest that does not parse leaves a plain folder.
 */

export const GROUP_MANIFEST = '.overlyx-group.json';

export interface DocGroupMember { file: string; title?: string; level?: number }
export interface DocGroup { version: 1; title?: string; members: DocGroupMember[] }

/** a manifest's text as a group; null when it is not one (the folder is then an ordinary folder) */
export function parseDocGroup(text: string): DocGroup | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object' || !Array.isArray((j as DocGroup).members)) return null;
  const g = j as { title?: unknown; members: unknown[] };
  const members: DocGroupMember[] = [];
  const seen = new Set<string>();
  for (const m of g.members) {
    if (!m || typeof m !== 'object') continue;
    const { file, title, level } = m as Record<string, unknown>;
    if (typeof file !== 'string' || !file || /[/\\]/.test(file) || file === '.' || file === '..' || seen.has(file)) continue;
    seen.add(file);
    members.push({ file, ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}), ...(Number.isInteger(level) && (level as number) > 0 ? { level: Math.min(8, level as number) } : {}) });
  }
  return { version: 1, ...(typeof g.title === 'string' && g.title.trim() ? { title: g.title.trim() } : {}), members };
}

export function writeDocGroup(g: DocGroup): string {
  return JSON.stringify({ version: 1, ...(g.title ? { title: g.title } : {}), members: g.members.map(m => ({ file: m.file, ...(m.title ? { title: m.title } : {}), ...(m.level ? { level: m.level } : {}) })) }, null, 2) + '\n';
}
