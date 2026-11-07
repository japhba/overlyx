/**
 * PDF builds of end-to-end encrypted projects, in the browser: TeX Live's pdfTeX, LuaHBTeX and XeTeX
 * compiled to WebAssembly from the sources of the server's TeX Live release (tex-wasm/, served from
 * public/texwasm), run by a worker (public/texwasm/worker.js). The project's files are decrypted into
 * the engine's memory and never leave this browser; TeX Live's own files (packages, fonts) come from
 * the server one at a time as the engine asks for them (server e2e/texlive.ts), so the server learns
 * which packages a document loads, nothing more.
 *
 * A build goes as the server's latexmk run does: the engine the document asks for (engineOf, the
 * server's rule), BibTeX and makeindex when the run calls for them, more runs until the references
 * settle, SyncTeX for PDF ⇄ source. Each engine's LaTeX format is built here once per TeX Live
 * version and engine build (a quarter to a whole minute, the first build) and kept in IndexedDB.
 */
import type { E2eProject } from './project';
import { isMarkdownPath, headerValue } from '@overlyx/core';

export type EngineName = 'pdftex' | 'luahbtex' | 'xetex';
const PROGRAM: Record<EngineName, string> = { pdftex: 'pdflatex', luahbtex: 'lualatex', xetex: 'xelatex' };
/** fmtutil.cnf's lines for the three formats */
const INI: Record<EngineName, string[]> = {
  pdftex: ['-ini', '-jobname=pdflatex', '-progname=pdflatex', '-translate-file=cp227.tcx', '*pdflatex.ini'],
  luahbtex: ['-ini', '-jobname=lualatex', '-progname=lualatex', 'lualatex.ini'],
  xetex: ['-ini', '-jobname=xelatex', '-progname=xelatex', '-etex', 'xelatex.ini'],
};
const WORKER = '/texwasm/worker.js';

interface RunResult { code: number; out: string; files: [string, Uint8Array][] }
type Files = Map<string, Uint8Array | string>;

class Runner {
  private worker: Worker | null = null;
  private waiting = new Map<number, { resolve: (r: RunResult) => void; reject: (e: Error) => void }>();
  private ids = 1;
  private idle: ReturnType<typeof setTimeout> | null = null;

  run(engine: EngineName, texlive: string, program: string, args: string[], files: Files, cwd = '', env: Record<string, string> = {}): Promise<RunResult> {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    if (!this.worker) {
      const w = this.worker = new Worker(WORKER);
      w.onmessage = (ev: MessageEvent<RunResult & { id: number; error?: string }>) => {
        const p = this.waiting.get(ev.data.id);
        if (!p) return;
        this.waiting.delete(ev.data.id);
        if (ev.data.error) p.reject(new Error(ev.data.error)); else p.resolve(ev.data);
      };
      w.onerror = () => { for (const p of this.waiting.values()) p.reject(new Error('The TeX engine could not be loaded')); this.terminate(); };
    }
    const id = this.ids++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker!.postMessage({ id, cmd: 'run', engine, texlive, program, args, cwd, env, files: [...files] });
    });
  }

  release(): void {
    if (this.idle) clearTimeout(this.idle);
    // a loaded engine and the TeX Live files it fetched hold a few hundred MB: let them go after a while unused
    this.idle = setTimeout(() => this.terminate(), 10 * 60 * 1000);
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.waiting.values()) p.reject(new Error('cancelled'));
    this.waiting.clear();
  }
}

const runner = new Runner();
let busy: Promise<unknown> = Promise.resolve();

/* ------------------------------------------------------------------------- versions */

let versionsMemo: Promise<{ texlive: string; engines: string }> | null = null;
/** TeX Live's version (the server's) and the engines' (their release), which a format belongs to */
function versions(): Promise<{ texlive: string; engines: string }> {
  return versionsMemo ??= (async () => {
    const st = await (await fetch('/api/e2e/status', { credentials: 'same-origin' })).json() as { texlive: string };
    const eng = await (await fetch('/texwasm/engines.json')).json() as { release: string };
    return { texlive: st.texlive, engines: eng.release };
  })().catch((e) => { versionsMemo = null; throw e; });
}
const texliveUrl = (texlive: string) => `${location.origin}/api/e2e/texlive/${texlive}`;

/* --------------------------------------------------------------------------- format */

function fmtDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('overlyx-e2e-tex', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('fmt'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function storedFormat(key: string): Promise<Uint8Array | null> {
  try {
    const db = await fmtDb();
    const v = await new Promise<unknown>((resolve) => { const r = db.transaction('fmt').objectStore('fmt').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); });
    db.close();
    return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
  } catch { return null; }
}
/** keep `fmt` as the engine's format: the engine's older ones (and those of the engines before) go */
async function storeFormat(engine: EngineName, key: string, fmt: Uint8Array): Promise<void> {
  try {
    const db = await fmtDb();
    await new Promise<void>((resolve) => {
      const t = db.transaction('fmt', 'readwrite');
      const s = t.objectStore('fmt');
      const keys = s.getAllKeys();
      keys.onsuccess = () => {
        for (const k of keys.result) if (typeof k !== 'string' || k.startsWith(engine + ':') || !k.includes(':')) s.delete(k);
        s.put(fmt, key);
      };
      t.oncomplete = t.onerror = () => resolve();
    });
    db.close();
  } catch { /* built again next time */ }
}

const formatMemo = new Map<string, Promise<Uint8Array>>();
function format(engine: EngineName, v: { texlive: string; engines: string }, progress: (s: string) => void): Promise<Uint8Array> {
  const key = `${engine}:${v.engines}:${v.texlive}`;
  let f = formatMemo.get(key);
  if (!f) {
    f = (async () => {
      const kept = await storedFormat(key);
      if (kept) return kept;
      progress(`preparing ${PROGRAM[engine]} in this browser (once, up to a minute)`);
      const r = await runner.run(engine, texliveUrl(v.texlive), PROGRAM[engine], INI[engine], new Map());
      const fmt = r.files.find(([p]) => p === `${PROGRAM[engine]}.fmt`)?.[1];
      if (!fmt) throw new Error(`${PROGRAM[engine]} could not be prepared in this browser:\n` + (new TextDecoder().decode(r.files.find(([p]) => p.endsWith('.log'))?.[1] ?? new Uint8Array()) || r.out).slice(-3000));
      await storeFormat(engine, key, fmt);
      return fmt;
    })();
    f.catch(() => formatMemo.delete(key));
    formatMemo.set(key, f);
  }
  return f;
}

/* ---------------------------------------------------------------------------- build */

export interface CompileResult { ok: boolean; pdf: Uint8Array | null; synctex: Uint8Array | null; log: string; warnings: string[]; tex: string; texName: string; engine: string }

/**
 * The engine the server would build `main` with (server export.ts): a `% !TeX program` magic comment
 * names it; LuaLaTeX for markdown, an output format of pdf5 and fonts by name (\olfont); XeLaTeX for
 * pdf4 and non-TeX fonts; pdfLaTeX otherwise. Except that XeTeX finds fonts only by file name here
 * (it looks them up by name through fontconfig, which has no fonts in the browser): non-TeX fonts are
 * LuaLaTeX's, which finds them by name (luaotfload's index of TeX Live's fonts).
 */
export function engineOf(main: string, tex: string, header: { lines: string[] } | null): EngineName {
  if (isMarkdownPath(main)) return 'luahbtex';
  const m = /^\s*%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*([A-Za-z-]+)/im.exec(tex.split('\n', 40).join('\n'));
  const named = m?.[1].toLowerCase().replace(/-dev$/, '');
  if (named === 'lualatex' || named === 'luatex') return 'luahbtex';
  if (named === 'xelatex' || named === 'xetex') return 'xetex';
  if (named === 'pdflatex' || named === 'pdftex' || named === 'latex') return 'pdftex';
  const out = header ? headerValue(header, 'default_output_format') : undefined;
  const nonTex = !!header && headerValue(header, 'use_non_tex_fonts') === 'true';
  if (out === 'pdf5' || nonTex || /\\ol(?:font(?:set)?|mainfont)[[{]/.test(tex)) return 'luahbtex';
  if (out === 'pdf4') return 'xetex';
  return 'pdftex';
}

/** what makes LaTeX run again (latexmk's reasons, as far as the log tells) */
const RERUN = /Rerun to get|There were undefined references|Label\(s\) may have changed|Please rerun|No file [^\n]*\.(bbl|toc|aux|ind)|rerunfilecheck/;
/** the files whose change between two runs means the next run comes out different */
const SETTLES = /\.(aux|toc|lof|lot|out|nav|snm|bbl|ind|bcf|run\.xml)$/;

/**
 * What the last build of a document left that the next one starts from (its .aux, .toc, .bbl, …),
 * as the server's build directory keeps them: a build after a small change then needs one run.
 */
const leftover = new Map<string, Files>();

/**
 * Build `main` (project-relative) of the project. Every file of the project is written into the
 * engine's working directory: documents as their .tex (a markdown document as the .tex its PDF is
 * made from), other files as they are.
 */
export function compileProject(p: E2eProject, main: string, progress: (s: string) => void, cancelled: () => boolean): Promise<CompileResult> {
  const run = busy.then(() => compile(p, main, progress, cancelled));
  busy = run.catch(() => {});
  return run;
}

async function compile(p: E2eProject, main: string, progress: (s: string) => void, cancelled: () => boolean): Promise<CompileResult> {
  const v = await versions();
  progress('decrypting the project');
  await p.prefetchDocs();
  await p.prefetchTexts();
  const files: Files = new Map();
  let mainTex = main, tex = '';
  for (const path of p.paths()) {
    const e = p.entry(path);
    if (!e || e.kind === 'dir') continue;
    if (e.kind === 'doc') {
      if (isMarkdownPath(path)) {
        if (path !== main) continue;
        mainTex = path.replace(/\.[^.]+$/, '') + '.tex';
        tex = await p.markdownAsTex(path);
        files.set(mainTex, tex);
      } else {
        const t = await p.docText(path);
        if (path === main) tex = t;
        files.set(path, t);
      }
    } else if (e.size < 64 * 1024 * 1024) {
      try { files.set(path, await p.readBlob(path)); } catch (err) { console.warn('[e2e] left out of the build:', path, err); }
    }
  }
  const engine = engineOf(main, tex, isMarkdownPath(main) ? null : (p.modelNow(main)?.header ?? null));
  const program = PROGRAM[engine];
  const fmt = await format(engine, v, progress);
  if (cancelled()) throw new Error('cancelled');
  files.set(`/texlive/fmt/${program}.fmt`, fmt);

  const slash = mainTex.lastIndexOf('/');
  const cwd = slash < 0 ? '' : mainTex.slice(0, slash);
  const job = mainTex.slice(slash + 1).replace(/\.tex$/, '');
  const at = (name: string) => (cwd ? cwd + '/' : '') + name;
  // the document's directory, then the project's root (the server's texInputs)
  const inputs = '.:/work:';
  const env = { TEXINPUTS: inputs, BIBINPUTS: inputs, BSTINPUTS: inputs, TTFONTS: inputs, OPENTYPEFONTS: inputs, T1FONTS: inputs, AFMFONTS: inputs };
  const texlive = texliveUrl(v.texlive);
  const text = (name: string) => { const f = files.get(at(name)); return f === undefined ? '' : typeof f === 'string' ? f : new TextDecoder().decode(f); };
  const settled = () => [...files].filter(([n]) => SETTLES.test(n)).map(([n, d]) => n + ':' + (typeof d === 'string' ? d : new TextDecoder().decode(d))).join('\0');
  const take = (r: RunResult) => { for (const [n, d] of r.files) files.set(n, d); };
  const out: string[] = [];
  const key = `${p.name}\0${main}\0${engine}`;
  for (const [n, d] of leftover.get(key) ?? []) if (!files.has(n)) files.set(n, d);

  try {
    let passes = 0;
    const latex = async () => {
      if (cancelled()) throw new Error('cancelled');
      passes++;
      progress(passes > 1 ? `compiling (pass ${passes})` : 'compiling');
      const before = settled();
      // (XeTeX writes an .xdv, made into the PDF after the last run: it cannot start xdvipdfmx itself here)
      const r = await runner.run(engine, texlive, program, ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', `-fmt=${program}`, ...(engine === 'xetex' ? ['-no-pdf'] : []), job + '.tex'], files, cwd, env);
      take(r);
      return { r, changed: settled() !== before };
    };
    let { r, changed } = await latex();
    let bibDone = false, indexDone = false;
    while (passes < 6) {
      let again = false;
      const aux = text(job + '.aux');
      if (!bibDone && /\\bibdata\{/.test(aux)) {
        bibDone = true;
        progress('bibliography (BibTeX)');
        const b = await runner.run(engine, texlive, 'bibtex8', ['-W', job], files, cwd, env);
        take(b);
        out.push(`---- bibtex8 ${job} (exit ${b.code}) ----\n` + text(job + '.blg').slice(-4000));
        again = true;
      } else if (!bibDone && files.has(at(job + '.bcf'))) {
        bibDone = true;
        out.push('biblatex: the bibliography needs Biber, which is not available in the browser — with \\usepackage[backend=bibtex]{biblatex} BibTeX makes it.');
      }
      if (!indexDone && files.has(at(job + '.idx'))) {
        indexDone = true;
        progress('index (makeindex)');
        const m = await runner.run(engine, texlive, 'makeindex', [job + '.idx'], files, cwd, env);
        take(m);
        out.push(`---- makeindex ${job}.idx (exit ${m.code}) ----\n` + text(job + '.ilg').slice(-2000));
        again = true;
      }
      if (!again && !(changed && RERUN.test(text(job + '.log')))) break;
      ({ r, changed } = await latex());
    }
    if (engine === 'xetex' && files.has(at(job + '.xdv'))) {
      progress('writing the PDF (xdvipdfmx)');
      const x = await runner.run(engine, texlive, 'xdvipdfmx', ['-q', '-E', '-o', job + '.pdf', job + '.xdv'], files, cwd, env);
      take(x);
      if (x.code !== 0) out.push(`---- xdvipdfmx (exit ${x.code}) ----\n` + x.out.slice(-3000));
    }
    leftover.delete(key);
    leftover.set(key, new Map([...files].filter(([n]) => SETTLES.test(n))));
    while (leftover.size > 8) leftover.delete(leftover.keys().next().value!);
    const log = text(job + '.log') || r.out;
    const pdf = files.get(at(job + '.pdf'));
    const synctex = files.get(at(job + '.synctex.gz'));
    const errors = /^(?:\S[^\n]*:\d+: |! )/m.test(log);
    const warnings = [...log.matchAll(/^(?:LaTeX|Package \S+) Warning: ([^\n]+)/gm)].map(m => m[1]).slice(0, 50);
    return {
      ok: !!pdf && !errors, pdf: pdf instanceof Uint8Array ? pdf : null, synctex: synctex instanceof Uint8Array ? synctex : null,
      log: (out.length ? out.join('\n\n') + '\n\n' : '') + log, warnings, tex, texName: job + '.tex', engine: `${program} (in this browser)`,
    };
  } finally {
    runner.release();
  }
}

/** The engine must not keep running for a project that was closed. */
export function stopEngine(): void { runner.terminate(); }
