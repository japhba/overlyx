/**
 * PDF builds of end-to-end encrypted projects, in the browser: SwiftLaTeX's pdfTeX compiled to
 * WebAssembly (public/vendor/swiftlatex, AGPL-3.0, github.com/SwiftLaTeX/SwiftLaTeX) in a worker.
 * The project's files are decrypted into the worker's memory file system and never leave this
 * browser; TeX Live's own files (packages, fonts) come from the server one by one as the engine asks
 * for them (server e2e/texlive.ts), so the server learns which packages a document loads, nothing more.
 *
 * The LaTeX format is built here once per TeX Live version (~20 s, the first build) and kept in
 * IndexedDB; the engine stays loaded between builds (it keeps the TeX Live files it fetched).
 */
import type { E2eProject } from './project';
import { isMarkdownPath } from '@overlyx/core';

const ENGINE = '/vendor/swiftlatex/swiftlatexpdftex.js';
const FORMAT = 'swiftlatexpdftex.fmt';

interface Reply { result?: string; cmd?: string; status?: number; log?: string; pdf?: ArrayBuffer }

class Engine {
  private worker: Worker | null = null;
  private loaded: Promise<void> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;

  async load(texlive: string): Promise<void> {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    if (this.loaded) return this.loaded;
    this.loaded = new Promise<void>((resolve, reject) => {
      const w = this.worker = new Worker(ENGINE);
      w.onmessage = (ev: MessageEvent<Reply>) => { if (ev.data.result === 'ok') resolve(); else reject(new Error('The TeX engine did not start')); };
      w.onerror = () => reject(new Error('The TeX engine could not be loaded'));
    }).then(() => { this.worker!.postMessage({ cmd: 'settexliveurl', url: `${location.origin}/api/e2e/texlive/${texlive}/` }); });
    this.loaded.catch(() => this.terminate());
    return this.loaded;
  }

  /** a command and the reply of its kind */
  call(msg: Record<string, unknown>, reply: string, transfer: Transferable[] = []): Promise<Reply> {
    return new Promise(resolve => {
      const w = this.worker!;
      w.onmessage = (ev: MessageEvent<Reply>) => { if (ev.data.cmd === reply) resolve(ev.data); };
      w.postMessage(msg, transfer);
    });
  }

  /** a command without a reply */
  post(msg: Record<string, unknown>): void { this.worker?.postMessage(msg); }

  release(): void {
    if (this.idle) clearTimeout(this.idle);
    // a loaded engine holds a few hundred MB: let it go after a while unused
    this.idle = setTimeout(() => this.terminate(), 10 * 60 * 1000);
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null; this.loaded = null;
  }
}

const engine = new Engine();
let busy: Promise<unknown> = Promise.resolve();

/* --------------------------------------------------------------------------- format */

function fmtDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('overlyx-e2e-tex', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('fmt'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function storedFormat(version: string): Promise<Uint8Array | null> {
  try {
    const db = await fmtDb();
    const v = await new Promise<unknown>((resolve) => { const r = db.transaction('fmt').objectStore('fmt').get(version); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); });
    db.close();
    return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
  } catch { return null; }
}
async function storeFormat(version: string, fmt: Uint8Array): Promise<void> {
  try {
    const db = await fmtDb();
    await new Promise<void>((resolve) => { const t = db.transaction('fmt', 'readwrite'); t.objectStore('fmt').clear(); t.objectStore('fmt').put(fmt, version); t.oncomplete = t.onerror = () => resolve(); });
    db.close();
  } catch { /* built again next time */ }
}

let formatMemo: { version: string; fmt: Uint8Array } | null = null;
async function format(version: string, progress: (s: string) => void): Promise<Uint8Array> {
  if (formatMemo?.version === version) return formatMemo.fmt;
  let fmt = await storedFormat(version);
  if (!fmt) {
    progress('preparing LaTeX in this browser (once, about half a minute)');
    await engine.load(version);
    const r = await engine.call({ cmd: 'compileformat' }, 'compile');
    if (r.result !== 'ok' || !r.pdf) throw new Error('LaTeX could not be prepared in this browser:\n' + (r.log ?? '').slice(-2000));
    fmt = new Uint8Array(r.pdf);
    // the engine's working directory holds the format's byproducts: start clean
    engine.terminate();
    await storeFormat(version, fmt);
  }
  formatMemo = { version, fmt };
  return fmt;
}

let texliveVersion: string | null = null;
async function versions(): Promise<string> {
  if (texliveVersion) return texliveVersion;
  const st = await (await fetch('/api/e2e/status', { credentials: 'same-origin' })).json() as { texlive: string };
  return texliveVersion = st.texlive;
}

/* ---------------------------------------------------------------------------- build */

export interface CompileResult { ok: boolean; pdf: Uint8Array | null; log: string; warnings: string[]; tex: string }

const RERUN = /Rerun to get|There were undefined references|Label\(s\) may have changed|Please rerun|No file [^\n]*\.(bbl|toc|aux)/;

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
  const version = await versions();
  const fmt = await format(version, progress);
  if (cancelled()) throw new Error('cancelled');
  progress('decrypting the project');
  await p.prefetchDocs();
  await p.prefetchTexts();
  const files: { path: string; data: Uint8Array | string }[] = [];
  let mainTex = main, tex = '';
  for (const path of p.paths()) {
    const e = p.entry(path);
    if (!e || e.kind === 'dir') continue;
    if (e.kind === 'doc') {
      if (isMarkdownPath(path)) {
        if (path !== main) continue;
        mainTex = path.replace(/\.[^.]+$/, '') + '.tex';
        tex = await p.markdownAsTex(path);
        files.push({ path: mainTex, data: tex });
      } else {
        const t = await p.docText(path);
        if (path === main) tex = t;
        files.push({ path, data: t });
      }
    } else if (e.size < 64 * 1024 * 1024) {
      try { files.push({ path, data: await p.readBlob(path) }); } catch (err) { console.warn('[e2e] left out of the build:', path, err); }
    }
  }
  if (cancelled()) throw new Error('cancelled');
  progress('compiling');
  await engine.load(version);
  try {
    engine.post({ cmd: 'flushcache' });
    await engine.call({ cmd: 'writefile', url: FORMAT, src: fmt.slice() }, 'writefile');
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (!dirs.has(d)) { dirs.add(d); await engine.call({ cmd: 'mkdir', url: d }, 'mkdir'); }
      }
      await engine.call({ cmd: 'writefile', url: f.path, src: f.data }, 'writefile');
    }
    engine.post({ cmd: 'setmainfile', url: mainTex });
    let r: Reply = {};
    for (let i = 0; i < 4; i++) {
      if (cancelled()) throw new Error('cancelled');
      progress(i ? `compiling (pass ${i + 1})` : 'compiling');
      r = await engine.call({ cmd: 'compilelatex' }, 'compile');
      if (r.result !== 'ok' || !RERUN.test(r.log ?? '')) break;
    }
    const log = r.log ?? '';
    const warnings = [...log.matchAll(/^(?:LaTeX|Package \S+) Warning: ([^\n]+)/gm)].map(m => m[1]).slice(0, 50);
    return { ok: r.result === 'ok' && !!r.pdf, pdf: r.pdf ? new Uint8Array(r.pdf) : null, log, warnings, tex };
  } finally {
    engine.release();
  }
}

/** The engine must not keep running for a project that was closed. */
export function stopEngine(): void { engine.terminate(); }
