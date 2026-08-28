/**
 * Import the .lyx files of one or more projects into .tex documents (next to the originals, which
 * are left untouched), converting graphics pdflatex cannot include. Child documents (included by
 * another .lyx file) become fragments. Uses the server's configuration (OVERLYX_PROJECTS_DIR).
 *
 *   OVERLYX_PROJECTS_DIR=/root/projects npx tsx scripts/import-lyx.ts recurrent_feature bayesian_chaos
 *   npx tsx scripts/import-lyx.ts --all            # every project
 *   npx tsx scripts/import-lyx.ts --force <project> # overwrite existing .tex files
 */
import fs from 'node:fs';
import path from 'node:path';
import { listProjects, projectDir, isBackupFile } from '../packages/server/src/projects.ts';
import { importLyxFile } from '../packages/server/src/texdoc.ts';
import { toPdf } from '../packages/server/src/graphics.ts';

const args = process.argv.slice(2);
const force = args.includes('--force');
const names = args.includes('--all') ? listProjects().map(p => p.name) : args.filter(a => !a.startsWith('--'));
if (!names.length) { console.error('usage: import-lyx.ts [--force] (--all | <project>...)'); process.exit(1); }

let done = 0, skipped = 0, failed = 0;
for (const project of names) {
  const p = listProjects().find(x => x.name === project);
  if (!p) { console.error(`no such project: ${project}`); failed++; continue; }
  const lyxFiles = p.files.filter(f => f.kind === 'lyx' && !isBackupFile(f.name) && !f.name.endsWith('.emergency'));
  // masters first: the import of a master imports its children itself
  const seen = new Set<string>();
  for (const f of lyxFiles) {
    if (seen.has(f.path)) continue;
    const texPath = path.join(projectDir(project), f.path.replace(/\.lyx$/i, '.tex'));
    if (fs.existsSync(texPath) && !force) {
      // an existing .tex written by an earlier import / a LyX export: leave it unless --force
      const head = fs.readFileSync(texPath, 'utf8').slice(0, 200);
      if (!/Imported from .* by OverLyX|overlyx-settings/.test(head)) { console.log(`${project}/${f.path}: ${path.basename(texPath)} exists (not written by OverLyX) — skipped, use --force to overwrite`); skipped++; continue; }
      console.log(`${project}/${f.path}: already imported — skipped (use --force to redo)`); skipped++; continue;
    }
    try {
      const r = await importLyxFile(project, f.path, toPdf);
      for (const c of r.created) seen.add(c.replace(/\.tex$/, '.lyx'));
      const bad = r.graphics.filter(g => !g.ok);
      console.log(`${project}/${f.path} -> ${r.created.join(', ')}${r.warnings.length ? `\n  warnings: ${r.warnings.slice(0, 5).join('; ')}` : ''}${bad.length ? `\n  graphics not converted: ${bad.map(g => `${g.src} (${g.error})`).join(', ')}` : ''}`);
      done += r.created.length;
    } catch (e) {
      console.error(`${project}/${f.path}: FAILED ${String(e)}`);
      failed++;
    }
  }
}
console.log(`\n${done} document(s) written, ${skipped} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
