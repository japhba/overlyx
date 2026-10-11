/**
 * The personal example project ("Welcome to OverLyX", packages/server/templates/welcome): the
 * document must be canonical (writing what the parser reads reproduces it), fill in cleanly,
 * and compile.
 *   npx vitest run tests/welcome.test.ts
 */
import { describe, it, expect } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { LLANGLE_PREAMBLE, getTextClass, walkInsets } from '../packages/core/src/index.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';

const TPL = join(import.meta.dirname, '../packages/server/templates/welcome');
const SCRATCH = process.env.OVERLYX_SCRATCH ?? join(tmpdir(), 'overlyx-welcome-test');
const HAVE_LATEXMK = spawnSync('which', ['latexmk']).status === 0;

/** the substitution done by ensureWelcomeProject (packages/server/src/access.ts) */
function fillIn(text: string): string {
  const vars: Record<string, string> = { LLANGLE: LLANGLE_PREAMBLE.trimEnd() };
  return text.replace(/(?:%%|@@)([A-Z]+)(?:%%|@@)/g, (m, k: string) => vars[k] ?? m);
}

describe('welcome project template', () => {
  const template = readFileSync(join(TPL, 'welcome.tex'), 'utf8');

  it('is canonical (writing what the parser reads reproduces the file)', () => {
    const r = parseTex(template);
    expect(r.warnings).toEqual([]);
    expect(writeTex(r.doc).text).toBe(template);
    // filled in: stable after one save
    const text = fillIn(template);
    const once = writeTex(parseTex(text).doc).text;
    expect(writeTex(parseTex(once).doc).text).toBe(once);
    expect(existsSync(join(TPL, 'refs.bib'))).toBe(true);
    expect(existsSync(join(TPL, 'figures', 'waves.pdf'))).toBe(true);
  });

  it('fills in without leftovers and keeps its structure', () => {
    const text = fillIn(template);
    expect(text).not.toContain('@@');
    expect(text).toContain('\\author{OverLyX}');   // not the reader's name, nor addressed by it (AGENTS.md)
    expect(text).toContain('% OverLyX: double angle brackets');
    const doc = parseTex(text).doc;
    expect(getTextClass(doc)).toBe('article');
    const kinds = new Set<string>();
    for (const { inset } of walkInsets(doc.body)) kinds.add(inset.type === 'Text' ? `${inset.name} ${inset.arg}`.trim() : inset.type === 'Leaf' ? `${inset.name} ${inset.arg}`.trim() : inset.type);
    for (const needle of ['Float figure', 'Float table', 'Tabular', 'FormulaMacro', 'CommandInset bibtex', 'Note Note', 'Note Comment', 'Foot', 'CommandInset citation', 'Formula']) {
      expect([...kinds], needle).toContain(needle);
    }
    expect(doc.body.some(p => p.layout === 'Description')).toBe(true);
    expect(text).toContain('\\llangle');
  });

  it.skipIf(!HAVE_LATEXMK)('compiles with pdflatex', () => {
    const dir = join(SCRATCH, 'project');
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(join(dir, 'figures'), { recursive: true });
    writeFileSync(join(dir, 'welcome.tex'), fillIn(template));
    copyFileSync(join(TPL, 'refs.bib'), join(dir, 'refs.bib'));
    copyFileSync(join(TPL, 'figures', 'waves.pdf'), join(dir, 'figures', 'waves.pdf'));
    spawnSync('latexmk', ['-pdf', '-bibtex', '-interaction=nonstopmode', '-f', 'welcome.tex'], { cwd: dir, timeout: 240000 });
    const log = existsSync(join(dir, 'welcome.log')) ? readFileSync(join(dir, 'welcome.log'), 'latin1') : '';
    const errors = log.split('\n').filter(l => l.startsWith('! '));
    expect(errors, errors.join('\n')).toEqual([]);
    expect(existsSync(join(dir, 'welcome.pdf'))).toBe(true);
    expect(log).not.toMatch(/Citation .* undefined/);
    expect(log).not.toMatch(/Reference .* undefined/);
  });
});
