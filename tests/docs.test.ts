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

const { manager, readTextFile } = await import('../packages/server/src/docs.ts');
const { db } = await import('../packages/server/src/db.ts');
const { parseTex, writeTex } = await import('../packages/core/src/tex/index.ts');

const HEAD = '\\documentclass{article}\n\\begin{document}\n';
const TAIL = '\\end{document}\n';
const par = (t: string) => `${t}\n\n`;
const docText = (...pars: string[]) => HEAD + pars.map(par).join('') + TAIL;
/** what the writer makes of a document (the file on disk after a save) */
const canon = (text: string) => writeTex(parseTex(text).doc).text;

const file = (name: string) => join(ROOT, 'projects', 'p', name);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Simulate a user's edit: load a modified document as a non-file origin (the manager schedules a save). */
function edit(doc: Awaited<ReturnType<typeof manager.open>>, text: string) {
  doc.loadFromLyx(doc.parse(text), 'test');
}

beforeAll(() => {
  writeFileSync(file('a.tex'), docText('one', 'two', 'three'));
});

describe('saving', () => {
  it('an edit is written to the file, in canonical form, and a second save changes nothing', async () => {
    const doc = await manager.open('p/a.tex');
    edit(doc, docText('one', 'two edited', 'three'));
    expect(doc.dirty).toBe(true);
    expect(await doc.saveToFile()).toBe(true);
    const onDisk = readFileSync(file('a.tex'), 'utf8');
    expect(onDisk).toBe(canon(docText('one', 'two edited', 'three')));
    expect(onDisk).toContain('two edited');
    expect(onDisk).toContain('\\begin{document}');
    expect(doc.dirty).toBe(false);
    // idempotent: the file is exactly what the document produces
    expect(doc.toText()).toBe(onDisk);
  });

  it('a change written to the file meanwhile (git, another editor) is merged, not overwritten', async () => {
    const doc = await manager.open('p/a.tex');
    // someone else changes paragraph 1 on disk while paragraph 3 is edited here (save pending)
    writeFileSync(file('a.tex'), docText('one from Overleaf', 'two edited', 'three'));
    edit(doc, docText('one', 'two edited', 'three from the web'));
    expect(await doc.saveToFile()).toBe(true);
    const onDisk = readFileSync(file('a.tex'), 'utf8');
    expect(onDisk).toContain('one from Overleaf');
    expect(onDisk).toContain('three from the web');
  });

  it('never replaces the file with something that is not a document', async () => {
    const doc = await manager.open('p/a.tex');
    const before = readFileSync(file('a.tex'), 'utf8');
    const orig = doc.toText.bind(doc);
    doc.toText = () => '';
    try {
      doc.dirty = true;
      expect(await doc.saveToFile()).toBe(false);
      expect(doc.saveError).toMatch(/not a document/);
      expect(readFileSync(file('a.tex'), 'utf8')).toBe(before);
    } finally { doc.toText = orig; }
    // a later save works again
    edit(doc, docText('one from Overleaf', 'two edited', 'three from the web', 'four'));
    expect(await doc.saveToFile()).toBe(true);
    expect(doc.saveError).toBeNull();
    expect(readFileSync(file('a.tex'), 'utf8')).toContain('four');
  });

  it('keeps a version of the old content before a drastic shrink', async () => {
    writeFileSync(file('big.tex'), docText(...Array.from({ length: 120 }, (_, i) => `paragraph number ${i} with some words in it to make it long enough`)));
    const doc = await manager.open('p/big.tex');
    edit(doc, docText('almost everything deleted'));
    expect(await doc.saveToFile()).toBe(true);
    expect(readFileSync(file('big.tex'), 'utf8')).toContain('almost everything deleted');
    const v = db.prepare("SELECT name, lyx FROM versions WHERE doc_id = ? AND name = 'before large deletion'").get('p/big.tex') as { name: string; lyx: string } | undefined;
    expect(v).toBeDefined();
    expect(v!.lyx).toContain('paragraph number 119');
  });

  it('refuses to open something that is not a .tex document', async () => {
    writeFileSync(file('junk.lyx'), 'this is not lyx\n');
    await expect(manager.open('p/junk.lyx')).rejects.toThrow(/not a .tex document/);
  });

  it('opens a fragment (child document without a preamble) and writes it back as one', async () => {
    writeFileSync(file('child.tex'), 'A child paragraph.\n\nAnother one with $x$.\n');
    const doc = await manager.open('p/child.tex');
    expect(doc.isChild).toBe(true);
    edit(doc, 'A child paragraph, edited.\n\nAnother one with $x$.\n');
    expect(await doc.saveToFile()).toBe(true);
    const onDisk = readFileSync(file('child.tex'), 'utf8');
    expect(onDisk).not.toContain('\\begin{document}');
    expect(onDisk).toContain('A child paragraph, edited.');
    expect(onDisk).toMatch(/^%% overlyx-settings: /);
  });

  it('reads a latin-1 file without turning bytes into U+FFFD', () => {
    writeFileSync(file('latin.tex'), Buffer.from(docText('caf\xe9'), 'latin1'));
    expect(readTextFile(file('latin.tex'))).toContain('café');
  });

  it('restores a version stored in LyX format (from before the switch, or offline edits)', async () => {
    const doc = await manager.open('p/a.tex');
    const lyx = '#LyX 2.5 created this file. For more info see https://www.lyx.org/\n\\lyxformat 643\n\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\n\\begin_body\n\n\\begin_layout Standard\nfrom a LyX version\n\\end_layout\n\n\\end_body\n\\end_document\n';
    const vid = await manager.createVersion('p/a.tex', 'lyx version', 'test', 'offline', lyx);
    await manager.restoreVersion('p/a.tex', vid, 'test');
    expect(doc.toText()).toContain('from a LyX version');
    expect(doc.toText()).toContain('\\begin{document}');
  });
});

describe('the file disappears', () => {
  it('closes the document and keeps its content as a version', async () => {
    writeFileSync(file('gone.tex'), docText('will be deleted'));
    const doc = await manager.open('p/gone.tex');
    edit(doc, docText('will be deleted', 'unsaved edit'));
    await sleep(300);           // let chokidar settle on the file
    unlinkSync(file('gone.tex'));
    for (let i = 0; i < 60 && manager.docs.has('p/gone.tex'); i++) await sleep(100);
    expect(manager.docs.has('p/gone.tex')).toBe(false);
    expect(existsSync(file('gone.tex'))).toBe(false);   // not re-created by a pending save
    const v = db.prepare("SELECT lyx FROM versions WHERE doc_id = ? AND name = 'file removed on disk'").get('p/gone.tex') as { lyx: string } | undefined;
    expect(v?.lyx).toContain('unsaved edit');
  }, 15000);
});
