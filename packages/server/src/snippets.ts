/**
 * Raw LaTeX objects of layout documents (TikZ, pgfplots, anything the editor cannot draw itself)
 * are shown as their typeset image: the snippet is compiled with the document's own preamble on a
 * page of the object's size, in the build sandbox, and converted to SVG. Results are cached by
 * content (data/cache/snippets/<sha1>.svg), so an unchanged object never compiles twice, and at
 * most two snippets compile at a time.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.ts';
import { manager } from './docs.ts';
import { buildDirPath } from './namespaces.ts';
import { projectDir } from './projects.ts';
import { cacheDir } from './graphics.ts';
import { run, texInputs, linkDocumentAssets, magicEngine, rewriteParentPaths } from './export.ts';

const SNIPPETS = path.join(config.dataDir, 'cache', 'snippets');
const inflight = new Map<string, Promise<string>>();
let running = 0;
const queue: (() => void)[] = [];
const acquire = () => new Promise<void>(r => { if (running < 2) { running++; r(); } else queue.push(() => { running++; r(); }); });
const release = () => { running--; queue.shift()?.(); };

export function snippetFile(key: string): string | null {
  if (!/^[0-9a-f]{40}$/.test(key)) return null;
  const f = path.join(SNIPPETS, key + '.svg');
  return fs.existsSync(f) ? f : null;
}

/** The SVG of a snippet (its cache key), compiling it when it is not cached yet. */
export async function snippetSvg(docId: string, latex: string, wmm: number, hmm: number): Promise<string> {
  const doc = await manager.open(docId);
  const text = await doc.textAsync();
  const at = text.indexOf('\\begin{document}');
  if (at < 0) throw new Error('not a document');
  const w = Math.max(1, Math.min(2000, wmm)).toFixed(2), h = Math.max(1, Math.min(2000, hmm)).toFixed(2);
  const src = text.slice(0, at) + `\\geometry{paperwidth=${w}mm,paperheight=${h}mm}\n\\begin{document}\n\\begin{frame}[plain]\n\\begin{olraw}{x=0mm,y=0mm,w=${w}mm,h=${h}mm}\n${latex}\n\\end{olraw}\n\\end{frame}\n\\end{document}\n`;
  const key = crypto.createHash('sha1').update(src).digest('hex');
  if (snippetFile(key)) return key;
  let p = inflight.get(key);
  if (!p) {
    p = compile(docId, path.dirname(doc.absPath), doc.project, src, key).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function compile(docId: string, docDir: string, project: string, src: string, key: string): Promise<string> {
  await acquire();
  const dir = path.join(buildDirPath(docId), 'snippets', key);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(SNIPPETS, { recursive: true });
    linkDocumentAssets(docDir, dir);
    fs.writeFileSync(path.join(dir, 'snippet.tex'), rewriteParentPaths(src, docDir, projectDir(project)), 'utf8');
    const engine = magicEngine(src) ?? (/\\usepackage(\[[^\]]*\])?\{fontspec\}/.test(src) ? '-pdfxe' : '-pdf');
    const r = await run('latexmk', [engine, '-pvc-', '-interaction=nonstopmode', '-halt-on-error', 'snippet.tex'], {
      cwd: dir, env: texInputs(docDir, dir, projectDir(project)), timeoutMs: 60000, nice: true,
      sandbox: { rw: [dir], ro: [projectDir(project), cacheDir] },
    }).done;
    const pdf = path.join(dir, 'snippet.pdf');
    if (!fs.existsSync(pdf)) throw new Error('the snippet did not compile' + (r.out.match(/^!.*$/m)?.[0] ? ': ' + r.out.match(/^!.*$/m)![0] : ''));
    const out = path.join(dir, 'snippet.svg');
    const c = await run('pdftocairo', ['-svg', '-f', '1', '-l', '1', pdf, out], { cwd: dir, timeoutMs: 30000 }).done;
    if (c.code !== 0 || !fs.existsSync(out)) throw new Error('could not convert the snippet');
    fs.copyFileSync(out, path.join(SNIPPETS, key + '.svg'));
    return key;
  } finally {
    release();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
