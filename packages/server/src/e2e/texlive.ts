/**
 * What the browser-side TeX engine of an end-to-end encrypted project needs from the server, all of
 * it public and the same for everybody (no document content goes either way):
 *
 *  - TeX Live's files, one at a time as the engine asks for them (`<program>/<format>/<name>`:
 *    `format` is kpathsea's file format number, `program` the name kpathsea searches as —
 *    pdflatex, lualatex or xelatex; the engines are built by tex-wasm/ from the sources of this
 *    TeX Live release). Looked up with kpsewhich, run in an empty directory, and served only when
 *    the file lies inside a TeX Live tree — never the server's own files. The engine asks only for
 *    names in TeX Live's list of its files (`texliveNames`), never for one of the project's: the
 *    server learns which packages and fonts a document loads, not what it says or what its files
 *    are called (DOCS.md says so).
 *  - luaotfload's index of TeX Live's fonts, for LuaLaTeX's fonts by name (`luaotfloadNames`).
 *  - LyX's library (layouts, modules, symbols, languages), which the document parser reads, as one
 *    bundle (`lyxlibBundle`).
 *
 * Both carry a version in their URL (TeX Live's latex.ltx, the library's content): the browser keeps
 * them, and the LaTeX format it builds from them, until the version changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.ts';

const run = promisify(execFile);

/** kpathsea's file formats, in the order of its enum (`kpsewhich --help-formats`) */
const FORMATS = ['gf', 'pk', 'bitmap font', 'tfm', 'afm', 'base', 'bib', 'bst', 'cnf', 'ls-R', 'fmt', 'map', 'mem', 'mf', 'mfpool', 'mft', 'mp', 'mppool', 'MetaPost support', 'ocp', 'ofm', 'opl', 'otp', 'ovf', 'ovp', 'graphic/figure', 'tex', 'TeX system documentation', 'texpool', 'TeX system sources', 'PostScript header', 'Troff fonts', 'type1 fonts', 'vf', 'dvips config', 'ist', 'truetype fonts', 'type42 fonts', 'web2c files', 'other text files', 'other binary files', 'misc fonts', 'web', 'cweb', 'enc files', 'cmap files', 'subfont definition files', 'opentype fonts', 'pdftex config', 'lig files', 'texmfscripts', 'lua', 'font feature files', 'cid maps', 'mlbib', 'mlbst', 'clua', 'ris', 'bltxml'];
/** formats a document never needs, that only describe the installation, or (formats) that only this server's engines can load */
const REFUSED = new Set(['cnf', 'ls-R', 'TeX system documentation', 'TeX system sources', 'texmfscripts', 'Troff fonts', 'fmt', 'base', 'mem']);
/** the names the engines search as (kpathsea's program name: TEXINPUTS.lualatex, …) */
export const TEX_PROGRAMS = new Set(['pdflatex', 'lualatex', 'xelatex']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

/** an empty directory to run kpsewhich in: TEXMFDOTDIR ('.') must not find the server's own files */
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-kpse-'));

let roots: string[] | null = null;
/** the TeX Live trees (real paths) a served file must lie in, and the distribution's fonts they link to */
function texRoots(): string[] {
  if (roots) return roots;
  const out = new Set<string>();
  for (const v of ['TEXMFDIST', 'TEXMFMAIN', 'TEXMFLOCAL', 'TEXMFSYSVAR', 'TEXMFSYSCONFIG', 'TEXMFDEBIAN']) {
    try {
      for (const p of execFileSync('kpsewhich', [`-var-value=${v}`], { encoding: 'utf8', cwd: emptyDir }).trim().split(/[:;]/)) {
        if (p && path.isAbsolute(p)) { try { out.add(fs.realpathSync(p)); } catch { /* missing */ } }
      }
    } catch { /* no TeX Live */ }
  }
  // Debian links fonts of its TeX Live packages to the system's font packages (/usr/share/fonts)
  try { out.add(fs.realpathSync('/usr/share/fonts')); } catch { /* none */ }
  return roots = [...out];
}

let version: string | null = null;
/** TeX Live's version as far as a LaTeX format built from it is concerned */
export function texliveVersion(): string {
  if (version) return version;
  try {
    const ltx = execFileSync('kpsewhich', ['latex.ltx'], { encoding: 'utf8', cwd: emptyDir }).trim();
    const h = crypto.createHash('sha1').update(fs.readFileSync(ltx));
    for (const f of ['pdftexconfig.tex', 'language.dat', 'hyphen.cfg', 'pdftex.map']) {
      try { const p = execFileSync('kpsewhich', [f], { encoding: 'utf8', cwd: emptyDir }).trim(); if (p) h.update(f).update(String(fs.statSync(p).size)).update(String(fs.statSync(p).mtimeMs)); } catch { /* none */ }
    }
    version = h.digest('hex').slice(0, 12);
  } catch { version = 'none'; }
  return version;
}

let namesIndex: { version: string; gz: Buffer } | null = null;

/**
 * The names of TeX Live's files (from kpathsea's ls-R databases), one a line: the browser's engine
 * asks the server only for a name in it — never for a name of the project's own (main.aux before the
 * first run made it, a file an \IfFileExists looks for), which would tell the server what the
 * project's files are called. Gzipped; about half a megabyte.
 */
export function texliveNames(): Buffer {
  const ver = texliveVersion();
  if (namesIndex?.version === ver) return namesIndex.gz;
  const names = new Set<string>();
  let dbs: string[] = [];
  try { dbs = execFileSync('kpsewhich', ['--show-path=ls-R'], { encoding: 'utf8', cwd: emptyDir }).trim().split(/[:;]/); } catch { /* no TeX Live */ }
  for (const d of dbs) {
    let text: string;
    try { text = fs.readFileSync(path.join(d, 'ls-R'), 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) if (l && !l.endsWith(':') && NAME.test(l)) names.add(l);
  }
  namesIndex = { version: ver, gz: zlib.gzipSync([...names].sort().join('\n') + '\n', { level: 9 }) };
  return namesIndex.gz;
}

const found = new Map<string, string | null>();

/** The TeX Live file the engine running as `program` asks for: its path, or null. */
export async function texliveFile(program: string, format: number, name: string): Promise<string | null> {
  const f = FORMATS[format];
  if (!TEX_PROGRAMS.has(program) || !f || REFUSED.has(f) || !NAME.test(name)) return null;
  const key = `${program}/${format}/${name}`;
  if (found.has(key)) return found.get(key)!;
  let p: string | null = null;
  try {
    const r = await run('kpsewhich', [`-format=${f}`, `-progname=${program}`, name], { cwd: emptyDir, encoding: 'utf8', timeout: 10000 });
    const hit = r.stdout.trim().split('\n')[0];
    if (hit && path.isAbsolute(hit)) {
      const real = fs.realpathSync(hit);
      if (texRoots().some(r => real.startsWith(r + path.sep)) && fs.statSync(real).isFile()) p = real;
    }
  } catch { /* not found (kpsewhich exits 1) */ }
  if (found.size > 50000) found.clear();
  found.set(key, p);
  return p;
}

/* -------------------------------------------------------------- luaotfload's font names */

/** what luaotfload in the browser reads: TeX Live's fonts only (the server's own it could not fetch), no rescans */
export const LUAOTFLOAD_CONF = '[db]\nlocation-precedence = texmf\nupdate-live = false\nformats = otf,ttf,ttc\n';
const namesMemo = new Map<string, Promise<Buffer | null>>();

/**
 * luaotfload's index of TeX Live's fonts by name (luaotfload-names.lua.gz): LuaLaTeX in the browser
 * finds `\setmainfont{TeX Gyre Pagella}` through it, then the font's file through the files above.
 * Made with luaotfload-tool once per TeX Live version, into the data directory — TEXMFCACHE and
 * TEXMFVAR point there, so the system's own index (which the server's builds use) stays as it is.
 */
export function luaotfloadNames(): Promise<Buffer | null> {
  const ver = texliveVersion();
  let p = namesMemo.get(ver);
  if (!p) {
    p = (async () => {
      const dir = path.join(config.dataDir, 'cache', 'e2e-texlive', ver);
      const file = path.join(dir, 'var', 'luatex-cache', 'generic', 'names', 'luaotfload-names.lua.gz');
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.join(dir, 'config', 'luaotfload'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'config', 'luaotfload', 'luaotfload.conf'), LUAOTFLOAD_CONF);
        await run('luaotfload-tool', ['--update', '--force'], {
          cwd: emptyDir, timeout: 600000,
          env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'), TEXMFVAR: path.join(dir, 'var'), TEXMFCACHE: path.join(dir, 'var') },
        });
      }
      return fs.readFileSync(file);
    })();
    p.catch(() => namesMemo.delete(ver));
    namesMemo.set(ver, p);
  }
  return p.catch(() => null);
}

/* ------------------------------------------------------------------- LyX's library */

let bundle: { version: string; gz: Buffer; json: Buffer } | null = null;

/** LyX's library as the parser reads it: `{ files: { "layouts/article.layout": "…", "unicodesymbols": "…", … } }` */
export function lyxlibBundle(): { version: string; gz: Buffer; json: Buffer } {
  if (bundle) return bundle;
  const lib = path.resolve(config.layoutDir, '..');
  const files: Record<string, string> = {};
  const add = (rel: string) => { try { files[rel] = fs.readFileSync(path.join(lib, rel), 'utf8'); } catch { /* missing */ } };
  for (const f of ['unicodesymbols', 'languages', 'latexfonts', 'symbols']) add(f);
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(lib, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(layout|inc|module)$/.test(e.name)) add(rel);
    }
  };
  walk('layouts');
  const json = Buffer.from(JSON.stringify({ files }));
  return bundle = { version: crypto.createHash('sha1').update(json).digest('hex').slice(0, 12), json, gz: zlib.gzipSync(json, { level: 9 }) };
}
