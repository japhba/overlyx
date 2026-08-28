/**
 * Bring the display forms of math macros (LyX's second definition line, what the editor shows
 * instead of the LaTeX expansion) back from the LyX originals in `lyx_deprecated/` into the
 * imported .tex documents. The first import dropped them; since then the .tex format keeps a
 * display form as the trailer `%% @display {…}` on the macro's definition line.
 *
 * Macros are matched by name in document order; only the definition lines are patched.
 *
 *   OVERLYX_PROJECTS_DIR=/root/projects npx tsx scripts/restore-macro-displays.ts --all [--dry-run]
 *   npx tsx scripts/restore-macro-displays.ts <project>...
 *
 * Run it against a server that already understands `%% @display` (it absorbs the change from disk).
 */
import fs from 'node:fs';
import path from 'node:path';
import { listProjects, projectDir } from '../packages/server/src/projects.ts';
import { parseDocumentText, readTextFile } from '../packages/server/src/texdoc.ts';
import { parseLyx, walkInsets, type FormulaMacroInset } from '../packages/core/src/index.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const names = args.includes('--all') ? listProjects().map(p => p.name) : args.filter(a => !a.startsWith('--'));
if (!names.length) { console.error('usage: restore-macro-displays.ts [--dry-run] (--all | <project>...)'); process.exit(1); }

const macroName = (line: string) => /^\\(?:re)?newcommandx?\*?\s*\{?\\([A-Za-z@]+)|^\\(?:global\\)?(?:long\\)?def\\([A-Za-z@]+)/.exec(line.trim())?.slice(1).find(Boolean);
function macrosOf(pars: Parameters<typeof walkInsets>[0]): FormulaMacroInset[] {
  return [...walkInsets(pars)].map(x => x.inset).filter((i): i is FormulaMacroInset => i.type === 'FormulaMacro');
}
function* lyxFiles(dir: string, rel = ''): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) yield* lyxFiles(path.join(dir, e.name), r);
    else if (/\.lyx$/i.test(e.name)) yield r;
  }
}

let written = 0, skipped = 0, restored = 0, unmatched = 0;
for (const project of names) {
  const proj = projectDir(project);
  const dep = path.join(proj, 'lyx_deprecated');
  if (!fs.existsSync(dep)) continue;
  for (const lyxRel of lyxFiles(dep)) {
    const texRel = lyxRel.replace(/\.lyx$/i, '.tex');
    const texAbs = path.join(proj, texRel);
    if (!fs.existsSync(texAbs)) continue;
    const label = `${project}/${texRel}`;
    try {
      const wanted = macrosOf(parseLyx(readTextFile(path.join(dep, lyxRel))).body)
        .filter(m => (m.lines[1] ?? '').trim().startsWith('{'))
        .map(m => ({ name: macroName(m.lines[0]), display: m.lines[1].trim() }))
        .filter((m): m is { name: string; display: string } => !!m.name);
      if (!wanted.length) continue;
      const texText = readTextFile(texAbs);
      const lines = texText.split('\n');
      let changed = 0, from = 0;
      for (const w of wanted) {
        // the next definition line of that macro (the .tex writer puts every macro on its own line)
        let idx = -1;
        for (let i = from; i < lines.length; i++) if (/^\\(?:global\\long\\def|(?:re)?newcommandx)\\/.test(lines[i]) && macroName(lines[i]) === w.name) { idx = i; break; }
        if (idx < 0) { unmatched++; console.log(`${label}: \\${w.name} not found`); continue; }
        from = idx + 1;
        const l = lines[idx];
        if (/%% @display \{/.test(l)) continue;                    // already there
        if (!l.endsWith('%')) { unmatched++; console.log(`${label}: \\${w.name}: unexpected definition line`); continue; }
        lines[idx] = l + '% @display ' + w.display;
        changed++;
      }
      if (!changed) continue;
      const out = lines.join('\n');
      // sanity: the patched file parses to macros carrying the display forms
      const check = new Map(macrosOf(parseDocumentText(out, project, texRel).doc.body).filter(m => m.lines[1]).map(m => [macroName(m.lines[0]), m.lines[1]]));
      const bad = wanted.filter(w => check.get(w.name) !== w.display);
      if (bad.length) { console.log(`${label}: SKIPPED — ${bad.map(b => '\\' + b.name).join(', ')} do not parse back with the display form`); skipped++; continue; }
      console.log(`${label}: ${changed} display form(s) restored${dryRun ? ' (dry run)' : ''}`);
      restored += changed;
      if (dryRun) continue;
      fs.writeFileSync(texAbs + '.overlyx-tmp', out, 'utf8');
      fs.renameSync(texAbs + '.overlyx-tmp', texAbs);
      written++;
    } catch (e) {
      console.error(`${label}: FAILED ${String(e)}`);
      skipped++;
    }
  }
}
console.log(`\n${restored} display form(s) restored in ${dryRun ? 'would-be-' : ''}${written} written document(s); ${skipped} skipped, ${unmatched} macro(s) unmatched`);
process.exit(skipped ? 1 : 0);
