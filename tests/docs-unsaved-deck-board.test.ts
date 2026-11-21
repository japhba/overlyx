/**
 * Edits the server stored (the Yjs state, within a second) but had not written to the file (1.5–10 s
 * later) when it stopped — a crash, a hard kill, a save that kept failing — for the kinds the 14 Nov
 * fix (docs-unsaved-state.cases.ts) did not cover: HTML deliverables (decks, posters, web pages:
 * HtmlDoc) and boards (BoardDoc). The next open used to load the file over a deck's edits, and kept
 * a board's without ever writing them (or dropped them when the file had changed). Now the unsaved
 * state is kept and written; a file changed meanwhile is merged three-way against the file text
 * the state was based on (a deck by lines, a board by objects); where both changed the same thing
 * the file's version is taken and the rescued state is kept as a version in History.
 * An HTML article is a document (OpenDoc): covered by the 14 Nov fix, checked here too.
 */
import { describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-unsaved-deck-board-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_DOC_WORKERS = '0';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
const dir = join(ROOT, 'projects', 'u', 'p');
mkdirSync(dir, { recursive: true });

const { manager, HtmlDoc, BoardDoc } = await import('../packages/server/src/docs.ts');
type Doc = Awaited<ReturnType<typeof manager.open>>;

const restart = (doc: unknown) => (manager as any).forgetDoc(doc);
async function waitFor(f: () => boolean, ms = 5000): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise(r => setTimeout(r, 50))) if (f()) return true;
  return f();
}
const quiet = () => { vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined); vi.spyOn(console, 'warn').mockImplementation(() => undefined); };
const versions = (id: string) => manager.listVersions(id).map(v => ({ name: v.name, text: manager.getVersion(id, v.id)!.lyx }));

/* ------------------------------------------------------------------ decks */

const deck = (...slides: string[]) => '<!doctype html>\n<html>\n<head>\n<meta name="overlyx" content="deck">\n<title>Talk</title>\n</head>\n<body>\n'
  + slides.map(s => `<section class="slide">\n  <h1>${s}</h1>\n  <p>Body of ${s}.</p>\n</section>\n`).join('') + '</body>\n</html>\n';
const FIVE = deck('One', 'Two', 'Three', 'Four', 'Five');
/** the five-slide deck with some passages replaced */
const deckWith = (...pairs: [string, string][]) => pairs.reduce((t, [a, b]) => t.replace(a, b), FIVE);
let nd = 0;
async function freshDeck(): Promise<{ id: string; file: string; doc: InstanceType<typeof HtmlDoc> }> {
  const name = `deck${++nd}.html`;
  writeFileSync(join(dir, name), deck('One', 'Two', 'Three', 'Four', 'Five'));
  const id = `u/p/${name}`;
  const doc = await manager.open(id);
  expect(doc).toBeInstanceOf(HtmlDoc);
  return { id, file: join(dir, name), doc: doc as InstanceType<typeof HtmlDoc> };
}
/** an edit in the editor: the text spliced where `from` was (the first occurrence) */
function editDeck(doc: Doc, from: string, to: string): void {
  const h = (doc as InstanceType<typeof HtmlDoc>).html;
  const at = h.toString().indexOf(from);
  expect(at).toBeGreaterThanOrEqual(0);
  doc.ydoc.transact(() => { h.delete(at, from.length); h.insert(at, to); }, 'test');
}

describe('decks: edits stored but not written when the server stopped', () => {
  it('a restart after a kill: kept, written to the file, and an editor that reconnects keeps them', async () => {
    quiet();
    const { id, file, doc } = await freshDeck();
    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(doc.ydoc));
    editDeck(doc, '<h1>Two</h1>', '<h1>Two EDITED HERE</h1>');
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(doc.ydoc, Y.encodeStateVector(editor)));
    doc.persistState();                      // the persist timer ran; the save did not
    restart(doc);
    expect(readFileSync(file, 'utf8')).not.toContain('EDITED HERE');
    const again = await manager.open(id) as InstanceType<typeof HtmlDoc>;
    expect(again.html.toString()).toContain('EDITED HERE');
    Y.applyUpdate(again.ydoc, Y.encodeStateAsUpdate(editor, Y.encodeStateVector(again.ydoc)));
    expect(again.html.toString()).toBe(deckWith(['<h1>Two</h1>', '<h1>Two EDITED HERE</h1>']));
    expect(await waitFor(() => readFileSync(file, 'utf8').includes('EDITED HERE'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(deckWith(['<h1>Two</h1>', '<h1>Two EDITED HERE</h1>']));
    // written: stored as saved again, so the next open is the usual one
    restart(again);
    const third = await manager.open(id);
    expect(third.dirty).toBe(false);
    expect(third.toText()).toContain('EDITED HERE');
    restart(third);
  });

  it('a save that failed, then a restart: kept and written once the file can be written', async () => {
    quiet();
    const { id, file, doc } = await freshDeck();
    chmodSync(dir, 0o555);
    try {
      editDeck(doc, '<h1>Three</h1>', '<h1>Three AN HOUR OF WORK</h1>');
      expect(await doc.saveToFile()).toBe(false);
      doc.persistState();
      restart(doc);
    } finally { chmodSync(dir, 0o755); }
    const again = await manager.open(id);
    expect(again.toText()).toContain('AN HOUR OF WORK');
    expect(await waitFor(() => readFileSync(file, 'utf8').includes('AN HOUR OF WORK'))).toBe(true);
    restart(again);
  });

  it('the normal path: a saved state of an unchanged file opens as it was, nothing written', async () => {
    quiet();
    const { id, file, doc } = await freshDeck();
    editDeck(doc, '<h1>Two</h1>', '<h1>Two saved</h1>');
    expect(await doc.saveToFile()).toBe(true);
    restart(doc);
    const bytes = readFileSync(file, 'utf8'), mtime = statSync(file).mtimeMs;
    const again = await manager.open(id);
    expect(again.toText()).toContain('Two saved');
    expect(again.dirty).toBe(false);
    await new Promise(r => setTimeout(r, 300));
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(statSync(file).mtimeMs).toBe(mtime);
    restart(again);
  });

  it('the file changed while closed (another slide), the state not saved: both, merged by lines', async () => {
    quiet();
    const { id, file, doc } = await freshDeck();
    editDeck(doc, '<h1>One</h1>', '<h1>One EDITED HERE</h1>');
    editDeck(doc, '<p>Body of Five.</p>', '<p>Body of Five EDITED HERE TOO.</p>');
    doc.persistState();
    restart(doc);
    // the file changed in between the two edits (one region by prefix/suffix would overlap both)
    writeFileSync(file, deckWith(['<h1>Three</h1>', '<h1>Three CHANGED ON DISK</h1>']));
    const again = await manager.open(id);
    const want = deckWith(['<h1>One</h1>', '<h1>One EDITED HERE</h1>'], ['<h1>Three</h1>', '<h1>Three CHANGED ON DISK</h1>'], ['Body of Five.', 'Body of Five EDITED HERE TOO.']);
    expect(again.toText()).toBe(want);
    expect(await waitFor(() => readFileSync(file, 'utf8') === want)).toBe(true);
    expect(versions(id).filter(v => v.name !== 'autosave')).toEqual([]);
    restart(again);
  });

  it('the file changed while closed in the same line: the file\'s line, the rescued state kept as a version', async () => {
    quiet();
    const { id, file, doc } = await freshDeck();
    editDeck(doc, '<h1>Two</h1>', '<h1>Deux EDITED HERE</h1>');
    editDeck(doc, '<h1>Five</h1>', '<h1>Five EDITED HERE</h1>');
    doc.persistState();
    restart(doc);
    writeFileSync(file, deckWith(['<h1>Two</h1>', '<h1>Two CHANGED ON DISK</h1>']));
    const again = await manager.open(id);
    // the line both changed: the file's; the rest merged
    expect(again.toText()).toBe(deckWith(['<h1>Two</h1>', '<h1>Two CHANGED ON DISK</h1>'], ['<h1>Five</h1>', '<h1>Five EDITED HERE</h1>']));
    const kept = versions(id).find(v => v.text.includes('Deux EDITED HERE'));
    expect(kept).toBeDefined();
    expect(kept!.text).toBe(deckWith(['<h1>Two</h1>', '<h1>Deux EDITED HERE</h1>'], ['<h1>Five</h1>', '<h1>Five EDITED HERE</h1>']));
    expect(await waitFor(() => readFileSync(file, 'utf8').includes('Five EDITED HERE'))).toBe(true);
    restart(again);
  });
});

describe('decks: a change on disk while open', () => {
  it('the disk rewrote the very words typed here: the file\'s words, the typing kept as a version (it used to vanish)', async () => {
    quiet();
    const { id, doc } = await freshDeck();
    editDeck(doc, '<h1>Two</h1>', '<h1>Deux TYPED</h1>');
    const disk = FIVE.replace('<h1>Two</h1>', '<h1>Second ON DISK</h1>');
    expect(doc.absorbExternalChange(disk)).toBe(true);
    expect(doc.toText()).toBe(disk);
    expect(versions(id).find(v => v.name === 'before a change on disk')?.text).toBe(FIVE.replace('<h1>Two</h1>', '<h1>Deux TYPED</h1>'));
    restart(doc);
  });

  it('a change on disk elsewhere in the same line as the typing still goes in beside it', async () => {
    quiet();
    const { doc } = await freshDeck();
    editDeck(doc, '<p>Body of Two.</p>', '<p>Body of Two TYPED.</p>');
    doc.absorbExternalChange(FIVE.replace('<p>Body of Two.</p>', '<p class="x">Body of Two.</p>'));
    expect(doc.toText()).toBe(FIVE.replace('<p>Body of Two.</p>', '<p class="x">Body of Two TYPED.</p>'));
    restart(doc);
  });
});

/* ------------------------------------------------------------------ boards */

const board = (objs: Record<string, unknown>) => {
  const keys = Object.keys(objs).sort();
  return '{"overlyx":"board","v":1,"objects":{' + keys.map(k => `\n${JSON.stringify(k)}: ${JSON.stringify(objs[k])}`).join(',') + '\n}}\n';
};
const note = (text: string, x = 0) => ({ type: 'note', x, y: 0, text });
let nb = 0;
async function freshBoard(): Promise<{ id: string; file: string; doc: InstanceType<typeof BoardDoc> }> {
  const name = `b${++nb}.board`;
  writeFileSync(join(dir, name), board({ a: note('Alpha'), b: note('Beta', 10), c: note('Gamma', 20) }));
  const id = `u/p/${name}`;
  const doc = await manager.open(id);
  expect(doc).toBeInstanceOf(BoardDoc);
  return { id, file: join(dir, name), doc: doc as InstanceType<typeof BoardDoc> };
}
const setObj = (doc: Doc, k: string, v: unknown) => doc.ydoc.transact(() => { if (v === undefined) (doc as InstanceType<typeof BoardDoc>).objects.delete(k); else (doc as InstanceType<typeof BoardDoc>).objects.set(k, v); }, 'test');
const objectsOf = (text: string) => (JSON.parse(text) as { objects: Record<string, unknown> }).objects;

describe('boards: edits stored but not written when the server stopped', () => {
  it('a restart after a kill: kept and written to the file', async () => {
    quiet();
    const { id, file, doc } = await freshBoard();
    setObj(doc, 'd', note('Delta DRAWN HERE', 30));
    setObj(doc, 'a', note('Alpha EDITED HERE'));
    doc.persistState();
    restart(doc);
    expect(readFileSync(file, 'utf8')).not.toContain('HERE');
    const again = await manager.open(id);
    expect(again.toText()).toContain('DRAWN HERE');
    expect(await waitFor(() => readFileSync(file, 'utf8').includes('DRAWN HERE'))).toBe(true);
    expect(objectsOf(readFileSync(file, 'utf8'))).toEqual({ a: note('Alpha EDITED HERE'), b: note('Beta', 10), c: note('Gamma', 20), d: note('Delta DRAWN HERE', 30) });
    restart(again);
    const third = await manager.open(id);
    expect(third.dirty).toBe(false);
    restart(third);
  });

  it('the normal path: a saved state of an unchanged file opens as it was, nothing written', async () => {
    quiet();
    const { id, file, doc } = await freshBoard();
    setObj(doc, 'd', note('Delta saved', 30));
    expect(await doc.saveToFile()).toBe(true);
    restart(doc);
    const bytes = readFileSync(file, 'utf8'), mtime = statSync(file).mtimeMs;
    const again = await manager.open(id);
    expect(again.toText()).toContain('Delta saved');
    expect(again.dirty).toBe(false);
    await new Promise(r => setTimeout(r, 300));
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(statSync(file).mtimeMs).toBe(mtime);
    restart(again);
  });

  it('the file changed while closed (other objects), the state not saved: both, merged by objects', async () => {
    quiet();
    const { id, file, doc } = await freshBoard();
    setObj(doc, 'd', note('Delta DRAWN HERE', 30));
    setObj(doc, 'b', undefined);                       // erased here
    doc.persistState();
    restart(doc);
    writeFileSync(file, board({ a: note('Alpha'), b: note('Beta', 10), c: note('Gamma CHANGED ON DISK', 20), e: note('Epsilon ADDED ON DISK') }));
    const again = await manager.open(id);
    const want = { a: note('Alpha'), c: note('Gamma CHANGED ON DISK', 20), d: note('Delta DRAWN HERE', 30), e: note('Epsilon ADDED ON DISK') };
    expect(objectsOf(again.toText())).toEqual(want);
    expect(await waitFor(() => readFileSync(file, 'utf8').includes('DRAWN HERE'))).toBe(true);
    expect(objectsOf(readFileSync(file, 'utf8'))).toEqual(want);
    expect(versions(id).filter(v => v.name !== 'autosave')).toEqual([]);
    restart(again);
  });

  it('the same object changed on both sides: the file\'s, the rescued board kept as a version', async () => {
    quiet();
    const { id, doc } = await freshBoard();
    setObj(doc, 'a', note('Alpha EDITED HERE'));
    setObj(doc, 'd', note('Delta DRAWN HERE', 30));
    doc.persistState();
    restart(doc);
    writeFileSync(join(dir, id.split('/').pop()!), board({ a: note('Alpha CHANGED ON DISK'), b: note('Beta', 10), c: note('Gamma', 20) }));
    const again = await manager.open(id);
    expect(objectsOf(again.toText())).toEqual({ a: note('Alpha CHANGED ON DISK'), b: note('Beta', 10), c: note('Gamma', 20), d: note('Delta DRAWN HERE', 30) });
    const kept = versions(id).find(v => v.text.includes('Alpha EDITED HERE'));
    expect(kept).toBeDefined();
    expect(objectsOf(kept!.text)).toEqual({ a: note('Alpha EDITED HERE'), b: note('Beta', 10), c: note('Gamma', 20), d: note('Delta DRAWN HERE', 30) });
    restart(again);
  });
});

/* ------------------------------------------------------------------ articles */

describe('articles (documents): covered by the 14 Nov fix', () => {
  const article = (...pars: string[]) => '<!doctype html>\n<html>\n<head>\n<meta name="overlyx" content="article">\n<title>Notes</title>\n</head>\n<body>\n<h1>Notes</h1>\n'
    + pars.map(p => `<p>${p}</p>\n`).join('') + '</body>\n</html>\n';
  it('a restart after a kill: kept and written', async () => {
    quiet();
    const file = join(dir, 'art.html');
    writeFileSync(file, article('Alpha one.', 'Beta two.', 'Gamma three.'));
    const doc = await manager.open('u/p/art.html');
    expect(doc).not.toBeInstanceOf(HtmlDoc);
    doc.loadFromLyx(doc.parse(article('Alpha one.', 'Beta two EDITED HERE.', 'Gamma three.')), 'test');
    doc.persistState();
    restart(doc);
    expect(readFileSync(file, 'utf8')).not.toContain('EDITED HERE');
    const again = await manager.open('u/p/art.html');
    expect(again.toText()).toContain('EDITED HERE');
    expect(await waitFor(() => readFileSync(file, 'utf8').includes('EDITED HERE'))).toBe(true);
    restart(again);
  });
});
