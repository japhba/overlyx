/**
 * File operations below a directory that untrusted code writes into: a document's build directory
 * (the LaTeX sandbox's working directory — a project's `latexmkrc` is Perl) and the agent panel's
 * working copy (the agent runs commands there). Whatever runs there can turn any file or directory
 * below it into a symlink at any moment, and the server runs as root: following such a link would
 * read or write any file on the host — `/proc/self/environ` holds every secret of the server.
 *
 * So every operation here walks the path one component at a time from an open directory, refuses
 * symlinks on the way (O_NOFOLLOW) and works on what it opened: on Linux `/proc/self/fd/<fd>/<name>`
 * resolves `<name>` inside exactly that open directory (what openat does), so a link swapped in
 * between a check and a use changes nothing. `root` itself must be a directory nothing untrusted
 * can replace (the build directory and the working copy are mount points / roots of their sandbox;
 * their parents are the server's own). Elsewhere (macOS, for tests) the same checks run on paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY } = fs.constants;
const PROC_FD = (() => { try { return fs.statSync('/proc/self/fd').isDirectory() ? '/proc/self/fd' : null; } catch { return null; } })();

/** an open directory below the root: its descriptor, and its path for the systems without /proc */
interface Dir { fd: number; path: string }
const at = (d: Dir, name: string) => PROC_FD ? `${PROC_FD}/${d.fd}/${name}` : path.join(d.path, name);
const self = (d: Dir) => PROC_FD ? `${PROC_FD}/${d.fd}` : d.path;
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

function parts(rel: string): string[] {
  const p = rel.split(/[\\/]+/).filter(s => s && s !== '.');
  if (p.some(s => s === '..')) throw new Error(`path leaves its directory: ${rel}`);
  return p;
}

/**
 * The directory `dirs` below `root`, opened. `create`: missing directories are made, and a symlink
 * or file where a directory belongs is removed first (the link, never what it points to).
 * Throws when a component is a symlink (or not a directory) and `create` is off.
 */
function openDir(root: string, dirs: string[], create: boolean): Dir {
  let d: Dir = { fd: fs.openSync(root, O_RDONLY | O_DIRECTORY), path: root };
  try {
    for (const name of dirs) {
      let fd: number;
      try { fd = fs.openSync(at(d, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW); }
      catch (e) {
        const c = code(e);
        if (!create || (c !== 'ENOENT' && c !== 'ELOOP' && c !== 'ENOTDIR')) throw e;
        if (c !== 'ENOENT') removeAt(d, name);
        try { fs.mkdirSync(at(d, name)); } catch (e2) { if (code(e2) !== 'EEXIST') throw e2; }
        fd = fs.openSync(at(d, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      }
      fs.closeSync(d.fd);
      d = { fd, path: path.join(d.path, name) };
    }
    return d;
  } catch (e) { fs.closeSync(d.fd); throw e; }
}

/** Remove `name` in `d` — a file, a link, or a directory with everything in it — never following a link. */
function removeAt(d: Dir, name: string): void {
  let st: fs.Stats;
  try { st = fs.lstatSync(at(d, name)); } catch { return; }
  if (!st.isDirectory()) { try { fs.unlinkSync(at(d, name)); } catch { /* gone */ } return; }
  let sub: Dir;
  try { sub = { fd: fs.openSync(at(d, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW), path: path.join(d.path, name) }; }
  catch { try { fs.unlinkSync(at(d, name)); } catch { /* gone */ } return; }   // became a link meanwhile
  try { for (const n of fs.readdirSync(self(sub))) removeAt(sub, n); }
  finally { fs.closeSync(sub.fd); }
  try { fs.rmdirSync(at(d, name)); } catch { /* written to meanwhile, or gone */ }
}

/** Run `f` with the parent directory of `rel` opened (null: it is missing, or a link is on the way). */
function inParent<T>(root: string, rel: string, create: boolean, f: (d: Dir, name: string) => T): T | null {
  const p = parts(rel);
  const name = p.pop();
  if (!name) throw new Error(`no file name: ${rel}`);
  let d: Dir;
  try { d = openDir(root, p, create); } catch (e) { if (create) throw e; return null; }
  try { return f(d, name); } finally { fs.closeSync(d.fd); }
}

/** The regular file `rel` below `root`, opened for reading — null when it is missing, a link, below a link, or not a regular file. The caller closes `fd`. */
export function openFileIn(root: string, rel: string): { fd: number; stat: fs.Stats } | null {
  return inParent(root, rel, false, (d, name) => {
    let fd: number;
    try { fd = fs.openSync(at(d, name), O_RDONLY | O_NOFOLLOW); } catch { return null; }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) { fs.closeSync(fd); return null; }
    return { fd, stat };
  });
}

/** The contents of the regular file `rel` below `root` (null as openFileIn; also when it is larger than `maxBytes`). */
export function readFileIn(root: string, rel: string, maxBytes = Infinity): Buffer | null {
  const f = openFileIn(root, rel);
  if (!f) return null;
  try { return f.stat.size > maxBytes ? null : fs.readFileSync(f.fd); } finally { fs.closeSync(f.fd); }
}

export function readTextIn(root: string, rel: string, maxBytes = Infinity): string | null {
  return readFileIn(root, rel, maxBytes)?.toString('utf8') ?? null;
}

/** What `rel` below `root` is, the entry itself (a link is not followed) — null when it is missing or below a link. */
export function lstatIn(root: string, rel: string): fs.Stats | null {
  return inParent(root, rel, false, (d, name) => { try { return fs.lstatSync(at(d, name)); } catch { return null; } });
}

/** Where the link `rel` below `root` points — null when it is not a link (or is below one). */
export function readlinkIn(root: string, rel: string): string | null {
  return inParent(root, rel, false, (d, name) => { try { return fs.readlinkSync(at(d, name)); } catch { return null; } });
}

/** The entries of the directory `rel` below `root` (empty when it is missing, a link or below one). */
export function listIn(root: string, rel: string): string[] {
  let d: Dir;
  try { d = openDir(root, parts(rel), false); } catch { return []; }
  try { return fs.readdirSync(self(d)); } finally { fs.closeSync(d.fd); }
}

/**
 * Write the file `rel` below `root` (atomically: a new file renamed into place), making its
 * directories as real directories — a link in the way is removed, never written through.
 * `mtime` keeps a copied file's modification time (the svg package compares them).
 */
export function writeFileIn(root: string, rel: string, data: string | Buffer, opts: { mtime?: Date } = {}): void {
  fs.mkdirSync(root, { recursive: true });
  inParent(root, rel, true, (d, name) => {
    const tmp = `${name}.overlyx-tmp`;
    removeAt(d, tmp);
    const fd = fs.openSync(at(d, tmp), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
    try {
      fs.writeFileSync(fd, data);
      if (opts.mtime) fs.futimesSync(fd, opts.mtime, opts.mtime);
    } finally { fs.closeSync(fd); }
    // rename replaces whatever is at `name` — a link included — without following it; a directory there goes first
    try { if (fs.lstatSync(at(d, name)).isDirectory()) removeAt(d, name); } catch { /* new */ }
    fs.renameSync(at(d, tmp), at(d, name));
  });
}

/** Make `rel` below `root` a symlink to `target`, replacing what is there. */
export function symlinkIn(root: string, rel: string, target: string): void {
  fs.mkdirSync(root, { recursive: true });
  inParent(root, rel, true, (d, name) => {
    removeAt(d, name);
    fs.symlinkSync(target, at(d, name));
  });
}

/** Remove `rel` below `root` (a directory with everything in it) — links are removed, never followed. */
export function removeIn(root: string, rel: string): void {
  inParent(root, rel, false, (d, name) => removeAt(d, name));
}

/**
 * res.sendFile of the regular file `rel` below `root` (ranges, ETag and all) — false, and nothing
 * sent, when it is not one. The file is opened here and sent through its descriptor, so swapping a
 * link in afterwards does not change what is sent. Set Content-Type first when the name's
 * extension does not say it.
 */
export function sendFileIn(res: Response, root: string, rel: string, opts: { lastModified?: boolean } = {}): boolean {
  const f = openFileIn(root, rel);
  if (!f) return false;
  if (!res.getHeader('Content-Type')) res.type(path.extname(rel) || 'application/octet-stream');
  if (!PROC_FD) { fs.closeSync(f.fd); res.sendFile(path.resolve(root, rel), opts); return true; }
  // express calls back exactly once — sent, failed or aborted — and only then is the descriptor free
  res.sendFile(`${PROC_FD}/${f.fd}`, opts, err => {
    fs.closeSync(f.fd);
    if (err && !res.headersSent) res.status((err as { status?: number }).status ?? 500).end();
  });
  return true;
}

/** sendFileIn for a file named by its full path, whose directory is one nothing untrusted can replace (a build directory). */
export function sendFileAt(res: Response, file: string, opts: { lastModified?: boolean } = {}): boolean {
  return sendFileIn(res, path.dirname(file), path.basename(file), opts);
}

/** readFileIn for a file named by its full path (see sendFileAt). */
export function readFileAt(file: string, maxBytes = Infinity): Buffer | null {
  return readFileIn(path.dirname(file), path.basename(file), maxBytes);
}

/** Whether `file` is a regular file — not a link to one (see sendFileAt). */
export function isRegularFileAt(file: string): boolean {
  return lstatIn(path.dirname(file), path.basename(file))?.isFile() ?? false;
}
