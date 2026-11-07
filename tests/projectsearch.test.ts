/**
 * The files panel's Search (packages/server/src/projectsearch.ts, searchtext.ts) against a scratch
 * database and projects directory: what is matched and how it is shown, which files are read, who may
 * search, and the limits.
 */
import { describe, it, expect, vi } from 'vitest';
const ROOT = vi.hoisted(() => {
  const root = (process.env.OVERLYX_SCRATCH || process.env.TMPDIR || '/tmp') + '/overlyx-projectsearch-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { compileQuery, maskHtml, previewOf, searchFiles, searchText, SEARCH_LIMITS } from '../packages/server/src/searchtext.ts';

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
const P = join(ROOT, 'projects', 'ada', 'paper');
mkdirSync(join(P, '.git'), { recursive: true });
mkdirSync(join(P, 'deck'), { recursive: true });
mkdirSync(join(ROOT, 'outside'), { recursive: true });
writeFileSync(join(P, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nNeural networks learn.\n\\section{Neural}\nA neural net, and another NEURAL one.\n\\end{document}\n');
writeFileSync(join(P, 'refs.bib'), '@article{a, title={Neural codes}}\n');
writeFileSync(join(P, 'main.aux'), 'neural neural neural\n');
writeFileSync(join(P, 'main.tex~'), 'neural backup\n');
writeFileSync(join(P, '.git', 'COMMIT_EDITMSG'), 'neural commit\n');
writeFileSync(join(P, 'blob.dat'), Buffer.concat([Buffer.from('neural'), Buffer.from([0, 1, 2])]));
writeFileSync(join(P, 'deck', 'index.html'), '<!doctype html><meta name="overlyx" content="deck"><style>.neural{}</style>\n<section class="slide"><h1>Intro</h1></section>\n<section class="slide" data-neural="x"><p>Neural slide</p></section>\n');
writeFileSync(join(ROOT, 'outside', 'secret.txt'), 'neural secret\n');
symlinkSync(join(ROOT, 'outside', 'secret.txt'), join(P, 'linked.txt'));

const { createUser, toSessionUser } = await import('../packages/server/src/auth.ts');
const access = await import('../packages/server/src/access.ts');
const { config } = await import('../packages/server/src/config.ts');
const { searchProject, searchTargets, SearchError } = await import('../packages/server/src/projectsearch.ts');
if (!config.dataDir.startsWith(ROOT)) throw new Error('the test would use the real data directory: ' + config.dataDir);
const ada = toSessionUser(createUser('ada', 'Ada', 'pw'));
const bob = toSessionUser(createUser('bob', 'Bob', 'pw'));
access.adoptProjects();

describe('matching', () => {
  it('plain text is literal, case-insensitive unless asked; whole words; regular expressions', () => {
    const count = (q: Parameters<typeof compileQuery>[0], t: string) => searchText(t, compileQuery(q)).count;
    expect(count({ q: 'a.b' }, 'a.b axb')).toBe(1);
    expect(count({ q: 'neural' }, 'Neural NEURAL neural')).toBe(3);
    expect(count({ q: 'neural', matchCase: true }, 'Neural NEURAL neural')).toBe(1);
    expect(count({ q: 'net', wholeWord: true }, 'net network subnet net.')).toBe(2);
    expect(count({ q: 'über', wholeWord: true }, 'über Überzug')).toBe(1);
    expect(count({ q: '\\\\(sub)?section', regex: true }, '\\section{a} \\subsection{b}')).toBe(2);
    expect(count({ q: '^A', regex: true, matchCase: true }, 'A\nA b\nbA')).toBe(2);
    expect(count({ q: 'x*', regex: true }, 'abc')).toBe(0);   // empty matches are no matches
    expect(() => compileQuery({ q: '(', regex: true })).toThrow(/valid regular expression/);
    expect(() => compileQuery({ q: '' })).toThrow();
  });

  it('says where: line, column and the line around the match', () => {
    const r = searchText('first\n  second   line with   neural   words\n', compileQuery({ q: 'neural' }));
    expect(r.matches[0]).toMatchObject({ line: 2, col: 23, len: 6 });
    const m = r.matches[0];
    expect(m.preview.slice(m.from, m.to)).toBe('neural');
    expect(m.preview).toBe('second line with neural words');
    const long = previewOf('x'.repeat(300) + ' needle ' + 'y'.repeat(300), 301, 6);
    expect(long.preview.startsWith('…')).toBe(true);
    expect(long.preview.endsWith('…')).toBe(true);
    expect(long.preview.slice(long.from, long.to)).toBe('needle');
  });

  it('web pages: only what the page shows, and the slide a match is on', () => {
    const html = '<style>.neural{}</style>\n<section class="slide"><h1>Intro</h1></section>\n<section class="slide" data-neural="x"><p>Neural slide</p></section>';
    expect(maskHtml('<p a="neural">neural</p>\n<script>neural</script>')).toBe('              neural    \n' + ' '.repeat(23));
    const r = searchText(html, compileQuery({ q: 'neural' }), { html: true });
    expect(r.count).toBe(1);
    expect(r.matches[0]).toMatchObject({ line: 3, slide: 2 });
  });
});

describe('the project', () => {
  it('reads the text files inside the project: no .git, build products, backups, binaries or links out of it', () => {
    // (a binary is known when it is read: blob.dat holds a NUL byte)
    expect(searchTargets('ada/paper').map(t => t.path).sort()).toEqual(['blob.dat', 'deck/index.html', 'main.tex', 'refs.bib']);
    const r = searchFiles(searchTargets('ada/paper'), { q: 'neural' });
    expect(r.skipped).toBe(1);
    expect(r.files.map(f => [f.path, f.count])).toEqual([['deck/index.html', 1], ['main.tex', 4], ['refs.bib', 1]]);
    expect(r.total).toBe(6);
  });

  it('only for those who can view the project; the matching runs in a worker', async () => {
    await expect(searchProject(bob, 'ada/paper', { q: 'neural' })).rejects.toMatchObject({ status: 403 });
    await expect(searchProject(ada, 'ada/paper', { q: '(', regex: true })).rejects.toBeInstanceOf(SearchError);
    const r = await searchProject(ada, 'ada/paper', { q: 'neural', wholeWord: true, matchCase: true });
    expect(r.files.map(f => f.path)).toEqual(['main.tex']);
    expect(r.files[0].matches[0]).toMatchObject({ line: 5, preview: 'A neural net, and another NEURAL one.' });
  }, 30000);

  it('a pattern that never finishes stops its worker, and the next search gets a new one', async () => {
    writeFileSync(join(P, 'trap.txt'), 'a'.repeat(40) + '!\n');
    const limits = { ...SEARCH_LIMITS, hardMs: 500 };
    await expect(searchProject(ada, 'ada/paper', { q: '(a+)+$', regex: true }, () => false, limits)).rejects.toMatchObject({ status: 422 });
    const r = await searchProject(ada, 'ada/paper', { q: 'neural' });
    expect(r.total).toBe(6);
    rmSync(join(P, 'trap.txt'));
  }, 30000);

  it('stops at the limits and says so', () => {
    const limits = { ...SEARCH_LIMITS, perFile: 2, shown: 3 };
    const r = searchFiles(searchTargets('ada/paper'), { q: 'neural' }, limits);
    expect(r.files[0].matches.length).toBeLessThanOrEqual(2);
    expect(r.files.reduce((n, f) => n + f.matches.length, 0)).toBeLessThanOrEqual(3);
    let t = 0;
    const slow = searchFiles(searchTargets('ada/paper'), { q: 'neural' }, { ...SEARCH_LIMITS, softMs: 5 }, () => (t += 10));
    expect(slow.truncated).toBe(true);
    const small = searchFiles(searchTargets('ada/paper'), { q: 'neural' }, { ...SEARCH_LIMITS, fileBytes: 60 });
    expect(small.skipped).toBeGreaterThan(0);
  });
});
