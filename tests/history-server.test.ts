/**
 * The History pane's server side (packages/server/src/history.ts): naming a version, restoring one
 * passage of a deck as a splice of the live text, the project's versions across files (deleted ones
 * too), and the project's git history with a deleted file brought back.
 */
import { it, expect, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? '/tmp'}/overlyx-history-test-${process.pid}`;
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_GIT_COMMIT_MS = '100000';
  process.env.OVERLYX_GIT = 'on';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
const P = join(ROOT, 'projects', 'ada', 'talk');
mkdirSync(join(P, 'slides'), { recursive: true });
const deck = '<!doctype html><html><head><meta name="overlyx" content="deck"></head><body>\n<section class="slide"><h1>Old title</h1></section>\n<section class="slide"><p>Two</p></section>\n</body></html>\n';
writeFileSync(join(P, 'slides', 'index.html'), deck);
writeFileSync(join(P, 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

const { manager } = await import('../packages/server/src/docs.ts');
const { db } = await import('../packages/server/src/db.ts');
const h = await import('../packages/server/src/history.ts');

it('names a version (an automatic one is kept from then on) and restores one passage of a deck', async () => {
  const id = 'ada/talk/slides/index.html';
  const doc = await manager.open(id) as any;
  const vid = await manager.createVersion(id, 'autosave', 'Ada', 'auto');
  expect(h.nameVersion(id, vid, '  Before   the talk ')).toBe(true);
  expect(db.prepare('SELECT name, kind FROM versions WHERE id = ?').get(vid)).toEqual({ name: 'Before the talk', kind: 'manual' });
  doc.replaceText(deck.replace('Old title', 'New title').replace('<p>Two</p>', '<p>Two, changed</p>'), 'test');
  const live = doc.html.toString() as string;
  const at = live.indexOf('<h1>New title</h1>');
  // the passage moved meanwhile (an edit above it): found again by its text
  doc.replaceText('<!-- a comment -->' + live, 'test');
  const r = await h.replacePassage(id, { at, cur: '<h1>New title</h1>', text: '<h1>Old title</h1>' });
  expect(r.at).toBe(at + '<!-- a comment -->'.length);
  expect(doc.html.toString()).toContain('<h1>Old title</h1>');
  expect(doc.html.toString()).toContain('Two, changed');
  await expect(h.replacePassage(id, { at: 0, cur: 'not there', text: 'x' })).rejects.toMatchObject({ status: 409 });
  const ph = h.projectHistory('ada/talk');
  expect(ph.files).toEqual([expect.objectContaining({ doc: id, path: 'slides/index.html', exists: true, versions: 1 })]);
  expect(ph.recent[0]).toMatchObject({ id: vid, path: 'slides/index.html', name: 'Before the talk' });
});

it('lists the project’s commits with their files and brings back a file a commit deleted', async () => {
  const g = (...a: string[]) => execFileSync('git', ['-C', P, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'a@x', HOME: ROOT, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' } }).toString();
  // (the deck as the commit takes it: the first test's edits may already be saved)
  const committed = readFileSync(join(P, 'slides', 'index.html'), 'utf8');
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'First');
  g('rm', '-q', 'figure.svg'); g('commit', '-q', '-m', 'Drop the figure');
  const commits = (await h.gitChanges('ada/talk'))!;
  expect(commits.map(c => c.message)).toEqual(['Drop the figure', 'First']);
  expect(commits[0].files).toEqual([{ status: 'D', path: 'figure.svg' }]);
  expect(commits[0].author).toBe('Ada');
  expect((await h.gitFileAt('ada/talk', commits[1].hash, 'slides/index.html'))?.toString()).toBe(committed);
  expect(await h.gitFileAt('ada/talk', commits[0].hash, '../etc/passwd')).toBeNull();
  await h.restoreDeletedFile('ada/talk', commits[0].hash, 'figure.svg', 1);
  expect(readFileSync(join(P, 'figure.svg'), 'utf8')).toContain('<svg');
  await expect(h.restoreDeletedFile('ada/talk', commits[0].hash, 'figure.svg', 1)).rejects.toMatchObject({ status: 409 });
  expect(existsSync(join(P, 'figure.svg'))).toBe(true);
});
