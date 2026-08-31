import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

/** `doc`: a .tex document (has \\begin{document}, or is \\input by one); `tex`: other LaTeX sources (preamble, macros, .sty); `dir`: a directory (so empty folders show in the explorer) */
export interface ProjectFile { path: string; name: string; size: number; mtime: number; kind: 'doc' | 'lyx' | 'bib' | 'image' | 'tex' | 'pdf' | 'dir' | 'other' }
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
    out.push({ name: entry.name, path: p, files: classifyDocs(p, collect(p, p, [], 0)) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** What a .tex file contains, cached by mtime + size. */
const texInfoCache = new Map<string, { key: string; hasDocument: boolean; includes: string[] }>();
function texInfo(abs: string, st: fs.Stats): { hasDocument: boolean; includes: string[] } {
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = texInfoCache.get(abs);
  if (hit && hit.key === key) return hit;
  let hasDocument = false;
  const includes: string[] = [];
  if (st.size < 16 * 1024 * 1024) {
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { /* ignore */ }
    // comments do not count (a note may quote \begin{document})
    const code = text.split('\n').map(l => { let out = ''; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c === '\\') { out += c + (l[i + 1] ?? ''); i++; continue; } if (c === '%') break; out += c; } return out; }).join('\n');
    const begin = code.indexOf('\\begin{document}');
    hasDocument = begin >= 0;
    // files \input from the body are documents too (child documents); preamble inputs are not
    const body = hasDocument ? code.slice(begin) : code;
    for (const m of body.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) includes.push(m[1].trim());
  }
  if (texInfoCache.size > 2000) texInfoCache.clear();
  const info = { key, hasDocument, includes };
  texInfoCache.set(abs, info);
  return info;
}

/** Mark .tex files that are documents (own \\begin{document}, or \\input by a document's body). */
function classifyDocs(root: string, files: ProjectFile[]): ProjectFile[] {
  const byPath = new Map(files.map(f => [f.path, f]));
  const docs: ProjectFile[] = [];
  for (const f of files) {
    if (f.kind !== 'tex' || !f.name.endsWith('.tex') || isBackupFile(f.name)) continue;
    let st: fs.Stats;
    try { st = fs.statSync(path.join(root, f.path)); } catch { continue; }
    if (texInfo(path.join(root, f.path), st).hasDocument) { f.kind = 'doc'; docs.push(f); }
  }
  // children (transitively)
  const queue = [...docs];
  const seen = new Set(docs.map(d => d.path));
  while (queue.length) {
    const d = queue.shift()!;
    let st: fs.Stats;
    try { st = fs.statSync(path.join(root, d.path)); } catch { continue; }
    for (const inc of texInfo(path.join(root, d.path), st).includes) {
      const rel = path.normalize(path.join(path.dirname(d.path), inc.endsWith('.tex') ? inc : inc + '.tex'));
      const f = byPath.get(rel);
      if (f && f.kind === 'tex' && !seen.has(rel)) { f.kind = 'doc'; seen.add(rel); queue.push(f); }
    }
  }
  return files;
}

/** Is the project file a document (opened in the document editor, never served as plain text)? */
export function isDocumentFile(project: string, relPath: string): boolean {
  if (!relPath.endsWith('.tex')) return false;
  const root = projectDir(project);
  const rel = path.normalize(relPath);
  return classifyDocs(root, collect(root, root, [], 0)).some(f => f.path === rel && f.kind === 'doc');
}

/** Child documents (\\input / \\include from the body) of a document, project-relative, in order. */
export function childDocuments(project: string, relPath: string, depth = 0, out: string[] = []): string[] {
  if (depth > 5) return out;
  const root = projectDir(project);
  const abs = path.join(root, relPath);
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return out; }
  for (const inc of texInfo(abs, st).includes) {
    const rel = path.normalize(path.join(path.dirname(relPath), inc.endsWith('.tex') ? inc : inc + '.tex'));
    if (out.includes(rel) || rel === relPath || !fs.existsSync(path.join(root, rel))) continue;
    out.push(rel);
    childDocuments(project, rel, depth + 1, out);
  }
  return out;
}

function collect(root: string, dir: string, out: ProjectFile[], depth: number): ProjectFile[] {
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name.endsWith('.overlyx-tmp')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      try { out.push({ path: path.relative(root, full), name: e.name, size: 0, mtime: fs.statSync(full).mtimeMs, kind: 'dir' }); } catch { /* ignore */ }
      collect(root, full, out, depth + 1);
      continue;
    }
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

/** Escape text for use in a LaTeX argument (titles, names). */
function texEscape(s: string): string {
  return s.replace(/[\\{}$&#^_%~]/g, c => ({ '\\': '\\textbackslash{}', '^': '\\^{}', '~': '\\textasciitilde{}' } as Record<string, string>)[c] ?? '\\' + c);
}

export function newDocumentText(opts: { textclass?: string; title?: string; author?: string } = {}): string {
  let tpl = fs.readFileSync(path.join(TEMPLATE_DIR, 'article.tex'), 'utf8');
  if (opts.textclass) tpl = tpl.replace(/^\\documentclass(\[[^\]]*\])?\{[^}]*\}/m, (m, o: string | undefined) => `\\documentclass${o ?? ''}{${opts.textclass}}`);
  const body: string[] = [];
  if (opts.title) body.push(`\\title{${texEscape(opts.title)}}`);
  if (opts.author) body.push(`\\author{${texEscape(opts.author)}}`);
  if (opts.title || opts.author) body.push('\\maketitle', '');
  return tpl.replace('@@BODY@@', body.join('\n'));
}

/** LyX backup / temp files that should never be treated as documents. */
export function isBackupFile(name: string): boolean {
  return name.endsWith('~') || name.startsWith('#') || name.endsWith('.emergency') || name.endsWith('.overlyx-tmp');
}

/**
 * Find the master document of a child: the project's .tex documents whose body \\inputs /
 * \\includes it (directly or through another child). Returns a project-relative path or null.
 */
export function findMaster(project: string, relPath: string): string | null {
  const root = projectDir(project);
  const files = collect(root, root, [], 0).filter(f => f.kind === 'tex' && f.name.endsWith('.tex') && !isBackupFile(f.name) && f.path !== relPath);
  const withDoc: string[] = [];
  const parents = new Map<string, string[]>();   // child → files including it
  for (const f of files) {
    let st: fs.Stats;
    try { st = fs.statSync(path.join(root, f.path)); } catch { continue; }
    const info = texInfo(path.join(root, f.path), st);
    if (info.hasDocument) withDoc.push(f.path);
    for (const inc of info.includes) {
      const target = path.normalize(path.join(path.dirname(f.path), inc.endsWith('.tex') ? inc : inc + '.tex'));
      const list = parents.get(target) ?? [];
      list.push(f.path);
      parents.set(target, list);
    }
  }
  // walk up from the child to a file with \\begin{document}
  const seen = new Set<string>();
  const candidates: string[] = [];
  const up = (rel: string, depth: number) => {
    if (depth > 6 || seen.has(rel)) return;
    seen.add(rel);
    for (const p of parents.get(rel) ?? []) { if (withDoc.includes(p)) candidates.push(p); else up(p, depth + 1); }
  };
  up(relPath, 0);
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(!/(^|\/)main\.tex$/.test(a)) - Number(!/(^|\/)main\.tex$/.test(b)) || a.length - b.length || a.localeCompare(b));
  return candidates[0];
}
