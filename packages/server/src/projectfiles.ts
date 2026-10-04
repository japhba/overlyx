/**
 * The files of a project as the file system has them: paths inside a project, what kind a file is,
 * which .tex file is a document's master. No database here — the document workers (docpool.ts) use
 * it as well as the main thread; projects.ts re-exports all of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { hasSettingsLine, isProjectKey } from '@overlyx/core';
import { config } from './config.ts';

/** `doc`: a .tex document (has \\begin{document}, is \\input by one, or was written by OverLyX — a fragment with its settings line); `tex`: other LaTeX sources (preamble, macros, .sty); `dir`: a directory (so empty folders show in the explorer) */
export interface ProjectFile { path: string; name: string; size: number; mtime: number; kind: 'doc' | 'lyx' | 'bib' | 'image' | 'tex' | 'pdf' | 'board' | 'dir' | 'other' }

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.eps', '.ps', '.tif', '.tiff', '.webp', '.bmp']);

export function fileKind(name: string): ProjectFile['kind'] {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.lyx') return 'lyx';
  if (ext === '.bib') return 'bib';
  if (ext === '.tex' || ext === '.sty' || ext === '.cls') return 'tex';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.board') return 'board';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'other';
}

/** What a .tex file contains, cached by mtime + size. */
const texInfoCache = new Map<string, { key: string; hasDocument: boolean; authored: boolean; includes: string[] }>();
/** `authored`: OverLyX wrote the file (it carries a settings line) — a fragment edited on its own is a document, not a preamble. */
export function texInfo(abs: string, st: fs.Stats): { hasDocument: boolean; authored: boolean; includes: string[] } {
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = texInfoCache.get(abs);
  if (hit && hit.key === key) return hit;
  let hasDocument = false;
  let authored = false;
  const includes: string[] = [];
  if (st.size < 16 * 1024 * 1024) {
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { /* ignore */ }
    authored = hasSettingsLine(text);
    // comments do not count (a note may quote \begin{document})
    const code = text.split('\n').map(l => { let out = ''; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c === '\\') { out += c + (l[i + 1] ?? ''); i++; continue; } if (c === '%') break; out += c; } return out; }).join('\n');
    const begin = code.indexOf('\\begin{document}');
    hasDocument = begin >= 0;
    // files \input from the body are documents too (child documents); preamble inputs are not
    const body = hasDocument ? code.slice(begin) : code;
    for (const m of body.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) includes.push(m[1].trim());
  }
  if (texInfoCache.size > 2000) texInfoCache.clear();
  const info = { key, hasDocument, authored, includes };
  texInfoCache.set(abs, info);
  return info;
}

export function collect(root: string, dir: string, out: ProjectFile[], depth: number): ProjectFile[] {
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
  if (!isProjectKey(project)) throw new Error('bad project name');
  const root = path.join(config.projectsDir, project);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('path escapes project');
  return abs;
}

export function projectDir(project: string): string {
  return resolveProjectPath(project, '.');
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
