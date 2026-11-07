// Runs OverLyX's TeX engines (tex-wasm/: pdfTeX, LuaHBTeX, XeTeX with bibtex8, makeindex and, for
// XeTeX, xdvipdfmx) for the PDF builds of end-to-end encrypted projects. One program per message, each
// in a fresh instance of its engine's module (TeX does not reset its globals); the compiled module is
// kept. The project's files come with the message and the files the program wrote go back with the
// reply: nothing of the project leaves the browser. TeX Live's own files are fetched from the server
// one at a time as the engine asks for them (the server's e2e/texlive.ts), synchronously — this is a
// worker — and kept for the next runs; only names in TeX Live's list of its files are asked for.
//
// Messages: { id, cmd: 'run', engine, texlive, program, args, cwd, files: [[path, bytes|string]], env }
// → { id, code, out, files: [[path, Uint8Array]] }, the files under /work the run wrote; or { id, error }.
'use strict';

const BASE = new URL('.', self.location.href).href;
/** kpathsea's names for an engine's programs: the server looks files up as these */
const PROGNAME = { pdftex: 'pdflatex', luahbtex: 'lualatex', xetex: 'xelatex' };
/** formats never fetched: a format must come from this engine build (the worker is given it) */
const NEVER = new Set([5, 8, 9, 10, 12]);   // base, cnf, ls-R, fmt, mem

const modules = new Map();   // engine → Promise<{ factory, wasm }>
const fetched = new Map();   // `${texlive}|${prog}|${format}/${name}` → { name, data } | null
const kept = new Map();      // engine → [[path, bytes]]: what its runs wrote below /texlive/var (luaotfload's font cache)
const fontNames = new Map(); // texlive URL → Promise<Uint8Array | null>: luaotfload's index of TeX Live's fonts
const indexes = new Map();   // texlive URL → Promise<Set<string>>: the names of TeX Live's files
/** what kpathsea may add to a name it looks for (its formats' suffixes) */
const SUFFIXES = ['.tex', '.sty', '.cls', '.fd', '.def', '.clo', '.ldf', '.cfg', '.ltx', '.bbx', '.cbx', '.lbx', '.dbx', '.tfm', '.ofm', '.vf', '.ovf',
  '.pfb', '.pfa', '.otf', '.ttf', '.ttc', '.afm', '.enc', '.map', '.lua', '.luc', '.texlua', '.ist', '.bst', '.bib', '.tcx', '.fea', '.sfd', '.lig', '.pro', '.cmap'];
let texmfCnf = null;
/** luaotfload: TeX Live's fonts only, from the index the server made (the server's e2e/texlive.ts LUAOTFLOAD_CONF) */
const LUAOTFLOAD_CONF = '[db]\nlocation-precedence = texmf\nupdate-live = false\nformats = otf,ttf,ttc\n';
const NAMES = '/texlive/var/luatex-cache/generic/names/luaotfload-names.lua.gz';

/**
 * The names of TeX Live's files (the server's ls-R): only these are asked for. A name of the
 * project's own that is not there yet (main.aux before the first run, what an \IfFileExists looks
 * for) never goes to the server, which would learn what the project's files are called.
 */
function indexOf(texlive) {
  let p = indexes.get(texlive);
  if (!p) {
    p = fetch(texlive + '/names.txt').then(r => { if (!r.ok) throw new Error('TeX Live\'s file list could not be loaded (' + r.status + ')'); return r.text(); })
      .then(t => new Set(t.split('\n')));
    p.catch(() => indexes.delete(texlive));
    indexes.set(texlive, p);
  }
  return p;
}

function namesOf(texlive) {
  let p = fontNames.get(texlive);
  if (!p) {
    p = fetch(texlive + '/luaotfload-names.lua.gz').then(r => r.ok ? r.arrayBuffer().then(b => new Uint8Array(b)) : null).catch(() => null);
    fontNames.set(texlive, p);
  }
  return p;
}

function engineModule(engine) {
  let m = modules.get(engine);
  if (!m) {
    m = (async () => {
      importScripts(BASE + engine + '.js');
      const factory = self[engine];
      if (typeof factory !== 'function') throw new Error('engine ' + engine + ' did not load');
      const res = fetch(BASE + engine + '.wasm');
      const wasm = await (WebAssembly.compileStreaming ? WebAssembly.compileStreaming(res) : res.then(r => r.arrayBuffer()).then(b => WebAssembly.compile(b)));
      if (!texmfCnf) texmfCnf = new Uint8Array(await (await fetch(BASE + 'texmf.cnf')).arrayBuffer());
      return { factory, wasm };
    })();
    m.catch(() => modules.delete(engine));
    modules.set(engine, m);
  }
  return m;
}

/** TeX Live's file `name` of kpathsea format `format`, from the server (a synchronous request) */
function texliveFile(texlive, index, prog, name, format) {
  if (NEVER.has(format)) return null;
  if (!index.has(name) && !SUFFIXES.some(s => index.has(name + s))) return null;
  const key = texlive + '|' + prog + '|' + format + '/' + name;
  if (fetched.has(key)) return fetched.get(key);
  let file = null;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', texlive + '/' + prog + '/' + format + '/' + encodeURIComponent(name), false);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    if (xhr.status === 200 && xhr.response) file = { name: xhr.getResponseHeader('X-TeX-File') || name, data: new Uint8Array(xhr.response) };
  } catch (e) { file = null; }
  fetched.set(key, file);
  return file;
}

function mkdirs(FS, path) {
  const parts = path.split('/').filter(Boolean);
  let p = '';
  for (const part of parts) { p += '/' + part; try { FS.mkdir(p); } catch (e) { /* there */ } }
}

/** every file under `dir` written at or after `since` */
function written(FS, dir, since, out) {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = dir + '/' + name;
    const st = FS.stat(path);
    if (FS.isDir(st.mode)) written(FS, path, since, out);
    else if (st.mtime.getTime() >= since) out.push([path.startsWith('/work/') ? path.slice('/work/'.length) : path, FS.readFile(path)]);
  }
  return out;
}

async function run(msg) {
  const { factory, wasm } = await engineModule(msg.engine);
  const prog = PROGNAME[msg.engine];
  const index = await indexOf(msg.texlive);
  const names = msg.engine === 'luahbtex' ? await namesOf(msg.texlive) : null;
  const out = [];
  const Module = await factory({
    thisProgram: msg.program,
    instantiateWasm(imports, done) { WebAssembly.instantiate(wasm, imports).then(inst => done(inst, wasm)); return {}; },
    print: s => { out.push(s); }, printErr: s => { out.push(s); },
    texliveFile: (name, format) => texliveFile(msg.texlive, index, prog, name, format),
    preRun: [M => {
      Object.assign(M.ENV, {
        TEXMFCNF: '/texlive/web2c', TEXMFVAR: '/texlive/var', TEXMFCACHE: '/texlive/var', TEXFORMATS: '/texlive/fmt',
        // nothing to make missing fonts or files with: kpathsea asks the server instead
        MKTEXTEX: '0', MKTEXTFM: '0', MKTEXPK: '0', MKTEXMF: '0', MKOCP: '0', MKOFM: '0',
        HOME: '/texlive/home', XDG_CONFIG_HOME: '/texlive/config',
        openin_any: 'p', openout_any: 'p', shell_escape: 'f', max_print_line: '1000',
      }, msg.env || {});
    }],
  });
  const FS = Module.FS;
  for (const d of ['/texlive/web2c', '/texlive/var', '/texlive/fmt', '/texlive/home', '/texlive/config/luaotfload']) mkdirs(FS, d);
  FS.writeFile('/texlive/web2c/texmf.cnf', texmfCnf);
  if (names) {
    mkdirs(FS, NAMES.slice(0, NAMES.lastIndexOf('/')));
    FS.writeFile(NAMES, names);
    FS.writeFile('/texlive/config/luaotfload/luaotfload.conf', LUAOTFLOAD_CONF);
  }
  for (const [path, data] of kept.get(msg.engine) || []) { mkdirs(FS, path.slice(0, path.lastIndexOf('/'))); FS.writeFile(path, data); }
  for (const [path, data] of msg.files) {
    const abs = path.startsWith('/') ? path : '/work/' + path;
    mkdirs(FS, abs.slice(0, abs.lastIndexOf('/')));
    FS.writeFile(abs, data);
  }
  mkdirs(FS, '/work/' + (msg.cwd || ''));
  FS.chdir('/work/' + (msg.cwd || ''));
  const since = Date.now();
  let code;
  try { code = Module.callMain([msg.program, ...msg.args]); }
  catch (e) { code = typeof e?.status === 'number' ? e.status : 1; out.push(String(e?.message ?? e)); }
  try { Module._flush_streams(); } catch (e) { /* gone with the run */ }
  const files = written(FS, '/work', since, []);
  const cache = new Map(kept.get(msg.engine) || []);
  for (const [path, data] of written(FS, '/texlive/var', since, [])) if (path !== NAMES) cache.set(path, data);
  kept.set(msg.engine, [...cache]);
  return { code, out: out.join('\n'), files };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.cmd !== 'run') return;
  try {
    const r = await run(msg);
    self.postMessage({ id: msg.id, ...r }, r.files.map(([, d]) => d.buffer));
  } catch (e) {
    self.postMessage({ id: msg.id, error: String(e?.message ?? e) });
  }
};
