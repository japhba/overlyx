/** `node:path` (POSIX) for the core's parser and writer in the browser (vite.config.ts aliases it; vfs.ts is its `node:fs`). */
function normalizeParts(parts: string[], absolute: boolean): string[] {
  const out: string[] = [];
  for (const s of parts) {
    if (!s || s === '.') continue;
    if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!absolute) out.push('..'); }
    else out.push(s);
  }
  return out;
}
export const sep = '/';
export function normalize(p: string): string {
  const abs = p.startsWith('/');
  const r = normalizeParts(p.split('/'), abs).join('/');
  return (abs ? '/' : '') + r || (abs ? '/' : '.');
}
export function join(...ps: string[]): string { return normalize(ps.filter(Boolean).join('/')); }
export function resolve(...ps: string[]): string {
  let r = '';
  for (const p of ps) { if (!p) continue; r = p.startsWith('/') ? p : `${r}/${p}`; }
  return normalize(r.startsWith('/') ? r : '/' + r);
}
export function dirname(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i);
}
export function basename(p: string, ext?: string): string {
  let b = p.replace(/\/+$/, '').split('/').pop() ?? '';
  if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
  return b;
}
export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}
export function relative(from: string, to: string): string {
  const a = resolve(from).split('/').filter(Boolean), b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
export function isAbsolute(p: string): boolean { return p.startsWith('/'); }
export const posix = { sep, normalize, join, resolve, dirname, basename, extname, relative, isAbsolute };
export default posix;
