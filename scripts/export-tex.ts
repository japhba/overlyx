#!/usr/bin/env -S npx tsx
/**
 * Export a LyX document to LaTeX (and optionally PDF).
 *
 *   npx tsx scripts/export-tex.ts <file.lyx> <outdir> [--pdf] [--changes]
 *
 * Writes <outdir>/<basename>.tex (+ child documents), converts/copies the
 * graphics the document references (svg → pdf via rsvg-convert, falling back
 * to inkscape) and, with --pdf, runs latexmk in <outdir> with TEXINPUTS /
 * BIBINPUTS / BSTINPUTS pointing to the document directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { exportLatex } from '../packages/core/src/latex/export.ts';

function usage(): never {
  console.error('usage: npx tsx scripts/export-tex.ts <file.lyx> <outdir> [--pdf] [--changes]');
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));
if (positional.length < 2) usage();
const input = resolve(positional[0]);
const outdir = resolve(positional[1]);
if (!existsSync(input)) { console.error(`file not found: ${input}`); process.exit(1); }
mkdirSync(outdir, { recursive: true });
const docdir = dirname(input);
const base = basename(input).replace(/\.lyx$/i, '');

const doc = parseLyx(readFileSync(input, 'utf8'));
const result = exportLatex(doc, {
  basename: base,
  outputChanges: flags.has('--changes') ? true : undefined,
  resolveInclude: (name) => {
    const p = resolve(docdir, name);
    if (!existsSync(p)) return undefined;
    return parseLyx(readFileSync(p, 'utf8'));
  },
});

const texPath = join(outdir, base + '.tex');
writeFileSync(texPath, result.tex);
console.log(`wrote ${texPath}`);
for (const [name, content] of Object.entries(result.files)) {
  const p = join(outdir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  console.log(`wrote ${p}`);
}

/** Convert or copy a graphics file into outdir. */
function prepareGraphic(src: string, dest: string): void {
  const from = resolve(docdir, src);
  const to = join(outdir, dest);
  if (!existsSync(from)) { console.warn(`graphic not found: ${from}`); return; }
  mkdirSync(dirname(to), { recursive: true });
  if (dest.toLowerCase().endsWith('.pdf') && !from.toLowerCase().endsWith('.pdf')) {
    let r = spawnSync('rsvg-convert', ['-f', 'pdf', '-o', to, from], { stdio: 'pipe' });
    if (r.status !== 0) {
      r = spawnSync('inkscape', ['--export-type=pdf', `--export-filename=${to}`, from], { stdio: 'pipe' });
    }
    if (r.status !== 0) {
      // last resort for raster/other formats: ImageMagick
      r = spawnSync('convert', [from, to], { stdio: 'pipe' });
    }
    if (r.status !== 0) console.warn(`could not convert ${from} → ${to}: ${String(r.stderr ?? '').trim()}`);
    else console.log(`converted ${src} → ${dest}`);
  } else {
    copyFileSync(from, to);
  }
}
for (const g of result.graphics) prepareGraphic(g.src, g.dest);
for (const w of result.warnings) console.warn(`warning: ${w}`);

if (flags.has('--pdf')) {
  const env = { ...process.env, TEXINPUTS: `${docdir}//:`, BIBINPUTS: `${docdir}//:`, BSTINPUTS: `${docdir}//:` };
  const r = spawnSync('latexmk', ['-pdf', '-interaction=nonstopmode', '-f', base + '.tex'], { cwd: outdir, env, stdio: 'pipe', timeout: 600000 });
  const pdf = join(outdir, base + '.pdf');
  if (existsSync(pdf)) {
    console.log(pdf);
    if (r.status !== 0) console.warn('latexmk reported errors (PDF was produced anyway)');
  } else {
    const log = join(outdir, base + '.log');
    console.error('PDF generation failed');
    if (existsSync(log)) {
      const lines = readFileSync(log, 'utf8').split('\n');
      console.error(lines.slice(-60).join('\n'));
    } else console.error(String(r.stdout).slice(-3000));
    process.exit(1);
  }
}
