/**
 * The starter projects every account gets besides the welcome project (a beamer deck, an HTML talk /
 * poster and a paper: packages/server/templates/starters, scripts/gen-starters.ts):
 * created once per account, the LaTeX ones in OverLyX's canonical form (opening and saving them
 * changes nothing) and compiling.
 *   npx vitest run tests/starters.test.ts
 */
import { describe, it, expect } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-starters-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const access = await import('../packages/server/src/access.ts');
const { createUser, createGuest, toSessionUser } = await import('../packages/server/src/auth.ts');
const { parseDocumentText, writeDocumentText } = await import('../packages/server/src/texdoc.ts');
const { parseTex, writeTex } = await import('../packages/core/src/tex/index.ts');
const { walkInsets } = await import('../packages/core/src/index.ts');
const { SCIENTIFIC_TEMPLATES, templateFolder } = await import('../packages/core/src/html/scientific.ts');

const TPL = join(import.meta.dirname, '../packages/server/templates/starters');
const HAVE_LATEXMK = spawnSync('which', ['latexmk']).status === 0;
/** the LaTeX starters */
const FILES: Record<string, string> = { slides: 'slides.tex', paper: 'paper.tex' };

describe('starter projects', () => {
  const ada = toSessionUser(createUser('ada', 'Ada Lovelace', 'pw'));

  it('every account gets the beamer deck, slides and posters, and the paper once, besides the welcome project', async () => {
    expect(access.ensureWelcomeProject(ada)).toBe('ada/welcome');
    expect(access.ensureStarterProjects(ada)).toEqual(['ada/example-slides', 'ada/example-web', 'ada/example-paper']);
    expect(access.ensureStarterProjects(ada)).toEqual([]);
    // the posters added later to older accounts are this one's already (starterupdates.ts LATER_POSTERS)
    const { db } = await import('../packages/server/src/db.ts');
    expect((db.prepare("SELECT template FROM starter_projects WHERE user_id=? AND template LIKE 'web:%' ORDER BY template").all(ada.id) as { template: string }[]).map(r => r.template))
      .toEqual(['web:poster-bernstein-2026', 'web:poster-icml-2026', ...['banner', 'cards', 'dark', 'editorial', 'portrait', 'steps', 'twin'].map(k => `web:poster-symposium-${k}`)]);
    const mine = access.accessibleProjects(ada);
    expect(mine.map(p => [p.name, p.kind, p.title, p.role])).toEqual(expect.arrayContaining([
      ['ada/welcome', 'example', 'Welcome to OverLyX', 'owner'],
      ['ada/example-slides', 'project', 'Example: beamer slides', 'owner'],
      ['ada/example-web', 'project', 'Example: slides and posters', 'owner'],
      ['ada/example-paper', 'project', 'Example: paper', 'owner'],
    ]));
    // the welcome project stays the one example the client looks for
    expect(mine.filter(p => p.kind === 'example').map(p => p.name)).toEqual(['ada/welcome']);
    for (const [id, file] of Object.entries(FILES)) {
      const dir = join(ROOT, 'projects', 'ada', `example-${id}`);
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text).not.toContain('@@');
      expect(text).not.toContain('Lovelace');   // examples never carry the account's name (AGENTS.md)
      expect(existsSync(join(dir, 'figures'))).toBe(true);
    }
    // the HTML deliverables
    for (const [folder, kind] of [['slides-1', 'deck'], ['poster-1', 'poster']]) {
      const html = readFileSync(join(ROOT, 'projects', 'ada', 'example-web', folder, 'index.html'), 'utf8');
      expect(html).toContain(`<meta name="overlyx" content="${kind}">`);
      expect(html).not.toContain('Lovelace');
      expect(html).not.toContain('@@');
    }
    expect(existsSync(join(ROOT, 'projects', 'ada', 'example-web', 'site'))).toBe(false);
    for (const t of SCIENTIFIC_TEMPLATES) {
      const folder = templateFolder(t);
      const html = readFileSync(join(ROOT, 'projects', 'ada', 'example-web', folder, 'index.html'), 'utf8');
      expect(html).toContain(`<meta name="overlyx-template" content="${t.id}">`);
      expect(html).not.toContain('Lovelace');
    }
    expect(readdirSync(join(ROOT, 'projects', 'ada', 'example-paper')).sort()).toEqual(['figures', 'paper.tex', 'refs.bib']);
  });

  it('a deleted starter is not created again; a name in use gets another key', () => {
    access.trashProject('ada/example-web');
    expect(access.ensureStarterProjects(ada)).toEqual([]);
    expect(existsSync(join(ROOT, 'projects', 'ada', 'example-web'))).toBe(false);
    // an account that already has a project called example-slides
    const bob = toSessionUser(createUser('bob', 'Bob Builder', 'pw'));
    mkdirSync(join(ROOT, 'projects', 'bob', 'example-slides'), { recursive: true });
    writeFileSync(join(ROOT, 'projects', 'bob', 'example-slides', 'mine.tex'), '\\documentclass{article}\n\\begin{document}\nMine.\n\\end{document}\n');
    expect(access.ensureStarterProjects(bob)).toEqual(['bob/example-slides-2', 'bob/example-web', 'bob/example-paper']);
    expect(readFileSync(join(ROOT, 'projects', 'bob', 'example-slides', 'mine.tex'), 'utf8')).toContain('Mine.');
  });

  it('guests get none', () => {
    expect(access.ensureStarterProjects(toSessionUser(createGuest()))).toEqual([]);
  });

  it('opening and saving a starter changes nothing (the server\'s own parse → write)', () => {
    for (const [id, file] of Object.entries(FILES)) {
      const project = `ada/example-${id}`;
      if (!existsSync(join(ROOT, 'projects', project))) continue;   // a deleted one
      const text = readFileSync(join(ROOT, 'projects', project, file), 'utf8');
      const r = parseDocumentText(text, project, file);
      expect(r.warnings, id).toEqual([]);
      expect(writeDocumentText(r.doc, project, file, false).text, id).toBe(text);
    }
  });
});

describe('starter templates', () => {
  for (const [id, file] of Object.entries(FILES)) {
    it(`${id}: canonical, figures small`, () => {
      const dir = join(TPL, id);
      const opts = { localDirs: [dir], readFile: (n: string) => { try { return readFileSync(join(dir, n), 'utf8'); } catch { return undefined; } } };
      const template = readFileSync(join(dir, file), 'utf8');
      const r = parseTex(template, opts);
      expect(r.warnings).toEqual([]);
      expect(writeTex(r.doc, opts).text).toBe(template);
      for (const f of readdirSync(join(dir, 'figures'))) expect(statSync(join(dir, 'figures', f)).size, f).toBeLessThan(100_000);
    });
  }

  it('the deck is an ordinary beamer file with frames, overlays, blocks, columns and notes', () => {
    const text = readFileSync(join(TPL, 'slides', 'slides.tex'), 'utf8');
    expect(text).toMatch(/^\\documentclass\[aspectratio=169\]\{beamer\}/);
    const doc = parseTex(text).doc;
    const frames = doc.body.filter((p, i) => p.layout === 'Frame' && p.depth === 0 && doc.body[i - 1]?.layout !== 'Frame');
    expect(frames.length).toBeGreaterThanOrEqual(10);
    for (const l of ['Title', 'Subtitle', 'Author', 'Section', 'Itemize', 'Enumerate', 'Columns', 'Column', 'Block', 'AlertBlock', 'ExampleBlock', 'Theorem', 'Proof']) {
      expect(doc.body.some(p => p.layout === l), l).toBe(true);
    }
    // speaker notes stay inside their frame (nested), where beamer's \note[item] belongs
    const notes = doc.body.filter(p => p.layout === 'NoteItem');
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every(p => p.depth === 1)).toBe(true);
    const flex = new Set<string>();
    for (const { inset } of walkInsets(doc.body)) if (inset.type === 'Text' && inset.name === 'Flex') flex.add(inset.arg);
    for (const f of ['Only', 'Uncover', 'Alert', 'Alternative']) expect([...flex], f).toContain(f);
    for (const s of ['[<+->]', '\\item<2->', '\\pause', '\\includegraphics', '\\begin{tabular}']) expect(text).toContain(s);
  });

  for (const [id, file] of Object.entries(FILES)) {
    it.skipIf(!HAVE_LATEXMK)(`${id} compiles`, () => {
      const dir = join(ROOT, 'build', id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      cpSync(join(TPL, id), dir, { recursive: true });
      spawnSync('latexmk', ['-pdf', '-bibtex', '-interaction=nonstopmode', '-f', file], { cwd: dir, timeout: 300000 });
      const log = existsSync(join(dir, file.replace('.tex', '.log'))) ? readFileSync(join(dir, file.replace('.tex', '.log')), 'latin1') : '';
      const errors = log.split('\n').filter(l => l.startsWith('! '));
      expect(errors, errors.join('\n')).toEqual([]);
      expect(existsSync(join(dir, file.replace('.tex', '.pdf')))).toBe(true);
      expect(log).not.toMatch(/Citation .* undefined/);
      expect(log).not.toMatch(/Reference .* undefined/);
    }, 300000);
  }
});
