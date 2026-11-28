/**
 * What a page's frame may read (deliverables.ts pageToken): a deck's scripts run with the token of
 * whoever opens it. A folder shared for editing on its own is written by people who have nothing else
 * of the project, so a page in it reads that folder only — also when the project's owner opens it.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = vi.hoisted(() => {
  const root = `${process.env.OVERLYX_SCRATCH ?? process.env.TMPDIR ?? '/tmp'}/overlyx-deliverable-reach-test`;
  process.env.OVERLYX_DATA_DIR = `${root}/data`;
  process.env.OVERLYX_PROJECTS_DIR = `${root}/projects`;
  process.env.OVERLYX_DOC_WORKERS = '0';
  return root;
});
void tmpdir;
rmSync(ROOT, { recursive: true, force: true });
const P = join(ROOT, 'projects', 'owner', 'p');
mkdirSync(join(P, 'talk'), { recursive: true });
mkdirSync(join(P, 'private'), { recursive: true });
mkdirSync(join(P, 'open'), { recursive: true });
writeFileSync(join(P, 'talk', 'index.html'), '<!doctype html><html><head><meta name="overlyx" content="deck"></head><body><section class="slide"><h1>Talk</h1></section></body></html>');
writeFileSync(join(P, 'talk', 'style.css'), 'h1 { color: red }');
writeFileSync(join(P, 'open', 'index.html'), '<!doctype html><html><head><meta name="overlyx" content="deck"></head><body><section class="slide"><h1>Open</h1></section></body></html>');
writeFileSync(join(P, 'private', 'notes.txt'), 'the referee is Reviewer 2');

const { createUser, toSessionUser } = await import('../packages/server/src/auth.ts');
const access = await import('../packages/server/src/access.ts');
const { pageToken, verifyDeliverableToken, resolveDeliverable } = await import('../packages/server/src/deliverables.ts');

const owner = toSessionUser(createUser('owner', 'Owner', 'pw'));
const guest = toSessionUser(createUser('ed', 'Ed', 'pw'));
access.registerProject('owner/p', owner.id);

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const status = async (token: string, path: string) => (await resolveDeliverable(token, path, {})).status;

describe('what a page reads with its reader\'s token', () => {
  it('the whole project, for a page nobody else writes', async () => {
    const t = pageToken('owner/p', 'talk/index.html', owner.id);
    expect(verifyDeliverableToken(t)).toMatchObject({ project: 'owner/p', userId: owner.id, reach: '' });
    expect(await status(t, 'talk/index.html')).toBe(200);
    expect(await status(t, 'private/notes.txt')).toBe(200);
  });

  it('a folder shared for viewing changes nothing (its people cannot write the page)', async () => {
    access.addFolderMember('owner/p', 'talk', 'ed', 'view', owner);
    const t = pageToken('owner/p', 'talk/index.html', owner.id);
    expect(await status(t, 'private/notes.txt')).toBe(200);
    // …and they read their folder and nothing else, as before
    const theirs = pageToken('owner/p', 'talk/index.html', guest.id);
    expect(await status(theirs, 'talk/style.css')).toBe(200);
    expect(await status(theirs, 'private/notes.txt')).toBe(404);
  });

  it('a page in a folder shared for editing reads that folder only — the owner\'s frame too', async () => {
    access.addFolderMember('owner/p', 'talk', 'ed', 'edit', owner);
    const t = pageToken('owner/p', 'talk/index.html', owner.id);
    expect(verifyDeliverableToken(t)).toMatchObject({ reach: 'talk' });
    expect(await status(t, 'talk/index.html')).toBe(200);
    expect(await status(t, 'talk/style.css')).toBe(200);
    // what `fetch('../private/notes.txt')` in the deck's own script would get, opened by the owner
    expect(await status(t, 'private/notes.txt')).toBe(404);
    expect(await status(t, 'open/index.html')).toBe(404);
    // the project's other pages are as they were
    const other = pageToken('owner/p', 'open/index.html', owner.id);
    expect(verifyDeliverableToken(other)).toMatchObject({ reach: '' });
    expect(await status(other, 'private/notes.txt')).toBe(200);
  });

  it('the same for a share link to the folder, before anybody came in through it', async () => {
    const link = access.createLink('owner/p', 'edit', owner, 'open');
    expect(link.path).toBe('open');
    expect(verifyDeliverableToken(pageToken('owner/p', 'open/index.html', owner.id))).toMatchObject({ reach: 'open' });
  });
});
