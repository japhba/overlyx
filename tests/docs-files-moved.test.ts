/**
 * A document whose file is renamed or deleted through the app's file operations (index.ts fileops →
 * DocManager.closeUnder / filesMoved): what the open document holds is written before the file moves, so the renamed
 * (or trashed) file has the typing of the last seconds; a renamed document keeps its History, its
 * public PDF link, its last build and each person's view state; the stored CRDT state of the old
 * name and of the new goes. Before, the route only renamed the file: the typing since the last save
 * ended up as a version of a name that no longer existed, and History and the public link stayed
 * with that name.
 *
 * Document workers on, as in production.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-files-moved-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_DOC_WORKERS = '1';
  // nothing is written by the timer here: the documents stay unsaved until the code under test saves them
  process.env.OVERLYX_SAVE_DEBOUNCE = '600000';
  process.env.OVERLYX_SAVE_MAX_WAIT = '600000';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });

const { manager, docWorkers, HtmlDoc } = await import('../packages/server/src/docs.ts');
const { db } = await import('../packages/server/src/db.ts');
const { config } = await import('../packages/server/src/config.ts');
const { buildDirPath } = await import('../packages/server/src/namespaces.ts');

const doc = (...p: string[]) => '\\documentclass{article}\n\\begin{document}\n' + p.map(x => x + '\n\n').join('') + '\\end{document}\n';
const file = (...rel: string[]) => join(ROOT, 'projects', 'u', 'p', ...rel);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ids = (table: string, col: string) => (db.prepare(`SELECT ${col} AS id FROM ${table}`).all() as { id: string }[]).map(r => r.id);
const versionNames = (id: string) => (db.prepare('SELECT name FROM versions WHERE doc_id = ?').all(id) as { name: string }[]).map(v => v.name);
type Doc = Awaited<ReturnType<typeof manager.open>>;
/** an edit as an editor's update arrives: the document is unsaved from here */
const type = (d: Doc, text: string) => d.loadFromLyx(d.parse(text), 'test');

afterAll(async () => { await docWorkers.close(); });

describe('renamed through the app', () => {
  it('right after typing: the renamed file has the typing; History, the PDF link, the build and the folds follow', async () => {
    expect(config.dataDir.startsWith(ROOT)).toBe(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeFileSync(file('a.tex'), doc('Alpha.', 'Beta.'));
    const id = 'u/p/a.tex', to = 'u/p/b.tex';
    const d = await manager.open(id);
    await manager.createVersion(id, 'first draft', 'ada');
    db.prepare('INSERT INTO pdf_links (token, doc_id, created_at) VALUES (?,?,?)').run('token-of-a-0123456789', id, 1);
    db.prepare("INSERT INTO user_doc_state (user_id, doc_id, key, value, updated_at) VALUES (1, ?, 'folds', '[2]', 1)").run(id);
    const dir = buildDirPath(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.pdf'), '%PDF-1.5');
    db.prepare('INSERT INTO builds (doc_id, status, log, pdf_path, tex_path, updated_at) VALUES (?,?,?,?,?,?)').run(id, 'ok', '', join(dir, 'a.pdf'), join(dir, 'a.tex'), 1);
    // what an earlier file called b.tex left behind
    db.prepare('INSERT INTO ydocs (id, state, file_hash, updated_at) VALUES (?,?,?,?)').run(to, Buffer.from([0]), 'gone', 1);
    db.prepare('INSERT INTO pdf_links (token, doc_id, created_at) VALUES (?,?,?)').run('token-of-old-b-456789', to, 1);

    type(d, doc('Alpha.', 'Beta.', 'TYPED A MOMENT AGO.'));
    expect(d.dirty).toBe(true);
    expect(readFileSync(file('a.tex'), 'utf8')).not.toContain('TYPED');

    // (the fileops route, op rename)
    await manager.closeUnder(file('a.tex'));
    renameSync(file('a.tex'), file('b.tex'));
    manager.filesMoved('u/p', 'a.tex', 'b.tex');

    expect(readFileSync(file('b.tex'), 'utf8')).toContain('TYPED A MOMENT AGO.');
    expect(manager.docs.has(id)).toBe(false);
    expect(versionNames(to)).toContain('first draft');
    expect(versionNames(id)).toEqual([]);
    // the document's own link replaces the one the name had; its folds and build are under the new name
    expect(db.prepare('SELECT token FROM pdf_links WHERE doc_id = ?').all(to)).toEqual([{ token: 'token-of-a-0123456789' }]);
    expect(ids('pdf_links', 'doc_id')).toEqual([to]);
    expect(ids('user_doc_state', 'doc_id')).toEqual([to]);
    const b = db.prepare('SELECT doc_id, pdf_path FROM builds').all() as { doc_id: string; pdf_path: string }[];
    expect(b.map(r => r.doc_id)).toEqual([to]);
    expect(b[0].pdf_path).toBe(join(buildDirPath(to), 'a.pdf'));
    expect(readFileSync(b[0].pdf_path, 'utf8')).toBe('%PDF-1.5');
    expect(existsSync(dir)).toBe(false);
    expect(ids('ydocs', 'id').filter(x => x === id || x === to)).toEqual([]);
    expect(ids('ydocs_saved', 'id').filter(x => x === id || x === to)).toEqual([]);

    // it opens as the file is; the watcher's late "a.tex is gone" finds nothing to close or keep
    const again = await manager.open(to);
    expect(await again.textAsync()).toBe(readFileSync(file('b.tex'), 'utf8'));
    await sleep(2500);
    expect(versionNames(id)).toEqual([]);
    expect(versionNames(to)).not.toContain('file removed on disk');
  }, 30000);

  it('a folder: the documents in it are written, and their rows follow', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mkdirSync(file('talk', 'deck'), { recursive: true });
    const HTML = '<!doctype html>\n<html><head><meta name="overlyx" content="deck"></head><body>\n<section>One</section>\n</body></html>\n';
    writeFileSync(file('talk', 'deck', 'index.html'), HTML);
    writeFileSync(file('talk', 'notes.tex'), doc('Notes.'));
    const deck = await manager.open('u/p/talk/deck/index.html');
    const notes = await manager.open('u/p/talk/notes.tex');
    expect(deck).toBeInstanceOf(HtmlDoc);
    await manager.createVersion('u/p/talk/deck/index.html', 'before the talk', 'ada');
    deck.ydoc.transact(() => (deck as InstanceType<typeof HtmlDoc>).html.insert(HTML.indexOf('One'), 'SLIDE TYPED '), 'test');
    type(notes, doc('Notes.', 'NOTE TYPED.'));
    expect(deck.dirty && notes.dirty).toBe(true);

    await manager.closeUnder(file('talk'));
    renameSync(file('talk'), file('talk-2027'));
    manager.filesMoved('u/p', 'talk/', 'talk-2027');

    expect(readFileSync(file('talk-2027', 'deck', 'index.html'), 'utf8')).toContain('SLIDE TYPED One');
    expect(readFileSync(file('talk-2027', 'notes.tex'), 'utf8')).toContain('NOTE TYPED.');
    expect(versionNames('u/p/talk-2027/deck/index.html')).toContain('before the talk');
    expect([...manager.docs.keys()].filter(k => k.startsWith('u/p/talk/'))).toEqual([]);
    expect(ids('ydocs', 'id').filter(x => x.startsWith('u/p/talk'))).toEqual([]);
  }, 30000);

  it('deleted: the trashed file has the typing, History stays, the stored state goes; a copy is of the document as it is', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeFileSync(file('c.tex'), doc('Gamma.'));
    const id = 'u/p/c.tex';
    const d = await manager.open(id);
    await manager.createVersion(id, 'kept', 'ada');
    type(d, doc('Gamma.', 'COPIED AS IT IS.'));
    await manager.saveUnder(file('c.tex'));   // (op copy)
    expect(readFileSync(file('c.tex'), 'utf8')).toContain('COPIED AS IT IS.');
    expect(manager.docs.get(id)).toBe(d);
    type(d, doc('Gamma.', 'COPIED AS IT IS.', 'TYPED BEFORE THE DELETE.'));

    await manager.closeUnder(file('c.tex'));
    mkdirSync(join(ROOT, 'trash'), { recursive: true });
    renameSync(file('c.tex'), join(ROOT, 'trash', 'c.tex'));
    manager.filesMoved('u/p', 'c.tex', null);

    expect(readFileSync(join(ROOT, 'trash', 'c.tex'), 'utf8')).toContain('TYPED BEFORE THE DELETE.');
    expect(versionNames(id)).toContain('kept');
    expect(ids('ydocs', 'id')).not.toContain(id);
    expect(ids('ydocs_saved', 'id')).not.toContain(id);
  }, 30000);
});
