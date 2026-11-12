/**
 * Folder shares (packages/server/src/foldershares.ts, access.ts): one folder of a project shared on
 * its own, with people or by a link — they reach that folder and nothing else; `roleFor` does not
 * know them, so every whole-project door (git, search, MCP, the agent) stays shut for them.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-folder-sharing-test');
rmSync(ROOT, { recursive: true, force: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
const P = join(ROOT, 'projects', 'jan', 'meetings');
mkdirSync(join(P, 'notes', '2026-11-12-standup', 'figs'), { recursive: true });
mkdirSync(join(P, 'notes', '2026-11-12-standupX'), { recursive: true });
mkdirSync(join(P, 'private'), { recursive: true });
writeFileSync(join(P, 'notes', '2026-11-12-standup', 'notes.md'), '# Notes\n');
writeFileSync(join(P, 'notes', '2026-11-12-standup', 'summary.md'), '# Summary\n');
writeFileSync(join(P, 'notes', '2026-11-12-standup', '.overlyx-group.json'), JSON.stringify({ version: 1, title: 'Standup', members: [{ file: 'summary.md', title: 'Summary', level: 0 }, { file: 'notes.md', title: 'Notes', level: 0 }] }));
writeFileSync(join(P, 'notes', '2026-11-12-standupX', 'other.md'), '# Other meeting\n');
writeFileSync(join(P, 'private', 'secret.md'), '# Secret\n');
writeFileSync(join(P, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n');
symlinkSync(join(P, 'private'), join(P, 'notes', '2026-11-12-standup', 'escape'));

const access = await import('../packages/server/src/access.ts');
const shares = await import('../packages/server/src/foldershares.ts');
const { createUser, createGuest, toSessionUser } = await import('../packages/server/src/auth.ts');
const { db } = await import('../packages/server/src/db.ts');
const { config } = await import('../packages/server/src/config.ts');

const FOLDER = 'notes/2026-11-12-standup';
const jan = toSessionUser(createUser('jan', 'Jan', 'pw'));
const ada = toSessionUser(createUser('ada', 'Ada Lovelace', 'pw', { email: 'ada@example.com' }));
const bob = toSessionUser(createUser('bob', 'Bob', 'pw'));
const carl = toSessionUser(createUser('carl', 'Carl', 'pw'));

describe('folder shares', () => {
  it('run on a scratch database', () => {
    expect(config.dataDir.startsWith(ROOT)).toBe(true);
    access.adoptProjects();
    expect(access.projectRow('jan/meetings')?.owner_id).toBe(jan.id);
  });

  it('name a folder of the project: normalised, never the top, `..` or .git', () => {
    expect(shares.sharePath('/notes//2026-11-12-standup/')).toBe(FOLDER);
    for (const bad of ['', '/', '.', '..', 'notes/../..', 'a/.git', 'a\\b', 'a\0b']) expect(shares.sharePath(bad)).toBeNull();
    expect(shares.withinPath(`${FOLDER}/notes.md`, FOLDER)).toBe(true);
    expect(shares.withinPath(FOLDER, FOLDER)).toBe(true);
    expect(shares.withinPath(`${FOLDER}X/other.md`, FOLDER)).toBe(false);
    expect(shares.withinPath(`${FOLDER}/../../private/secret.md`, FOLDER)).toBe(false);
    expect(shares.withinPath(`/${FOLDER}/notes.md`, FOLDER)).toBe(false);
    expect(() => access.shareableFolder('jan/meetings', 'notes/nope')).toThrow(/no folder/);
    expect(() => access.shareableFolder('jan/meetings', 'main.tex')).toThrow(/no folder/);
    expect(() => access.shareableFolder('jan/meetings', `${FOLDER}/escape`)).toThrow(/no folder/);   // a link out of the project's tree
  });

  it('give a person that folder and nothing else of the project', () => {
    access.addFolderMember('jan/meetings', FOLDER, 'ada@example.com', 'view', jan);
    expect(access.roleFor(ada, 'jan/meetings')).toBeNull();                       // every whole-project door stays shut
    expect(access.roleAt(ada, 'jan/meetings', `${FOLDER}/notes.md`)).toBe('view');
    expect(access.roleAt(ada, 'jan/meetings', FOLDER)).toBe('view');
    expect(access.roleAt(ada, 'jan/meetings', 'main.tex')).toBeNull();
    expect(access.roleAt(ada, 'jan/meetings', `${FOLDER}X/other.md`)).toBeNull();
    expect(access.roleAt(ada, 'jan/meetings', `${FOLDER}/../../private/secret.md`)).toBeNull();
    expect(access.roleAt(ada, 'jan/meetings', `${FOLDER}/escape/secret.md`)).toBeNull();   // a link on disk out of the folder
    expect(access.folderOnly(ada, 'jan/meetings')).toBe(true);
    expect(access.reachesProject(ada, 'jan/meetings')).toBe(true);
    expect(access.reachesProject(bob, 'jan/meetings')).toBe(false);
    // on the project list: the folder's files only
    const p = access.accessibleProjects(ada).find(x => x.name === 'jan/meetings')!;
    expect(p).toMatchObject({ role: 'view', via: 'member', partial: true, folders: [{ path: FOLDER, role: 'view' }] });
    expect(p.files.map(f => f.path).sort()).toEqual([FOLDER, `${FOLDER}/escape`, `${FOLDER}/figs`, `${FOLDER}/notes.md`, `${FOLDER}/summary.md`].sort());
    // the owner sees who has it
    expect(access.shareInfo('jan/meetings').folderMembers).toMatchObject([{ path: FOLDER, role: 'view', user: { username: 'ada' } }]);
    expect(access.shareInfo('jan/meetings').members).toEqual([]);
  });

  it('are not needed by people who have the project already, and raise a viewer to an editor of the folder', () => {
    access.addMember('jan/meetings', 'bob', 'edit', jan);
    expect(() => access.addFolderMember('jan/meetings', FOLDER, 'bob', 'edit', jan)).toThrow(/whole project already/);
    expect(() => access.addFolderMember('jan/meetings', FOLDER, 'jan', 'view', jan)).toThrow(/owner/);
    access.addMember('jan/meetings', 'carl', 'view', jan);
    access.addFolderMember('jan/meetings', FOLDER, 'carl', 'edit', jan);
    expect(access.roleAt(carl, 'jan/meetings', `${FOLDER}/notes.md`)).toBe('edit');
    expect(access.roleAt(carl, 'jan/meetings', 'main.tex')).toBe('view');
    const p = access.accessibleProjects(carl).find(x => x.name === 'jan/meetings')!;
    expect(p.partial).toBeUndefined();
    expect(p.folders).toEqual([{ path: FOLDER, role: 'edit' }]);
  });

  it('confine the builds of a folder shared for editing to that folder', () => {
    expect(shares.confinedRoot('jan/meetings', `${FOLDER}/notes.md`)).toBe(FOLDER);   // carl edits it
    expect(shares.confinedRoot('jan/meetings', 'main.tex')).toBe('');
    expect(shares.confinedRoot('jan/meetings', `${FOLDER}X/other.md`)).toBe('');
  });

  it('by a link: newcomers get the folder alone, the project\'s people only land there; off, with its people', () => {
    const link = access.createLink('jan/meetings', 'view', jan, FOLDER);
    expect(link.path).toBe(FOLDER);
    expect(access.linkPreview(link.token)).toMatchObject({ project: 'jan/meetings', role: 'view', folder: { path: FOLDER, title: 'Standup' } });
    expect(access.groupLanding('jan/meetings', FOLDER)).toBe(`${FOLDER}/summary.md`);
    // a member of the project: nothing new for them
    expect(access.acceptLink(link.token, bob)).toMatchObject({ role: 'edit', path: FOLDER });
    expect(db.prepare('SELECT COUNT(*) AS n FROM folder_members WHERE user_id = ?').get(bob.id)).toEqual({ n: 0 });
    // a guest: the folder
    const guest = toSessionUser(createGuest());
    expect(access.acceptLink(link.token, guest)).toMatchObject({ role: 'view', path: FOLDER });
    expect(access.roleFor(guest, 'jan/meetings')).toBeNull();
    expect(access.roleAt(guest, 'jan/meetings', `${FOLDER}/summary.md`)).toBe('view');
    expect(access.roleAt(guest, 'jan/meetings', 'private/secret.md')).toBeNull();
    expect(access.accessibleProjects(guest).find(x => x.name === 'jan/meetings')).toMatchObject({ via: 'link', partial: true });
    expect(access.linksOf('jan/meetings').find(l => l.token === link.token)?.joined).toBe(1);
    // the guest signs in: the folder comes along
    const dee = toSessionUser(createUser('dee', 'Dee', 'pw'));
    expect(access.adoptGuest(guest, dee.id)).toContain('jan/meetings');
    expect(access.roleAt(dee, 'jan/meetings', `${FOLDER}/notes.md`)).toBe('view');
    // turned off with its people
    const r = access.revokeLink('jan/meetings', link.token, true)!;
    expect(r.removed).toEqual([dee.id]);
    expect(access.roleAt(dee, 'jan/meetings', `${FOLDER}/notes.md`)).toBeNull();
    expect(() => access.acceptLink(link.token, dee)).toThrow(/not valid/);
  });

  it('follow their folder when it is renamed', () => {
    const link = access.createLink('jan/meetings', 'edit', jan, FOLDER);
    shares.foldersMoved('jan/meetings', 'notes', 'archive');
    expect(access.foldersOf(ada, 'jan/meetings')).toEqual([{ path: 'archive/2026-11-12-standup', role: 'view', via: 'email' }]);
    expect(access.shareLinkOf(link.token)?.path).toBe('archive/2026-11-12-standup');
    shares.foldersMoved('jan/meetings', 'archive', 'notes');
    expect(access.foldersOf(ada, 'jan/meetings')[0].path).toBe(FOLDER);
  });

  it('bind e-mail invitations at sign-in and count as an invitation', () => {
    access.addFolderMember('jan/meetings', FOLDER, 'erin@example.com', 'edit', jan);
    expect(access.isInvited('erin@example.com')).toBe(true);
    const erin = toSessionUser(createUser('erin', 'Erin', null, { email: 'erin@example.com', googleSub: 'g-erin' }));
    access.bindInvitations(erin.id, 'erin@example.com');
    expect((db.prepare('SELECT user_id FROM folder_members WHERE email = ?').get('erin@example.com') as { user_id: number }).user_id).toBe(erin.id);
    expect(access.roleAt(erin, 'jan/meetings', `${FOLDER}/notes.md`)).toBe('edit');
  });

  it('are refused in an end-to-end encrypted project, and go with a deleted project', () => {
    db.prepare('UPDATE projects SET e2e = 1 WHERE name = ?').run('jan/meetings');
    expect(() => access.createLink('jan/meetings', 'view', jan, FOLDER)).toThrow(/encrypted/);
    expect(access.roleAt(ada, 'jan/meetings', `${FOLDER}/notes.md`)).toBeNull();
    db.prepare('UPDATE projects SET e2e = 0 WHERE name = ?').run('jan/meetings');
    access.trashProject('jan/meetings');
    expect(existsSync(P)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM folder_members WHERE project = 'jan/meetings'").get()).toEqual({ n: 0 });
  });
});
