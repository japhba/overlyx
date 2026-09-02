/**
 * A "project" is a directory on disk (usually a VS Code workspace folder): its files, which .tex
 * files are documents, and the master of a child document. Ported from the server's projects.ts,
 * without the ownership/registry parts.
 */
import fs from 'node:fs';
import path from 'node:path';

export type FileKind = 'doc' | 'lyx' | 'bib' | 'image' | 'tex' | 'pdf' | 'dir' | 'other';
export interface ProjectFile { path: string; name: string; size: number; mtime: number; kind: FileKind }

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.svgz', '.eps', '.ps', '.tif', '.tiff', '.bmp']);

function fileKind(name: string): FileKind {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.tex') return 'tex';
  if (ext === '.lyx') return 'lyx';
  if (ext === '.bib') return 'bib';
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'other';
}

export function isBackupFile(name: string): boolean { return name.endsWith('~') || name.endsWith('.bak'); }

/** What a .tex file contains, cached by mtime + size. */
const texInfoCache = new Map<string, { key: string; hasDocument: boolean; includes: string[] }>();
export function texInfo(abs: string, st: fs.Stats): { hasDocument: boolean; includes: string[] } {
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = texInfoCache.get(abs);
  if (hit && hit.key === key) return hit;
  let hasDocument = false;
  const includes: string[] = [];
  if (st.size < 16 * 1024 * 1024) {
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { /* ignore */ }
    // comments do not count (a note may quote \begin{document})
    const code = text.split('\n').map(l => {
      let out = '';
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (c === '\\') { out += c + (l[i + 1] ?? ''); i++; continue; }
        if (c === '%') break;
        out += c;
      }
      return out;
    }).join('\n');
    hasDocument = code.includes('\\begin{document}');
    for (const m of code.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) includes.push(m[1].trim());
  }
  const info = { key, hasDocument, includes };
  if (texInfoCache.size > 500) texInfoCache.clear();
  texInfoCache.set(abs, info);
  return info;
}

export function collectFiles(root: string, dir = root, out: ProjectFile[] = [], depth = 0): ProjectFile[] {
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name.endsWith('.overlyx-tmp')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      try { out.push({ path: path.relative(root, full), name: e.name, size: 0, mtime: fs.statSync(full).mtimeMs, kind: 'dir' }); } catch { /* ignore */ }
      collectFiles(root, full, out, depth + 1);
      continue;
    }
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    out.push({ path: path.relative(root, full), name: e.name, size: st.size, mtime: st.mtimeMs, kind: fileKind(e.name) });
  }
  return depth === 0 ? classifyDocs(root, out.sort((a, b) => a.path.localeCompare(b.path))) : out;
}

/** .tex files with \begin{document}, and everything they (transitively) include, are documents. */
function classifyDocs(root: string, files: ProjectFile[]): ProjectFile[] {
  const byPath = new Map(files.map(f => [f.path, f]));
  const docs: ProjectFile[] = [];
  for (const f of files) {
    if (f.kind !== 'tex' || isBackupFile(f.name)) continue;
    let st: fs.Stats;
    try { st = fs.statSync(path.join(root, f.path)); } catch { continue; }
    if (texInfo(path.join(root, f.path), st).hasDocument) { f.kind = 'doc'; docs.push(f); }
  }
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

/** The master document of a child (a document that transitively includes it), if any. */
export function findMaster(root: string, relPath: string): string | null {
  const files = collectFiles(root).filter(f => (f.kind === 'tex' || f.kind === 'doc') && f.name.endsWith('.tex') && !isBackupFile(f.name) && f.path !== relPath);
  const withDoc: string[] = [];
  const parents = new Map<string, string[]>();
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
  const seen = new Set<string>();
  const candidates: string[] = [];
  const up = (rel: string, depth: number) => {
    if (depth > 6 || seen.has(rel)) return;
    seen.add(rel);
    for (const p of parents.get(rel) ?? []) { if (withDoc.includes(p)) candidates.push(p); else up(p, depth + 1); }
  };
  up(path.normalize(relPath), 0);
  return candidates.sort()[0] ?? null;
}

/** Child documents (\input / \include) of a document, project-relative, in order. */
export function childDocuments(root: string, relPath: string, depth = 0, out: string[] = []): string[] {
  if (depth > 5) return out;
  const abs = path.join(root, relPath);
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return out; }
  for (const inc of texInfo(abs, st).includes) {
    const rel = path.normalize(path.join(path.dirname(relPath), inc.endsWith('.tex') ? inc : inc + '.tex'));
    if (out.includes(rel) || rel === relPath || !fs.existsSync(path.join(root, rel))) continue;
    out.push(rel);
    childDocuments(root, rel, depth + 1, out);
  }
  return out;
}

/** Resolve a path inside the project, refusing to escape it. */
export function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('path escapes the project');
  return abs;
}

/**
 * Read a text file. UTF-8; one that is not valid UTF-8 is decoded as latin-1 rather than turned
 * into U+FFFD characters that would be written back over the original bytes.
 */
export function readTextFile(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return buf.toString('latin1'); }
}

export function looksLikeDocument(text: string, fragment: boolean): boolean {
  if (fragment) return !text.includes('\0');
  return /\\begin\{document\}/.test(text) && /\\end\{document\}/.test(text);
}
