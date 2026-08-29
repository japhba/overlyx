/**
 * OpenDoc.health() / .repair() (packages/server/src/docs.ts): detecting and mending structural
 * damage left in a .tex file by an external edit (git, another editor, a bad merge).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-docs-health-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { manager } = await import('../packages/server/src/docs.ts');
const { writeTex, parseTex } = await import('../packages/core/src/tex/index.ts');

const HEAD = '\\documentclass{article}\n\\begin{document}\n';
const TAIL = '\\end{document}\n';
const docText = (t: string) => `${HEAD}${t}\n\n${TAIL}`;
const file = (name: string) => join(ROOT, 'projects', 'p', name);
/** the file as OverLyX itself would write it (managed block included) */
const canon = (text: string) => writeTex(parseTex(text).doc).text;

beforeAll(() => {
  writeFileSync(file('a.tex'), canon(docText('Hello world.')));
});

describe('OpenDoc.health()', () => {
  it('a freshly-saved document has no issues', async () => {
    const doc = await manager.open('p/a.tex');
    expect(doc.health()).toEqual([]);
  });

  it('detects a managed-block marker removed by an external edit', async () => {
    const good = canon(docText('Some text.'));
    const broken = good.replace(/%% end OverLyX.*\n/, '');
    writeFileSync(file('b.tex'), broken);
    const doc = await manager.open('p/b.tex');
    const issues = doc.health();
    expect(issues.some(i => i.code === 'managed-block-missing-end')).toBe(true);
  });

  it('detects unbalanced braces from a botched external edit', async () => {
    const good = canon(docText('Some text.'));
    const broken = good.replace('Some text.', 'Some \\textbf{text.');
    writeFileSync(file('c.tex'), broken);
    const doc = await manager.open('p/c.tex');
    expect(doc.health().some(i => i.code === 'brace-imbalance')).toBe(true);
  });
});

describe('OpenDoc.repair()', () => {
  it('mends a missing marker, keeps the content, and writes the fix to disk', async () => {
    const good = canon(docText('Repair me.'));
    const broken = good.replace(/%% end OverLyX.*\n/, '');
    writeFileSync(file('d.tex'), broken);
    const doc = await manager.open('p/d.tex');
    expect(doc.health().length).toBeGreaterThan(0);
    const r = doc.repair();
    expect(r.fixed).toContain('managed-block-missing-end');
    expect(r.remaining).toEqual([]);
    expect(doc.health()).toEqual([]);
    expect(doc.toText()).toContain('Repair me.');
    // saveToFile() is fire-and-forget from repair(); give the debounce timer a tick
    await doc.saveToFile();
    expect(readFileSync(file('d.tex'), 'utf8')).toContain('Repair me.');
  });

  it('a snapshot of the broken file is kept as a version before repairing', async () => {
    const good = canon(docText('Snapshot me.'));
    const broken = good.replace(/%% end OverLyX.*\n/, '');
    writeFileSync(file('e.tex'), broken);
    const doc = await manager.open('p/e.tex');
    doc.repair();
    const { db } = await import('../packages/server/src/db.ts');
    const v = db.prepare("SELECT name, lyx FROM versions WHERE doc_id = ? AND name = 'before repair'").get('p/e.tex') as { name: string; lyx: string } | undefined;
    expect(v?.lyx).toBe(broken);
  });

  it('does nothing (and reports the remaining issue) when nothing is mechanically fixable', async () => {
    const good = canon(docText('Cannot fix this.'));
    const broken = good.replace('\\begin{document}', '\\begin{document}\n\\begin{document}');
    writeFileSync(file('f.tex'), broken);
    const doc = await manager.open('p/f.tex');
    const r = doc.repair();
    expect(r.fixed).toEqual([]);
    expect(r.remaining.some(i => i.code === 'document-boundary')).toBe(true);
  });
});
