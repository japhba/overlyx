/**
 * The personal example project ("Welcome to OverLyX", packages/server/templates/welcome): the
 * document must be canonical LyX (byte-exact round trip), personalise cleanly, and compile.
 *   npx vitest run tests/welcome.test.ts
 */
import { describe, it, expect } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseLyx, writeLyx, LLANGLE_PREAMBLE, getTextClass } from '../packages/core/src/index.ts';
import { exportLatex } from '../packages/core/src/latex/export.ts';

const TPL = join(import.meta.dirname, '../packages/server/templates/welcome');
const SCRATCH = process.env.OVERLYX_SCRATCH ?? join(tmpdir(), 'overlyx-welcome-test');
const HAVE_LATEXMK = spawnSync('which', ['latexmk']).status === 0;

/** the substitution done by ensureWelcomeProject (packages/server/src/access.ts) */
function personalise(text: string, name: string): string {
  const vars: Record<string, string> = { NAME: name, FIRSTNAME: name.split(/\s+/)[0], USERNAME: 'test', LLANGLE: LLANGLE_PREAMBLE.trimEnd() };
  return text.replace(/%%([A-Z]+)%%/g, (m, k: string) => vars[k] ?? m);
}

describe('welcome project template', () => {
  const template = readFileSync(join(TPL, 'welcome.lyx'), 'utf8');

  it('is canonical LyX (byte-exact round trip through parser and writer)', () => {
    expect(writeLyx(parseLyx(template))).toBe(template);
    expect(existsSync(join(TPL, 'refs.bib'))).toBe(true);
    expect(existsSync(join(TPL, 'figures', 'waves.pdf'))).toBe(true);
  });

  it('personalises without leftovers and keeps its structure', () => {
    const text = personalise(template, 'Ada Lovelace');
    expect(text).not.toContain('%%');
    expect(text).toContain('\\begin_layout Author\nAda Lovelace\n\\end_layout');
    expect(text).toContain('Ada.');            // first-name greeting in the abstract
    expect(text).toContain('% OverLyX: double angle brackets');
    const doc = parseLyx(text);
    expect(getTextClass(doc)).toBe('article');
    expect(writeLyx(doc)).toBe(text);
    const body = text.slice(text.indexOf('\\begin_body'));
    for (const needle of ['\\begin_inset Float figure', '\\begin_inset Float table', '\\begin_inset Tabular', '\\begin_inset FormulaMacro', '\\begin_inset CommandInset bibtex',
      '\\begin_inset Note Note', '\\begin_inset Note Comment', '\\begin_inset Foot', '\\llangle', 'CommandInset citation', '\\begin_layout Description']) {
      expect(body, needle).toContain(needle);
    }
  });

  it.skipIf(!HAVE_LATEXMK)('exports with OverLyX and compiles with pdflatex', () => {
    const dir = join(SCRATCH, 'project');
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(join(dir, 'figures'), { recursive: true });
    writeFileSync(join(dir, 'welcome.lyx'), personalise(template, 'Test User'));
    copyFileSync(join(TPL, 'refs.bib'), join(dir, 'refs.bib'));
    copyFileSync(join(TPL, 'figures', 'waves.pdf'), join(dir, 'figures', 'waves.pdf'));
    const out = join(SCRATCH, 'build');
    mkdirSync(out, { recursive: true });
    const res = exportLatex(parseLyx(readFileSync(join(dir, 'welcome.lyx'), 'utf8')), { basename: 'welcome' });
    expect(res.tex).toContain('\\llangle');
    expect(res.tex).toMatch(/\\def\\E#1\{/);   // macros are written in place like LyX does
    writeFileSync(join(out, 'welcome.tex'), res.tex);
    for (const [name, content] of Object.entries(res.files)) { mkdirSync(dirname(join(out, name)), { recursive: true }); writeFileSync(join(out, name), content); }
    for (const g of res.graphics) { mkdirSync(dirname(join(out, g.dest)), { recursive: true }); copyFileSync(join(dir, g.src), join(out, g.dest)); }
    const env = { ...process.env, TEXINPUTS: `${dir}//:`, BIBINPUTS: `${dir}//:`, BSTINPUTS: `${dir}//:` };
    spawnSync('latexmk', ['-pdf', '-bibtex', '-interaction=nonstopmode', '-f', 'welcome.tex'], { cwd: out, env, timeout: 240000 });
    const log = existsSync(join(out, 'welcome.log')) ? readFileSync(join(out, 'welcome.log'), 'latin1') : '';
    const errors = log.split('\n').filter(l => l.startsWith('! '));
    expect(errors, errors.join('\n')).toEqual([]);
    expect(existsSync(join(out, 'welcome.pdf'))).toBe(true);
    expect(log).not.toMatch(/Citation .* undefined/);
    expect(log).not.toMatch(/Reference .* undefined/);
  });
});
