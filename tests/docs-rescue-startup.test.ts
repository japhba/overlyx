/**
 * The pass at server start that writes edits stored but not written before the stop (server
 * rescue.ts): every kind of document is written through the same path an open takes, one at a time,
 * and closed again; open documents, end-to-end encrypted projects, documents too large and files that
 * are gone are skipped with a line; nothing throws. With document workers, as in production.
 */
import { it, expect, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-rescue-startup-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_DOC_WORKERS = '1';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
const dir = join(ROOT, 'projects', 'u', 'p');
mkdirSync(dir, { recursive: true });
mkdirSync(join(ROOT, 'projects', 'u', 'secret'), { recursive: true });

const { manager, HtmlDoc, BoardDoc } = await import('../packages/server/src/docs.ts');
const { writeRescuedEdits } = await import('../packages/server/src/rescue.ts');
const { db } = await import('../packages/server/src/db.ts');
type Doc = Awaited<ReturnType<typeof manager.open>>;

const restart = (doc: unknown) => (manager as any).forgetDoc(doc);
const tex = (...pars: string[]) => '\\documentclass{article}\n\\begin{document}\n' + pars.map(t => `${t}\n\n`).join('') + '\\end{document}\n';
const md = (...pars: string[]) => '# Title\n\n' + pars.join('\n\n') + '\n';
const deck = (title: string) => `<!doctype html>\n<html>\n<head>\n<meta name="overlyx" content="deck">\n</head>\n<body>\n<section class="slide">\n  <h1>${title}</h1>\n</section>\n</body>\n</html>\n`;
const board = (text: string) => `{"overlyx":"board","v":1,"objects":{\n"a": ${JSON.stringify({ type: 'note', text })}\n}}\n`;

/** a document opened, edited, its state stored (the persist timer ran) — and the server stops before the save */
async function editedThenKilled(rel: string, text: string, edit: (doc: Doc) => void, kill = true): Promise<{ id: string; file: string; doc: Doc }> {
  const file = join(ROOT, 'projects', ...rel.split('/'));
  writeFileSync(file, text);
  const id = rel;
  const doc = await manager.open(id);
  edit(doc);
  await doc.persistStateAsync();
  if (kill) restart(doc);
  return { id, file, doc };
}
const editText = (doc: Doc, make: (...p: string[]) => string) => doc.loadFromLyx(doc.parse(make('Alpha one.', 'Beta RESCUED.')), 'test');
const editDeck = (doc: Doc) => { const h = (doc as InstanceType<typeof HtmlDoc>).html; const at = h.toString().indexOf('</h1>'); doc.ydoc.transact(() => h.insert(at, ' RESCUED'), 'test'); };
const editBoard = (doc: Doc) => doc.ydoc.transact(() => (doc as InstanceType<typeof BoardDoc>).objects.set('b', { type: 'note', text: 'RESCUED' }), 'test');

it('writes every kind of document\'s unsaved edits at the start, closes them again, and skips what it must', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);

  const a = await editedThenKilled('u/p/a.tex', tex('Alpha one.', 'Beta two.'), d => editText(d, tex));
  const b = await editedThenKilled('u/p/b.md', md('Alpha one.', 'Beta two.'), d => editText(d, md));
  const c = await editedThenKilled('u/p/c.html', deck('Title'), editDeck);
  const d = await editedThenKilled('u/p/d.board', board('Note'), editBoard);
  // saved before the stop: not touched
  const saved = await editedThenKilled('u/p/saved.tex', tex('Alpha one.', 'Beta two.'), x => editText(x, tex), false);
  expect(await saved.doc.saveToFile()).toBe(true);
  restart(saved.doc);
  const savedMtime = statSync(saved.file).mtimeMs;
  // skipped: open now (its own save writes it), an end-to-end encrypted project, too large, file gone
  const open = await editedThenKilled('u/p/open.tex', tex('Alpha one.', 'Beta two.'), x => editText(x, tex), false);
  const secret = await editedThenKilled('u/secret/s.tex', tex('Alpha one.', 'Beta two.'), x => editText(x, tex));
  db.prepare('INSERT INTO projects (name, owner_id, created_at, e2e) VALUES (?, NULL, 0, 1)').run('u/secret');   // (an open refuses it from here on)
  const gone = await editedThenKilled('u/p/gone.tex', tex('Alpha one.', 'Beta two.'), x => editText(x, tex));
  unlinkSync(gone.file);

  for (const x of [a, b, c, d]) expect(readFileSync(x.file, 'utf8')).not.toContain('RESCUED');
  const r = await writeRescuedEdits({ log });
  expect(r.written.sort()).toEqual([a.id, b.id, c.id, d.id].sort());
  for (const x of [a, b, c, d]) {
    expect(readFileSync(x.file, 'utf8')).toContain('RESCUED');
    expect(manager.docs.has(x.id)).toBe(false);          // closed again
  }
  expect(r.skipped.sort()).toEqual([open.id, secret.id, gone.id].sort());
  expect(r.failed).toEqual([]);
  expect(readFileSync(secret.file, 'utf8')).not.toContain('RESCUED');
  expect(statSync(saved.file).mtimeMs).toBe(savedMtime);
  expect(lines.some(l => l.startsWith(`[rescue] ${a.id}: written`))).toBe(true);
  expect(lines.some(l => l.startsWith(`[rescue] ${gone.id}: its file is gone`))).toBe(true);
  expect(lines.at(-1)).toMatch(/^\[rescue\] done in \d+ s: 4 written/);

  // written: a second start finds nothing more to do (only what it skipped)
  lines.length = 0;
  const again = await writeRescuedEdits({ log });
  expect(again.written).toEqual([]);
  expect(again.skipped.sort()).toEqual([open.id, secret.id, gone.id].sort());
  restart(open.doc);
});

it('keeps to its bounds: too large is skipped, out of time leaves the rest for their next open', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const lines: string[] = [];
  const e = await editedThenKilled('u/p/e.tex', tex('Alpha one.', 'Beta two.'), d => editText(d, tex));
  const big = await writeRescuedEdits({ log: s => lines.push(s), maxBytes: 10 });
  expect(big.skipped).toContain(e.id);
  expect(lines.some(l => l.startsWith(`[rescue] ${e.id}: stored state too large`))).toBe(true);
  expect(readFileSync(e.file, 'utf8')).not.toContain('RESCUED');
  const late = await writeRescuedEdits({ log: s => lines.push(s), budgetMs: -1 });
  expect(late.left).toContain(e.id);
  expect(readFileSync(e.file, 'utf8')).not.toContain('RESCUED');
  // and at its next open it is written, as before
  const doc = await manager.open(e.id);
  await doc.saveToFile();
  expect(readFileSync(e.file, 'utf8')).toContain('RESCUED');
  restart(doc);
});

it('a crash: the open documents\' states are stored at once (persistUnsaved), and the next start writes them', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // edited a moment ago: neither the persist timer nor the save has run
  const write = (rel: string, text: string) => { writeFileSync(join(ROOT, 'projects', ...rel.split('/')), text); return manager.open(rel); };
  const t = await write('u/p/crash.tex', tex('Alpha one.', 'Beta two.'));
  const h = await write('u/p/crash.html', deck('Title'));
  editText(t, tex);
  editDeck(h);
  expect(manager.persistUnsaved()).toBe(2);
  restart(t); restart(h);                                 // the process exits before any save
  const r = await writeRescuedEdits({ log: () => undefined });
  expect(r.written).toEqual(expect.arrayContaining(['u/p/crash.html', 'u/p/crash.tex']));   // (and what the first test left open)
  for (const f of ['crash.tex', 'crash.html']) expect(readFileSync(join(dir, f), 'utf8')).toContain('RESCUED');
});
