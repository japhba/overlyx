/**
 * Generate the LaTeX starter projects every account gets besides the welcome project
 * (packages/server/templates/starters/<id>, created by ensureStarterProjects in
 * packages/server/src/access.ts): a beamer deck and a paper. (The slides, poster and web page
 * example, `starters/web`, is HTML written by hand.)
 *
 *   npx tsx scripts/gen-starters.ts             # the two .tex files (and refs.bib)
 *   npx tsx scripts/gen-starters.ts --figures   # also recompile the figures (pdflatex, pgfplots)
 *   npx tsx scripts/gen-starters.ts paper       # only the starters named (slides, paper)
 *
 * Both are written by hand (scripts/starters-src/*.tex) and go through OverLyX's own parser and
 * writer, so the templates are in the canonical form: opening and saving them in OverLyX changes
 * nothing. Placeholders (@@NAME@@) are filled in when the project is created for a user.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { markEditedSettings } from '../packages/core/src/tex/preamble.ts';
import { setHeaderValue } from '../packages/core/src/index.ts';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, 'starters-src');
const OUT = path.join(HERE, '..', 'packages', 'server', 'templates', 'starters');

/** parse → write with OverLyX (the template directory as the document's directory), settings applied */
function canonical(text: string, dir: string, settings: Record<string, string> = {}): string {
  const opts = { localDirs: [dir], readFile: (n: string) => { try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch { return undefined; } } };
  const r = parseTex(text, opts);
  if (r.warnings.length) throw new Error(`parser warnings:\n${r.warnings.join('\n')}`);
  if (Object.keys(settings).length) {
    const before = [...r.doc.header.lines];
    for (const [k, v] of Object.entries(settings)) setHeaderValue(r.doc.header, k, v);
    r.doc.header.lines = markEditedSettings(before, r.doc.header.lines, Object.keys(settings));
  }
  const once = writeTex(r.doc, opts).text;
  const twice = writeTex(parseTex(once, opts).doc, opts).text;
  if (once !== twice) throw new Error('not stable: a second parse → write changes the text');
  return once;
}

/* ------------------------------------------------------------------ figures */

const FIGURES: Record<string, string[]> = { slides: ['decay'], paper: ['convergence'] };

function compileFigures(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-starters-'));
  for (const [id, figs] of Object.entries(FIGURES)) {
    if (!wanted(id)) continue;
    fs.mkdirSync(path.join(OUT, id, 'figures'), { recursive: true });
    for (const f of figs) {
      // reproducible PDFs (no creation date, a fixed ID): regenerating does not change the files
      const r = spawnSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', path.join(SRC, 'figures', f + '.tex')], {
        cwd: tmp, encoding: 'utf8', env: { ...process.env, SOURCE_DATE_EPOCH: '1767225600', FORCE_SOURCE_DATE: '1' },
      });
      if (r.status !== 0) throw new Error(`figure ${f} failed:\n${r.stdout.slice(-2000)}`);
      fs.copyFileSync(path.join(tmp, f + '.pdf'), path.join(OUT, id, 'figures', f + '.pdf'));
      console.log(`figures: ${id}/figures/${f}.pdf`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* --------------------------------------------------------------------- main */

const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
function wanted(id: string): boolean { return !only.length || only.includes(id); }

if (process.argv.includes('--figures')) compileFigures();

const write = (id: string, file: string, text: string) => {
  fs.mkdirSync(path.join(OUT, id), { recursive: true });
  fs.writeFileSync(path.join(OUT, id, file), text);
  console.log(`${id}/${file}: ${text.length} bytes`);
};
if (wanted('slides')) write('slides', 'slides.tex', canonical(fs.readFileSync(path.join(SRC, 'slides.tex'), 'utf8'), path.join(OUT, 'slides')));
if (wanted('paper')) {
  fs.copyFileSync(path.join(SRC, 'refs.bib'), path.join(OUT, 'paper', 'refs.bib'));
  write('paper', 'paper.tex', canonical(fs.readFileSync(path.join(SRC, 'paper.tex'), 'utf8'), path.join(OUT, 'paper')));
}
