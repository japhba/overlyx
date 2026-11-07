// `make check`: the engines in dist/ build their LaTeX formats and compile a test document, with
// TeX Live's files from this machine's TeX Live (kpsewhich) — what the server serves the browser.
//
//   node check.mjs [pdftex|luahbtex|xetex ...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DIST = path.join(path.dirname(new URL(import.meta.url).pathname), 'dist');
const FORMATS = ['gf', 'pk', 'bitmap font', 'tfm', 'afm', 'base', 'bib', 'bst', 'cnf', 'ls-R', 'fmt', 'map', 'mem', 'mf', 'mfpool', 'mft', 'mp', 'mppool', 'MetaPost support', 'ocp', 'ofm', 'opl', 'otp', 'ovf', 'ovp', 'graphic/figure', 'tex', 'TeX system documentation', 'texpool', 'TeX system sources', 'PostScript header', 'Troff fonts', 'type1 fonts', 'vf', 'dvips config', 'ist', 'truetype fonts', 'type42 fonts', 'web2c files', 'other text files', 'other binary files', 'misc fonts', 'web', 'cweb', 'enc files', 'cmap files', 'subfont definition files', 'opentype fonts', 'pdftex config', 'lig files', 'texmfscripts', 'lua', 'font feature files', 'cid maps', 'mlbib', 'mlbst', 'clua', 'ris', 'bltxml'];
const ENGINES = {
  pdftex: { prog: 'pdflatex', ini: ['-ini', '-jobname=pdflatex', '-progname=pdflatex', '-translate-file=cp227.tcx', '*pdflatex.ini'] },
  luahbtex: { prog: 'lualatex', ini: ['-ini', '-jobname=lualatex', '-progname=lualatex', 'lualatex.ini'] },
  xetex: { prog: 'xelatex', ini: ['-ini', '-jobname=xelatex', '-progname=xelatex', '-etex', 'xelatex.ini'] },
};
const empty = fs.mkdtempSync('/tmp/texwasm-kpse-');
let asked = 0;
const NAMES = '/texlive/var/luatex-cache/generic/names/luaotfload-names.lua.gz';
const LUAOTFLOAD_CONF = '[db]\nlocation-precedence = texmf\nupdate-live = false\nformats = otf,ttf,ttc\n';

/** luaotfload's index of this TeX Live's fonts, made as the server makes it (server e2e/texlive.ts) */
function fontNames() {
  const d = fs.mkdtempSync('/tmp/texwasm-names-');
  fs.mkdirSync(path.join(d, 'config/luaotfload'), { recursive: true });
  fs.writeFileSync(path.join(d, 'config/luaotfload/luaotfload.conf'), LUAOTFLOAD_CONF);
  execFileSync('luaotfload-tool', ['--update', '--force'], { cwd: empty, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: d, XDG_CONFIG_HOME: path.join(d, 'config'), TEXMFVAR: path.join(d, 'var'), TEXMFCACHE: path.join(d, 'var') } });
  return fs.readFileSync(path.join(d, 'var/luatex-cache/generic/names/luaotfload-names.lua.gz'));
}

// the names of TeX Live's files and the suffixes kpathsea adds: what the worker asks the server for
// (packages/client/public/texwasm/worker.js), so a file the rule would hide makes the check fail
const SUFFIXES = ['.tex', '.sty', '.cls', '.fd', '.def', '.clo', '.ldf', '.cfg', '.ltx', '.bbx', '.cbx', '.lbx', '.dbx', '.tfm', '.ofm', '.vf', '.ovf',
  '.pfb', '.pfa', '.otf', '.ttf', '.ttc', '.afm', '.enc', '.map', '.lua', '.luc', '.texlua', '.ist', '.bst', '.bib', '.tcx', '.fea', '.sfd', '.lig', '.pro', '.cmap'];
const index = new Set();
for (const d of execFileSync('kpsewhich', ['--show-path=ls-R'], { encoding: 'utf8' }).trim().split(':')) {
  try { for (const l of fs.readFileSync(path.join(d, 'ls-R'), 'utf8').split('\n')) if (l && !l.endsWith(':')) index.add(l); } catch { /* none */ }
}
const hidden = new Set();

const got = new Map();   // kept for the next runs, as the worker keeps them
function texliveFile(prog, name, format) {
  if ([5, 8, 9, 10, 12].includes(format)) return null;
  if (!index.has(name) && !SUFFIXES.some(s => index.has(name + s))) { hidden.add(name); return null; }
  const key = `${prog}|${format}/${name}`;
  if (got.has(key)) return got.get(key);
  asked++;
  let file = null;
  try {
    const hit = execFileSync('kpsewhich', [`-format=${FORMATS[format]}`, `-progname=${prog}`, name], { cwd: empty, encoding: 'utf8' }).trim().split('\n')[0];
    if (hit) file = { name: path.basename(hit), data: fs.readFileSync(hit) };
  } catch { /* not there */ }
  got.set(key, file);
  return file;
}

/** an engine's module factory: the .js is CommonJS, which the repository's "type": "module" would not let require() see */
const factories = new Map();
function factoryOf(engine) {
  if (!factories.has(engine)) {
    const file = path.join(DIST, engine + '.js');
    const module = { exports: {} };
    new Function('module', 'exports', 'require', '__filename', '__dirname', fs.readFileSync(file, 'utf8'))(module, module.exports, require, file, DIST);
    factories.set(engine, module.exports);
  }
  return factories.get(engine);
}

/** BusyTeX's name of a program's code where it differs (the program keeps its name: kpathsea's progname) */
const APPLET = { lualatex: 'luahbtex' };

let names = null;
async function run(engine, program, args, files, cwd = '') {
  const factory = factoryOf(engine);
  const out = [];
  const M = await factory({
    thisProgram: '/texlive/bin/' + program, print: s => out.push(s), printErr: s => out.push(s),
    texliveFile: (name, format) => texliveFile(ENGINES[engine].prog, name, format),
    preRun: [m => Object.assign(m.ENV, { TEXMFCNF: '/texlive/web2c', TEXMFVAR: '/texlive/var', TEXMFCACHE: '/texlive/var', TEXFORMATS: '/texlive/fmt', MKTEXTEX: '0', MKTEXTFM: '0', MKTEXPK: '0', MKTEXMF: '0', HOME: '/texlive/home', XDG_CONFIG_HOME: '/texlive/config', openin_any: 'a', openout_any: 'p', shell_escape: 'f' })],
  });
  const FS = M.FS;
  for (const d of ['/texlive', '/texlive/bin', '/texlive/web2c', '/texlive/var', '/texlive/fmt', '/texlive/home', '/texlive/config', '/texlive/config/luaotfload', '/work']) try { FS.mkdir(d); } catch { /* there */ }
  FS.writeFile('/texlive/bin/' + program, '');   // kpathsea finds its own directory from the program's file (SELFAUTOLOC)
  if (engine === 'luahbtex') {
    let p = '';
    for (const part of path.dirname(NAMES).split('/').filter(Boolean)) { p += '/' + part; try { FS.mkdir(p); } catch { /* there */ } }
    FS.writeFile(NAMES, names ??= fontNames());
    FS.writeFile('/texlive/config/luaotfload/luaotfload.conf', LUAOTFLOAD_CONF);
  }
  FS.writeFile('/texlive/web2c/texmf.cnf', fs.readFileSync(path.join(DIST, 'texmf.cnf')));
  for (const [p, d] of Object.entries(files)) FS.writeFile(p.startsWith('/') ? p : '/work/' + p, d);
  FS.chdir('/work/' + cwd);
  const t = Date.now();
  let code;
  try { code = M.callMain([APPLET[program] ?? program, ...args]); } catch (e) { code = e?.status ?? 1; out.push(String(e)); }
  const outFiles = {};
  for (const n of FS.readdir('/work')) if (n !== '.' && n !== '..' && FS.isFile(FS.stat('/work/' + n).mode)) outFiles[n] = FS.readFile('/work/' + n);
  return { code, out: out.join('\n'), files: outFiles, ms: Date.now() - t };
}

const DOC = String.raw`\documentclass{article}
%FONTS%
\usepackage{amsmath,hyperref,graphicx,xcolor}
\usepackage{tikz}
\begin{document}
\section{Hello}\label{s}
Section~\ref{s}, $\int_0^1 x^2\,dx = \frac13$, a citation~\cite{knuth}.
\begin{tikzpicture}\draw[red] (0,0) circle (1);\end{tikzpicture}
\bibliographystyle{plain}\bibliography{refs}
\end{document}
`;
const BIB = '@book{knuth, author={Donald E. Knuth}, title={The {\\TeX}book}, publisher={Addison-Wesley}, year={1984}}\n';

for (const engine of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ENGINES)) {
  const e = ENGINES[engine];
  asked = 0;
  const fmt = await run(engine, e.prog, e.ini, {});
  const fmtFile = fmt.files[e.prog + '.fmt'];
  console.log(`${engine}: format ${fmt.code === 0 && fmtFile ? 'built' : 'FAILED'} in ${fmt.ms} ms, ${fmtFile ? (fmtFile.length / 1e6).toFixed(1) + ' MB' : '-'}, ${asked} files asked for`);
  if (!fmtFile) { console.log(fmt.out.slice(-3000)); process.exitCode = 1; continue; }
  // LuaLaTeX: a font by name, through luaotfload's index and kpathsea (Latin Modern's OpenType files
  // come with every TeX Live: fonts-lmodern on Debian and Ubuntu)
  const doc = DOC.replace('%FONTS%', engine === 'luahbtex' ? '\\usepackage{fontspec}\\setmainfont{Latin Modern Sans}' : '');
  const files = { [`/texlive/fmt/${e.prog}.fmt`]: fmtFile, 'main.tex': doc, 'refs.bib': BIB };
  const pass = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', ...(engine === 'xetex' ? ['-no-pdf'] : []), 'main.tex'];
  let r = await run(engine, e.prog, pass, files);
  Object.assign(files, r.files);
  const bib = await run(engine, 'bibtex8', ['-8', '-W', 'main'], files);   // as the client runs it (e2e/compile.ts)
  Object.assign(files, bib.files);
  for (let i = 0; i < 2; i++) { r = await run(engine, e.prog, pass, files); Object.assign(files, r.files); }
  const dvi = engine === 'xetex' ? await run(engine, 'xdvipdfmx', ['-q', '-E', '-o', 'main.pdf', 'main.xdv'], files) : null;
  if (dvi) Object.assign(files, dvi.files);
  const pdf = files['main.pdf'];
  const cited = /Knuth/.test(String(Buffer.from(files['main.bbl'] ?? [])));
  const log = String(Buffer.from(files['main.log'] ?? []));
  // fontspec writes the family it made into the log; a font it did not find is an error there
  const fontOk = engine !== 'luahbtex' || (/LatinModernSans\(0\)/.test(log) && !/not (be )?found/i.test(log));
  const ok = r.code === 0 && pdf?.length > 5000 && cited && !!files['main.synctex.gz'] && fontOk;
  if (engine === 'luahbtex') console.log(`luahbtex: Latin Modern Sans by name ${fontOk ? 'in the PDF' : 'MISSING'}`);
  console.log(`${engine}: PDF ${pdf ? (pdf.length / 1e3).toFixed(0) + ' kB' : 'MISSING'} (exit ${r.code}, last pass ${r.ms} ms), bibtex8 exit ${bib.code}, synctex ${files['main.synctex.gz'] ? 'yes' : 'no'}, citation ${cited ? 'resolved' : 'MISSING'}`);
  if (!ok) { console.log(String(Buffer.from(files['main.log'] ?? [])).slice(-2500) || r.out.slice(-2500)); console.log(bib.out.slice(-1000)); if (dvi) console.log(dvi.out.slice(-2000)); process.exitCode = 1; }
  if (pdf) fs.writeFileSync(path.join(DIST, `check-${engine}.pdf`), pdf);
  fs.writeFileSync(path.join(DIST, `check-${engine}.log`), log + '\n---- console ----\n' + r.out);
  console.log(`${engine}: names not in TeX Live (not asked for): ${[...hidden].filter(n => !/^main\./.test(n)).slice(0, 30).join(' ') || '-'}`);
  hidden.clear();
}
