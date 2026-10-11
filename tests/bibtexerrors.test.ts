/**
 * A .bib that BibTeX cannot read (server export.ts bibtexErrors): its complaints come from the
 * .blg as `refs.bib:3: …` lines — the build log named none of them ("(no errors found in log)")
 * while the PDF lacked its bibliography (usability wave, 11 Oct 2026).
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-bibtexerrors-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
const { bibtexErrors, buildErrors } = await import('../packages/server/src/export.ts');

const BLG = `This is BibTeX, Version 0.99d (TeX Live 2025)
Capacity: max_strings=200000, hash_size=200000, hash_prime=170003
The top-level auxiliary file: main.aux
The style file: plain.bst
Database file #1: refs.bib
I was expecting a \`,' or a \`}'---line 3 of file refs.bib
 :
 : }
(Error may have been on previous line)
I'm skipping whatever remains of this entry
Repeated entry---line 12 of file /tmp/build/refs.bib
 : @article{knuth
 :              ,
I'm skipping whatever remains of this entry
Warning--I didn't find a database entry for "nobody"
(There were 2 error messages)
`;

describe('BibTeX errors', () => {
  it('names each complaint with its .bib line, once', () => {
    expect(bibtexErrors(BLG)).toEqual([
      "refs.bib:3: I was expecting a `,' or a `}'",
      'refs.bib:12: Repeated entry',
    ]);
  });
  it('a missing database and biber errors', () => {
    expect(bibtexErrors("I couldn't open database file nothere.bib\n")).toEqual(['BibTeX could not open nothere.bib']);
    expect(bibtexErrors('[123] Utils.pm:409> ERROR - BibTeX subsystem: /tmp/x/refs.bib_1.utf8, line 3, syntax error: found "}"\n')).toEqual(['BibTeX subsystem: /tmp/x/refs.bib_1.utf8, line 3, syntax error: found "}"']);
    expect(bibtexErrors('This is BibTeX\n(There were 0 error messages)\n')).toEqual([]);
  });
  it('the build\'s first errors include them when they lead the log', () => {
    const log = `BibTeX:\n${bibtexErrors(BLG).join('\n')}\n\n(no LaTeX errors in the log)`;
    expect(buildErrors(log)).toEqual(["refs.bib:3: I was expecting a `,' or a `}'", 'refs.bib:12: Repeated entry']);
  });
});
