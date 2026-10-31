/**
 * `node:fs` for the core's parser and writer in the browser (vite.config.ts aliases it): the files
 * they read — LyX's library (layouts, modules, symbols, languages) — come from one bundle the server
 * hands out (texlocal.ts loads it into `files` before anything is parsed). Read-only and synchronous,
 * as the core expects; anything not in it does not exist.
 */
const files = new Map<string, string>();
const dirs = new Map<string, Set<string>>();

const norm = (p: string) => '/' + p.split('/').filter(s => s && s !== '.').reduce<string[]>((a, s) => (s === '..' ? a.slice(0, -1) : [...a, s]), []).join('/');

export function mount(root: string, entries: Record<string, string>): void {
  for (const [rel, text] of Object.entries(entries)) {
    const p = norm(`${root}/${rel}`);
    files.set(p, text);
    let child = p;
    for (let d = child.slice(0, child.lastIndexOf('/')) || '/'; ; d = d.slice(0, d.lastIndexOf('/')) || '/') {
      let s = dirs.get(d);
      if (!s) dirs.set(d, s = new Set());
      s.add(child.slice(child.lastIndexOf('/') + 1));
      if (d === '/') break;
      child = d;
    }
  }
}

export function mounted(root: string): boolean { return dirs.has(norm(root)); }

function missing(p: string): Error { return Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' }); }

export function existsSync(p: string): boolean { const n = norm(String(p)); return files.has(n) || dirs.has(n); }

export function readFileSync(p: string, _enc?: unknown): string {
  const t = files.get(norm(String(p)));
  if (t === undefined) throw missing(String(p));
  return t;
}

export function readdirSync(p: string): string[] {
  const s = dirs.get(norm(String(p)));
  if (!s) throw missing(String(p));
  return [...s].sort();
}

export function statSync(p: string): { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number } {
  const n = norm(String(p));
  if (files.has(n)) return { isFile: () => true, isDirectory: () => false, size: files.get(n)!.length, mtimeMs: 0 };
  if (dirs.has(n)) return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
  throw missing(String(p));
}

export default { existsSync, readFileSync, readdirSync, statSync };
