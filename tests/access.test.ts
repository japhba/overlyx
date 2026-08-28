/**
 * Project ownership and sharing (packages/server/src/access.ts) against a scratch database and
 * projects directory: adoption of pre-existing directories, roles, invitations by username and
 * e-mail, link sharing, the personal example project, deletion to the trash.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-access-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'legacy'), { recursive: true });
mkdirSync(join(ROOT, 'projects', 'paper'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_OWNER_EMAIL = 'owner@example.com';

const access = await import('../packages/server/src/access.ts');
const { createUser, toSessionUser } = await import('../packages/server/src/auth.ts');
const { db } = await import('../packages/server/src/db.ts');

const admin = toSessionUser(createUser('admin', 'Admin', 'pw', { isAdmin: true }));
const jan = toSessionUser(createUser('jan', 'Jan Bauer', null, { email: 'owner@example.com', googleSub: 'g-jan' }));
const bob = toSessionUser(createUser('bob', 'Bob Builder', 'pw'));
const carol = toSessionUser(createUser('carol', 'Carol', null, { email: 'Carol@Example.com', googleSub: 'g-carol' }));

describe('ownership', () => {
  it('directories without an owner are adopted by the instance owner (OVERLYX_OWNER_EMAIL)', () => {
    access.adoptProjects();
    expect(access.projectRow('legacy')?.owner_id).toBe(jan.id);
    expect(access.projectRow('paper')?.owner_id).toBe(jan.id);
    expect(access.roleFor(jan, 'legacy')).toBe('owner');
    expect(access.roleFor(bob, 'legacy')).toBeNull();
    expect(access.roleFor(admin, 'legacy')).toBe('owner');   // administrators see everything
    expect(access.roleFor(bob, 'does-not-exist')).toBeNull();
    expect(access.roleFor(bob, '../etc')).toBeNull();
  });

  it('lists what each user can open, with role and provenance', () => {
    const janSees = access.accessibleProjects(jan).map(p => [p.name, p.role, p.via]);
    expect(janSees).toContainEqual(['legacy', 'owner', 'owner']);
    expect(access.accessibleProjects(bob).map(p => p.name)).not.toContain('legacy');
    const adminSees = access.accessibleProjects(admin).find(p => p.name === 'legacy');
    expect(adminSees?.via).toBe('admin');
    expect(adminSees?.owner?.username).toBe('jan');
  });
});

describe('sharing with people', () => {
  it('by username, with a role that can be changed and revoked', () => {
    access.addMember('legacy', 'bob', 'view', jan);
    expect(access.roleFor(bob, 'legacy')).toBe('view');
    const info = access.shareInfo('legacy');
    expect(info.owner?.username).toBe('jan');
    expect(info.members.map(m => [m.user?.username, m.role, m.via])).toEqual([['bob', 'view', 'user']]);
    access.setMemberRole('legacy', info.members[0].id, 'edit');
    expect(access.roleFor(bob, 'legacy')).toBe('edit');
    expect(access.accessibleProjects(bob).find(p => p.name === 'legacy')?.via).toBe('member');
    access.removeMember('legacy', info.members[0].id);
    expect(access.roleFor(bob, 'legacy')).toBeNull();
    expect(() => access.addMember('legacy', 'nobody', 'view', jan)).toThrow(/no user/);
    expect(() => access.addMember('legacy', 'jan', 'view', jan)).toThrow(/owner/);
    expect(() => access.addMember('legacy', 'not an email', 'view', jan)).toThrow(/no user/);
  });

  it('by e-mail: an existing account is matched (case-insensitively), an unknown one is invited and bound at sign-in', () => {
    access.addMember('legacy', 'carol@example.com', 'edit', jan);
    expect(access.roleFor(carol, 'legacy')).toBe('edit');
    access.addMember('legacy', 'Dave@Example.com', 'view', jan);
    expect(access.shareInfo('legacy').members.find(m => m.email === 'dave@example.com')?.user).toBeNull();
    expect(access.isInvited('dave@example.com')).toBe(true);
    expect(access.isInvited('eve@example.com')).toBe(false);
    expect(access.isInvited('owner@example.com')).toBe(true);
    // Dave signs in with Google: the invitation becomes a membership of the new account
    const dave = toSessionUser(createUser('dave', 'Dave', null, { email: 'dave@example.com', googleSub: 'g-dave' }));
    expect(access.roleFor(dave, 'legacy')).toBe('view');     // matched by e-mail already
    access.bindInvitations(dave.id, 'dave@example.com');
    const m = access.shareInfo('legacy').members.find(m => m.user?.username === 'dave');
    expect(m?.role).toBe('view');
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE user_id IS NULL').get()).toEqual({ n: 0 });
    expect(() => access.addMember('legacy', 'bad@address', 'view', jan)).toThrow(/valid e-mail/);
  });
});

describe('link sharing', () => {
  it('grants the link role on opening the link and follows / revokes with the link', () => {
    const link = access.setLink('paper', 'view')!;
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(access.roleFor(bob, 'paper')).toBeNull();
    expect(access.acceptLink(link.token, bob).role).toBe('view');
    expect(access.roleFor(bob, 'paper')).toBe('view');
    expect(access.accessibleProjects(bob).find(p => p.name === 'paper')?.via).toBe('link');
    expect(access.setLink('paper', 'edit')?.token).toBe(link.token);   // same link, new role
    expect(access.roleFor(bob, 'paper')).toBe('edit');
    // an explicit membership is never lowered by the link
    access.addMember('paper', 'carol', 'edit', jan);
    access.setLink('paper', 'view');
    expect(access.acceptLink(link.token, carol).role).toBe('edit');
    expect(access.roleFor(carol, 'paper')).toBe('edit');
    expect(access.roleFor(bob, 'paper')).toBe('view');
    // off: everyone who came through the link is out, the token is dead
    expect(access.setLink('paper', null)).toBeNull();
    expect(access.roleFor(bob, 'paper')).toBeNull();
    expect(access.roleFor(carol, 'paper')).toBe('edit');
    expect(() => access.acceptLink(link.token, bob)).toThrow(/not valid/);
    expect(access.setLink('paper', 'view')?.token).not.toBe(link.token);
  });
});

describe('example project and deletion', () => {
  it('creates one personalised example project per account, once', () => {
    const name = access.ensureWelcomeProject(bob)!;
    expect(name).toBe('welcome-bob');
    const text = readFileSync(join(ROOT, 'projects', name, 'welcome.tex'), 'utf8');
    expect(text).toContain('\\author{Bob Builder}');
    expect(text).toContain('Bob.');
    expect(text).not.toContain('@@');
    expect(text).toContain('% OverLyX: double angle brackets');
    expect(readdirSync(join(ROOT, 'projects', name)).sort()).toEqual(['figures', 'refs.bib', 'welcome.tex']);
    expect(access.ensureWelcomeProject(bob)).toBe(name);
    const p = access.accessibleProjects(bob).find(p => p.name === name)!;
    expect([p.kind, p.title, p.role, p.via]).toEqual(['example', 'Welcome to OverLyX', 'owner', 'owner']);
    expect(access.roleFor(jan, name)).toBeNull();
  });

  it('moves a deleted project to the trash and does not re-create a deleted example', () => {
    const dest = access.trashProject('welcome-bob');
    expect(existsSync(join(ROOT, 'projects', 'welcome-bob'))).toBe(false);
    expect(existsSync(join(dest, 'welcome.tex'))).toBe(true);
    expect(access.ensureWelcomeProject(bob)).toBeNull();
    expect(access.accessibleProjects(bob).map(p => p.name)).not.toContain('welcome-bob');
    access.addMember('paper', 'bob', 'edit', jan);
    access.trashProject('paper');
    expect(access.projectRow('paper')).toBeUndefined();
    expect(access.roleFor(bob, 'paper')).toBeNull();
  });

  it('transfers ownership', () => {
    access.setOwner('legacy', 'bob');
    expect(access.roleFor(bob, 'legacy')).toBe('owner');
    expect(access.roleFor(jan, 'legacy')).toBeNull();
    expect(() => access.setOwner('legacy', 'nobody')).toThrow(/no user/);
  });
});
