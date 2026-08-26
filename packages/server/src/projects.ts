import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

export interface ProjectFile { path: string; name: string; size: number; mtime: number; kind: 'lyx' | 'bib' | 'image' | 'tex' | 'pdf' | 'other' }
export interface Project { name: string; path: string; files: ProjectFile[] }

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.eps', '.ps', '.tif', '.tiff', '.webp', '.bmp']);

export function fileKind(name: string): ProjectFile['kind'] {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.lyx') return 'lyx';
  if (ext === '.bib') return 'bib';
  if (ext === '.tex' || ext === '.sty' || ext === '.cls') return 'tex';
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'other';
}

export function listProjects(): Project[] {
  const root = config.projectsDir;
  if (!fs.existsSync(root)) return [];
  const out: Project[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const p = path.join(root, entry.name);
    out.push({ name: entry.name, path: p, files: collect(p, p, [], 0) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function collect(root: string, dir: string, out: ProjectFile[], depth: number): ProjectFile[] {
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name.endsWith('.overlyx-tmp')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { collect(root, full, out, depth + 1); continue; }
    const st = fs.statSync(full);
    out.push({ path: path.relative(root, full), name: e.name, size: st.size, mtime: st.mtimeMs, kind: fileKind(e.name) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Resolve a path inside a project, refusing to escape the project directory. */
export function resolveProjectPath(project: string, rel: string): string {
  if (!/^[A-Za-z0-9._ -]+$/.test(project)) throw new Error('bad project name');
  const root = path.join(config.projectsDir, project);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('path escapes project');
  return abs;
}

export function projectDir(project: string): string {
  return resolveProjectPath(project, '.');
}

export function createProject(name: string): Project {
  const dir = resolveProjectPath(name, '.');
  fs.mkdirSync(dir, { recursive: true });
  return { name, path: dir, files: [] };
}

const TEMPLATE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../templates');

export function newDocumentText(opts: { textclass?: string; title?: string; author?: string } = {}): string {
  let tpl = fs.readFileSync(path.join(TEMPLATE_DIR, 'article.lyx'), 'utf8');
  if (opts.textclass) tpl = tpl.replace(/^\\textclass .*$/m, '\\textclass ' + opts.textclass);
  const body: string[] = [];
  if (opts.title) body.push(`\n\\begin_layout Title\n${opts.title}\n\\end_layout\n`);
  if (opts.author) body.push(`\n\\begin_layout Author\n${opts.author}\n\\end_layout\n`);
  body.push('\n\\begin_layout Standard\n\n\\end_layout\n');
  return tpl.replace('%%BODY%%', body.join(''));
}

/** LyX backup / temp files that should never be treated as documents. */
export function isBackupFile(name: string): boolean {
  return name.endsWith('~') || name.startsWith('#') || name.endsWith('.emergency') || name.endsWith('.overlyx-tmp');
}

/**
 * Find the master document of a child (LyX children have no back-link unless \master is set):
 * scan the project's .lyx files for an include inset referencing the child. Returns a
 * project-relative path or null.
 */
export function findMaster(project: string, relPath: string): string | null {
  const root = projectDir(project);
  const files = collect(root, root, [], 0).filter(f => f.kind === 'lyx' && !isBackupFile(f.name) && f.path !== relPath);
  const candidates: string[] = [];
  for (const f of files) {
    let text: string;
    try { text = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
    const m = /^\\master (.+)$/m.exec(text);
    void m;
    const dir = path.dirname(f.path);
    for (const im of text.matchAll(/^filename "([^"]+)"$/gm)) {
      const target = path.normalize(path.join(dir === '.' ? '' : dir, im[1]));
      if (target === relPath) { candidates.push(f.path); break; }
    }
  }
  if (!candidates.length) {
    // explicit \master in the child itself
    try {
      const text = fs.readFileSync(path.join(root, relPath), 'utf8');
      const m = /^\\master (.+)$/m.exec(text);
      if (m) return path.normalize(path.join(path.dirname(relPath), m[1].trim()));
    } catch { /* ignore */ }
    return null;
  }
  // prefer main.lyx-like names, then the shortest path
  candidates.sort((a, b) => Number(!/(^|\/)main\.lyx$/.test(a)) - Number(!/(^|\/)main\.lyx$/.test(b)) || a.length - b.length || a.localeCompare(b));
  return candidates[0];
}
