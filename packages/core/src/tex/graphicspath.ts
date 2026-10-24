/**
 * `\graphicspath{{figures/}{../shared/}}` in a preamble: the folders graphicx searches for an
 * `\includegraphics` file name that is not found where the document is compiled. The editor's
 * figures look there too (the `alt` candidates of the graphics endpoint), so a figure shows in
 * the editor whenever the PDF finds it.
 */

/**
 * The folders of the preamble's `\graphicspath`, as project-relative prefixes ('' = the project
 * root, else ending in '/'): written relative to `rootDir` (the project-relative folder the
 * document is compiled in — its master's), in their order. The last `\graphicspath` counts, as in
 * LaTeX. Absolute folders and folders outside the project are left out.
 */
export function graphicsSearchDirs(preamble: string, rootDir: string): string[] {
  let dirs: string[] = [];
  const text = preamble.replace(/(^|[^\\])%.*$/gm, '$1');
  const re = /\\graphicspath\s*\{/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const found: string[] = [];
    let depth = 1, start = -1, i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (c === '\\') { i++; continue; }
      if (c === '{') { depth++; if (depth === 2) start = i + 1; }
      else if (c === '}') { depth--; if (depth === 1 && start >= 0) { found.push(text.slice(start, i)); start = -1; } }
    }
    if (depth === 0) dirs = found;
    re.lastIndex = i;
  }
  const out: string[] = [];
  for (const raw of dirs) {
    const d = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!d || d.startsWith('/') || /^[A-Za-z]:[\\/]/.test(d) || d.startsWith('~')) continue;
    const rel = projectRel(rootDir, d);
    if (rel === null) continue;
    const prefix = rel ? rel + '/' : '';
    if (!out.includes(prefix)) out.push(prefix);
  }
  return out;
}

/** `dir` (relative to the project folder `base`) from the project root, or null when it leaves the project */
function projectRel(base: string, dir: string): string | null {
  const out: string[] = [];
  for (const p of [...base.split('/'), ...dir.replace(/\\/g, '/').split('/')]) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (!out.length) return null; out.pop(); } else out.push(p);
  }
  return out.join('/');
}
