/**
 * The document manager (packages/server/src/docs.ts) against a scratch projects directory:
 * saving, merging changes made on disk while edits were pending, refusing to write garbage,
 * keeping a version before a drastic shrink, and closing a document whose file was deleted.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-docs-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { manager, readLyxFile } = await import('../packages/server/src/docs.ts');
const { db } = await import('../packages/server/src/db.ts');
const { parseLyx } = await import('../packages/core/src/lyx/parser.ts');

const HEAD = `#LyX 2.5 created this file. For more info see https://www.lyx.org/
\\lyxformat 643
\\begin_document
\\begin_header
\\textclass article
\\end_header

\\begin_body
`;
const TAIL = `
\\end_body
\\end_document
`;
const par = (t: string) => `\n\\begin_layout Standard\n${t}\n\\end_layout\n`;
const docText = (...pars: string[]) => HEAD + pars.map(par).join('') + TAIL;

const file = (name: string) => join(ROOT, 'projects', 'p', name);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Simulate a user's edit: load a modified document as a non-file origin (the manager schedules a save). */
function edit(doc: Awaited<ReturnType<typeof manager.open>>, text: string) {
  doc.loadFromLyx(parseLyx(text), 'test');
}

beforeAll(() => {
  writeFileSync(file('a.lyx'), docText('one', 'two', 'three'));
});

describe('saving', () => {
  it('an edit is written to the file', async () => {
    const doc = await manager.open('p/a.lyx');
    edit(doc, docText('one', 'two edited', 'three'));
    expect(doc.dirty).toBe(true);
    expect(await doc.saveToFile()).toBe(true);
    expect(readFileSync(file('a.lyx'), 'utf8')).toBe(docText('one', 'two edited', 'three'));
    expect(doc.dirty).toBe(false);
  });

  it('a change written to the file meanwhile (desktop LyX, git) is merged, not overwritten', async () => {
    const doc = await manager.open('p/a.lyx');
    // someone else changes paragraph 1 on disk while paragraph 3 is edited here (save pending)
    writeFileSync(file('a.lyx'), docText('one from LyX', 'two edited', 'three'));
    edit(doc, docText('one', 'two edited', 'three from the web'));
    expect(await doc.saveToFile()).toBe(true);
    const onDisk = readFileSync(file('a.lyx'), 'utf8');
    expect(onDisk).toContain('one from LyX');
    expect(onDisk).toContain('three from the web');
  });

  it('never replaces the file with something that is not a LyX document', async () => {
    const doc = await manager.open('p/a.lyx');
    const before = readFileSync(file('a.lyx'), 'utf8');
    const orig = doc.toLyxText.bind(doc);
    doc.toLyxText = () => '';
    try {
      doc.dirty = true;
      expect(await doc.saveToFile()).toBe(false);
      expect(doc.saveError).toMatch(/not a LyX document/);
      expect(readFileSync(file('a.lyx'), 'utf8')).toBe(before);
    } finally { doc.toLyxText = orig; }
    // a later save works again
    edit(doc, docText('one from LyX', 'two edited', 'three from the web', 'four'));
    expect(await doc.saveToFile()).toBe(true);
    expect(doc.saveError).toBeNull();
    expect(readFileSync(file('a.lyx'), 'utf8')).toContain('four');
  });

  it('keeps a version of the old content before a drastic shrink', async () => {
    writeFileSync(file('big.lyx'), docText(...Array.from({ length: 120 }, (_, i) => `paragraph number ${i} with some words in it to make it long enough`)));
    const doc = await manager.open('p/big.lyx');
    edit(doc, docText('almost everything deleted'));
    expect(await doc.saveToFile()).toBe(true);
    expect(readFileSync(file('big.lyx'), 'utf8')).toContain('almost everything deleted');
    const v = db.prepare("SELECT name, lyx FROM versions WHERE doc_id = ? AND name = 'before large deletion'").get('p/big.lyx') as { name: string; lyx: string } | undefined;
    expect(v).toBeDefined();
    expect(v!.lyx).toContain('paragraph number 119');
  });

  it('refuses to open a file that is not a LyX document', async () => {
    writeFileSync(file('junk.lyx'), 'this is not lyx\n');
    await expect(manager.open('p/junk.lyx')).rejects.toThrow(/not a LyX document/);
  });

  it('reads a latin-1 file without turning bytes into U+FFFD', () => {
    writeFileSync(file('latin.lyx'), Buffer.from(docText('caf\xe9'), 'latin1'));
    expect(readLyxFile(file('latin.lyx'))).toContain('café');
  });
});

describe('the file disappears', () => {
  it('closes the document and keeps its content as a version', async () => {
    writeFileSync(file('gone.lyx'), docText('will be deleted'));
    const doc = await manager.open('p/gone.lyx');
    edit(doc, docText('will be deleted', 'unsaved edit'));
    await sleep(300);           // let chokidar settle on the file
    unlinkSync(file('gone.lyx'));
    for (let i = 0; i < 60 && manager.docs.has('p/gone.lyx'); i++) await sleep(100);
    expect(manager.docs.has('p/gone.lyx')).toBe(false);
    expect(existsSync(file('gone.lyx'))).toBe(false);   // not re-created by a pending save
    const v = db.prepare("SELECT lyx FROM versions WHERE doc_id = ? AND name = 'file removed on disk'").get('p/gone.lyx') as { lyx: string } | undefined;
    expect(v?.lyx).toContain('unsaved edit');
  }, 15000);
});
