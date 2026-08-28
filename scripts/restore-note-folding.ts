/**
 * Bring the fold state (open / collapsed) of notes and comments back from the LyX originals in
 * `lyx_deprecated/` into the imported .tex documents. The first import wrote every note open;
 * since then the .tex format records a folded note as `%% @note collapsed`.
 *
 * Notes are matched in document order by their text; a note that cannot be matched keeps its
 * current state. Only the `%% @note` header lines are patched — the document is not rewritten.
 *
 *   OVERLYX_PROJECTS_DIR=/root/projects npx tsx scripts/restore-note-folding.ts --all [--dry-run]
 *   npx tsx scripts/restore-note-folding.ts <project>...
 *
 * Run it against a server that already understands `%% @note collapsed` (it absorbs the change
 * from disk); an older server would parse the notes open and write the file back without it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listProjects, projectDir } from '../packages/server/src/projects.ts';
import { parseDocumentText, readTextFile } from '../packages/server/src/texdoc.ts';
import { parseLyx, walkInsets, plainText, type TextInset } from '../packages/core/src/index.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const names = args.includes('--all') ? listProjects().map(p => p.name) : args.filter(a => !a.startsWith('--'));
if (!names.length) { console.error('usage: restore-note-folding.ts [--dry-run] [--verbose] (--all | <project>...)'); process.exit(1); }

const NOTE_LINE = /^((?:%% )*%% @(?:note|comment|greyedout))(?: (?:open|collapsed))?\s*$/;

/**
 * A note's identity for matching: kind + the start of its text reduced to letters and digits
 * (formulas and raw LaTeX come out differently from the two parsers, so only a prefix is used;
 * a note with (almost) no text is matched by position alone).
 */
function keyOf(n: TextInset): string { return n.arg + ':' + plainText(n.paragraphs).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24); }
const isBlankKey = (k: string) => k.length < k.indexOf(':') + 1 + 6;
function notesOf(pars: Parameters<typeof walkInsets>[0]): TextInset[] {
  return [...walkInsets(pars)].map(x => x.inset).filter((i): i is TextInset => i.type === 'Text' && i.name === 'Note');
}

function* lyxFiles(dir: string, rel = ''): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) yield* lyxFiles(path.join(dir, e.name), r);
    else if (/\.lyx$/i.test(e.name)) yield r;
  }
}

let written = 0, unchanged = 0, skipped = 0, notesFolded = 0, notesUnmatched = 0;
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
      const lyxNotes = notesOf(parseLyx(readTextFile(path.join(dep, lyxRel))).body).map(n => ({ key: keyOf(n), status: n.status ?? 'open' }));
      if (!lyxNotes.length) continue;
      const texText = readTextFile(texAbs);
      const parsed = parseDocumentText(texText, project, texRel);
      const texNotes = notesOf(parsed.doc.body);
      // the note header lines of the file, in text order = the depth-first order of walkInsets
      const lines = texText.split('\n');
      const bodyStart = parsed.fragment ? 0 : Math.max(0, lines.findIndex(l => l.startsWith('\\begin{document}')));
      const headerLines: number[] = [];
      for (let i = bodyStart; i < lines.length; i++) if (NOTE_LINE.test(lines[i])) headerLines.push(i);
      if (headerLines.length !== texNotes.length) { console.log(`${label}: SKIPPED — ${headerLines.length} note header line(s) but ${texNotes.length} parsed note(s)`); skipped++; continue; }
      // align in document order: the next LyX note with the same text (looking a few notes ahead
      // for notes that were deleted since); a note without a match keeps its state
      let changed = 0, unmatched = 0, li = 0;
      texNotes.forEach((n, idx) => {
        const k = keyOf(n);
        let j = -1;
        if (isBlankKey(k)) { if (li < lyxNotes.length && lyxNotes[li].key.startsWith(k.slice(0, k.indexOf(':') + 1))) j = li; }
        else for (let x = li; x < Math.min(lyxNotes.length, li + 8); x++) if (lyxNotes[x].key === k) { j = x; break; }
        if (j < 0) { unmatched++; if (verbose) console.log(`  unmatched note ${idx + 1}: ${k.slice(0, 80)}\n    LyX candidates: ${lyxNotes.slice(li, li + 3).map(x => x.key.slice(0, 60)).join(' | ')}`); return; }
        li = j + 1;
        const want = lyxNotes[j].status === 'collapsed' ? 'collapsed' : 'open';
        if ((n.status ?? 'open') === want) return;
        n.status = want;
        const m = NOTE_LINE.exec(lines[headerLines[idx]])!;
        lines[headerLines[idx]] = m[1] + (want === 'collapsed' ? ' collapsed' : '');
        changed++;
      });
      notesUnmatched += unmatched;
      if (!changed) { unchanged++; if (unmatched) console.log(`${label}: nothing to change (${unmatched} of ${texNotes.length} notes not found in the LyX file)`); continue; }
      const out = lines.join('\n');
      // sanity: the patched text parses to exactly the intended states
      const check = notesOf(parseDocumentText(out, project, texRel).doc.body);
      if (check.length !== texNotes.length || check.some((n, i) => (n.status ?? 'open') !== (texNotes[i].status ?? 'open'))) { console.log(`${label}: SKIPPED — the patched file does not parse to the intended states`); skipped++; continue; }
      console.log(`${label}: ${changed} note(s) folded${unmatched ? `, ${unmatched} not found in the LyX file` : ''}${dryRun ? ' (dry run)' : ''}`);
      notesFolded += changed;
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
console.log(`\n${notesFolded} note(s) folded in ${dryRun ? 'would-be-' : ''}${written} written document(s); ${unchanged} unchanged, ${skipped} skipped, ${notesUnmatched} note(s) unmatched`);
process.exit(skipped ? 1 : 0);
