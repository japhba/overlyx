/**
 * Project ownership and sharing (packages/server/src/access.ts) against a scratch database and
 * projects directory: adoption of pre-existing directories (into their owner's namespace), roles,
 * invitations by username and e-mail, link sharing, the personal example project, deletion to the
 * trash, handing a project to another owner.
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
const { canonicalProject, canonicalDocId } = await import('../packages/server/src/namespaces.ts');
const { createUser, createGuest, toSessionUser } = await import('../packages/server/src/auth.ts');
const { db } = await import('../packages/server/src/db.ts');

const admin = toSessionUser(createUser('admin', 'Admin', 'pw', { isAdmin: true }));
const jan = toSessionUser(createUser('jan', 'Jan Bauer', null, { email: 'owner@example.com', googleSub: 'g-jan' }));
const bob = toSessionUser(createUser('bob', 'Bob Builder', 'pw'));
const carol = toSessionUser(createUser('carol', 'Carol', null, { email: 'Carol@Example.com', googleSub: 'g-carol' }));

describe('ownership', () => {
  it('directories without an owner move into the instance owner\'s namespace (OVERLYX_OWNER_EMAIL) and are adopted there', () => {
    access.adoptProjects();
    expect(existsSync(join(ROOT, 'projects', 'jan', 'legacy'))).toBe(true);
    expect(existsSync(join(ROOT, 'projects', 'legacy'))).toBe(false);
    // the old names stay aliases: old links, remotes and MCP clients keep working
    expect(canonicalProject('legacy')).toBe('jan/legacy');
    expect(canonicalDocId('paper/main.tex')).toBe('jan/paper/main.tex');
    expect(canonicalDocId('jan/paper/main.tex')).toBe('jan/paper/main.tex');
    expect(access.roleFor(jan, 'legacy')).toBeNull();          // a flat name is no key
    // a directory created by hand inside a namespace belongs to that account
    mkdirSync(join(ROOT, 'projects', 'bob', 'draft'), { recursive: true });
    access.adoptProjects();
    expect(access.projectRow('bob/draft')?.owner_id).toBe(bob.id);
    access.trashProject('bob/draft');
    expect(access.projectRow('jan/legacy')?.owner_id).toBe(jan.id);
    expect(access.projectRow('jan/paper')?.owner_id).toBe(jan.id);
    expect(access.roleFor(jan, 'jan/legacy')).toBe('owner');
    expect(access.roleFor(bob, 'jan/legacy')).toBeNull();
    expect(access.roleFor(admin, 'jan/legacy')).toBeNull();      // administrators need an explicit, logged grant (see below)
    expect(access.roleFor(bob, 'does-not-exist')).toBeNull();
    expect(access.roleFor(bob, '../etc')).toBeNull();
  });

  it('lists what each user can open, with role and provenance', () => {
    const janSees = access.accessibleProjects(jan).map(p => [p.name, p.role, p.via]);
    expect(janSees).toContainEqual(['jan/legacy', 'owner', 'owner']);
    expect(access.accessibleProjects(bob).map(p => p.name)).not.toContain('jan/legacy');
    // an administrator is not a member of anything by default
    expect(access.accessibleProjects(admin).map(p => p.name)).not.toContain('jan/legacy');
  });
});

describe('administrators', () => {
  it('open other people\'s projects only through an explicit, time-limited grant that the owner sees in the activity log', () => {
    expect(access.roleFor(admin, 'jan/legacy')).toBeNull();
    expect(() => access.grantAdminAccess(bob, 'jan/legacy')).toThrow(/administrators only/);
    expect(() => access.grantAdminAccess(admin, 'does-not-exist')).toThrow(/not found/);
    const until = access.grantAdminAccess(admin, 'jan/legacy', 30);
    expect(until).toBeGreaterThan(Date.now() + 29 * 60 * 1000);
    expect(access.roleFor(admin, 'jan/legacy')).toBe('owner');
    const seen = access.accessibleProjects(admin).find(p => p.name === 'jan/legacy');
    expect(seen?.via).toBe('admin');
    expect(seen?.owner?.username).toBe('jan');
    const log = access.activityOf('jan/legacy');
    expect(log[0]).toMatchObject({ action: 'admin-access', detail: '30 min', user: { username: 'admin' } });
    // the administration list knows what the administrator can open
    const all = access.projectsForAdmin(admin);
    expect(all.find(p => p.name === 'jan/legacy')).toMatchObject({ access: 'granted', owner: { username: 'jan' } });
    expect(all.find(p => p.name === 'jan/paper')).toMatchObject({ access: null });
    expect(access.projectsForAdmin(bob)).toEqual([]);
    // the grant expires
    db.prepare('UPDATE admin_grants SET until = ? WHERE project = ? AND user_id = ?').run(Date.now() - 1, 'jan/legacy', admin.id);
    expect(access.roleFor(admin, 'jan/legacy')).toBeNull();
    expect(access.projectsForAdmin(admin).find(p => p.name === 'jan/legacy')?.access).toBeNull();
  });

  it('the activity log records opens, builds, git and sharing — repeated opens once per 10 minutes', () => {
    access.logAccess('jan/paper', bob.id, 'open', 'main.tex');
    access.logAccess('jan/paper', bob.id, 'open', 'main.tex');          // same person, same document: one entry
    access.logAccess('jan/paper', bob.id, 'open', 'appendix.tex');
    access.logAccess('jan/paper', jan.id, 'build', 'main.tex');
    access.logAccess('jan/paper', bob.id, 'git-fetch');
    access.logAccess('jan/paper', jan.id, 'share', 'added bob as editor');
    const log = access.activityOf('jan/paper');
    expect(log.map(e => [e.user?.username, e.action, e.detail])).toEqual([
      ['jan', 'share', 'added bob as editor'], ['bob', 'git-fetch', null], ['jan', 'build', 'main.tex'], ['bob', 'open', 'appendix.tex'], ['bob', 'open', 'main.tex'],
    ]);
    expect(access.activityOf('jan/paper', 2)).toHaveLength(2);
    access.pruneAccessLog(0);
    expect(access.activityOf('jan/paper')).toEqual([]);
  });
});

describe('sharing with people', () => {
  it('by username, with a role that can be changed and revoked', () => {
    access.addMember('jan/legacy', 'bob', 'view', jan);
    expect(access.roleFor(bob, 'jan/legacy')).toBe('view');
    const info = access.shareInfo('jan/legacy');
    expect(info.owner?.username).toBe('jan');
    expect(info.members.map(m => [m.user?.username, m.role, m.via])).toEqual([['bob', 'view', 'user']]);
    access.setMemberRole('jan/legacy', info.members[0].id, 'edit');
    expect(access.roleFor(bob, 'jan/legacy')).toBe('edit');
    expect(access.accessibleProjects(bob).find(p => p.name === 'jan/legacy')?.via).toBe('member');
    access.removeMember('jan/legacy', info.members[0].id);
    expect(access.roleFor(bob, 'jan/legacy')).toBeNull();
    expect(() => access.addMember('jan/legacy', 'nobody', 'view', jan)).toThrow(/no user/);
    expect(() => access.addMember('jan/legacy', 'jan', 'view', jan)).toThrow(/owner/);
    expect(() => access.addMember('jan/legacy', 'not an email', 'view', jan)).toThrow(/no user/);
  });

  it('by e-mail: an existing account is matched (case-insensitively), an unknown one is invited and bound at sign-in', () => {
    access.addMember('jan/legacy', 'carol@example.com', 'edit', jan);
    expect(access.roleFor(carol, 'jan/legacy')).toBe('edit');
    access.addMember('jan/legacy', 'Dave@Example.com', 'view', jan);
    expect(access.shareInfo('jan/legacy').members.find(m => m.email === 'dave@example.com')?.user).toBeNull();
    expect(access.isInvited('dave@example.com')).toBe(true);
    expect(access.isInvited('eve@example.com')).toBe(false);
    expect(access.isInvited('owner@example.com')).toBe(true);
    // Dave signs in with Google: the invitation becomes a membership of the new account
    const dave = toSessionUser(createUser('dave', 'Dave', null, { email: 'dave@example.com', googleSub: 'g-dave' }));
    expect(access.roleFor(dave, 'jan/legacy')).toBe('view');     // matched by e-mail already
    access.bindInvitations(dave.id, 'dave@example.com');
    const m = access.shareInfo('jan/legacy').members.find(m => m.user?.username === 'dave');
    expect(m?.role).toBe('view');
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE user_id IS NULL').get()).toEqual({ n: 0 });
    expect(() => access.addMember('jan/legacy', 'bad@address', 'view', jan)).toThrow(/valid e-mail/);
  });
});

describe('link sharing', () => {
  it('grants the link role on opening the link and follows / revokes with the link', () => {
    const link = access.setLink('jan/paper', 'view')!;
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(access.roleFor(bob, 'jan/paper')).toBeNull();
    expect(access.acceptLink(link.token, bob).role).toBe('view');
    expect(access.roleFor(bob, 'jan/paper')).toBe('view');
    expect(access.accessibleProjects(bob).find(p => p.name === 'jan/paper')?.via).toBe('link');
    expect(access.setLink('jan/paper', 'edit')?.token).toBe(link.token);   // same link, new role
    expect(access.roleFor(bob, 'jan/paper')).toBe('edit');
    // an explicit membership is never lowered by the link
    access.addMember('jan/paper', 'carol', 'edit', jan);
    access.setLink('jan/paper', 'view');
    expect(access.acceptLink(link.token, carol).role).toBe('edit');
    expect(access.roleFor(carol, 'jan/paper')).toBe('edit');
    expect(access.roleFor(bob, 'jan/paper')).toBe('view');
    // off: everyone who came through the link is out, the token is dead
    expect(access.setLink('jan/paper', null)).toBeNull();
    expect(access.roleFor(bob, 'jan/paper')).toBeNull();
    expect(access.roleFor(carol, 'jan/paper')).toBe('edit');
    expect(() => access.acceptLink(link.token, bob)).toThrow(/not valid/);
    expect(access.setLink('jan/paper', 'view')?.token).not.toBe(link.token);
  });

  it('lets a guest (no account) in, and hands what the guest gathered to the account they sign in with', () => {
    const link = access.setLink('jan/paper', 'edit')!;
    expect(access.linkProject(link.token)?.name).toBe('jan/paper');
    expect(access.linkProject('nope')).toBeUndefined();
    const guest = toSessionUser(createGuest());
    expect(guest.guest).toBe(true);
    expect(guest.username).toMatch(/^guest-[0-9a-f]{10}$/);
    expect(guest.name).toMatch(/^Anonymous [A-Z][a-z]+$/);
    expect(bob.guest).toBeUndefined();
    expect(access.acceptLink(link.token, guest).role).toBe('edit');
    expect(access.roleFor(guest, 'jan/paper')).toBe('edit');
    expect(access.accessibleProjects(guest).map(p => [p.name, p.via])).toEqual([['jan/paper', 'link']]);
    expect(access.ensureWelcomeProject(guest)).toBeNull();                       // no example project for guests
    expect(() => access.addMember('jan/legacy', guest.username, 'view', jan)).toThrow(/guest/);
    expect(() => access.newOwner(guest.username)).toThrow(/guest/);
    access.logAccess('jan/paper', guest.id, 'open', 'main.tex');
    // the guest signs in as a new account: the link membership and the activity move over, the guest is gone
    const erin = toSessionUser(createUser('erin', 'Erin', null, { email: 'erin@example.com', googleSub: 'g-erin' }));
    expect(access.roleFor(erin, 'jan/paper')).toBeNull();
    expect(access.adoptGuest(erin, erin.id)).toEqual([]);                         // not a guest: nothing to do
    expect(access.adoptGuest(guest, erin.id)).toEqual(['jan/paper']);
    expect(access.roleFor(erin, 'jan/paper')).toBe('edit');
    expect(access.accessibleProjects(erin).find(p => p.name === 'jan/paper')?.via).toBe('link');
    expect(access.activityOf('jan/paper')[0]).toMatchObject({ action: 'open', user: { username: 'erin' } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(guest.id)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE user_id = ?').get(guest.id)).toEqual({ n: 0 });
    // an account that is a viewer already is raised by an edit link, an owner is left alone
    const g2 = toSessionUser(createGuest());
    access.acceptLink(link.token, g2);
    access.removeMember('jan/paper', access.shareInfo('jan/paper').members.find(m => m.user?.username === 'carol')!.id);
    access.addMember('jan/paper', 'carol', 'view', jan);
    expect(access.adoptGuest(g2, carol.id)).toEqual(['jan/paper']);
    expect(access.roleFor(carol, 'jan/paper')).toBe('edit');                        // g2 came in while the link said edit
    access.setLink('jan/paper', 'view');
    const g3 = toSessionUser(createGuest());
    access.acceptLink(link.token, g3);
    expect(access.adoptGuest(g3, jan.id)).toEqual(['jan/paper']);
    expect(access.roleFor(jan, 'jan/paper')).toBe('owner');
    expect(access.shareInfo('jan/paper').members.map(m => m.user?.username)).not.toContain(g3.username);
    // guests whose session expired are pruned
    const old = toSessionUser(createGuest());
    access.acceptLink(link.token, old);
    db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(Date.now() - 40 * 24 * 3600 * 1000, old.id);
    const fresh = toSessionUser(createGuest());
    expect(access.pruneGuests()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?)').get(old.id, fresh.id)).toEqual({ n: 1 });
    expect(access.roleFor(old, 'jan/paper')).toBeNull();
    access.setLink('jan/paper', null);
  });
});

describe('example project and deletion', () => {
  it('creates one personalised example project per account, once', () => {
    const name = access.ensureWelcomeProject(bob)!;
    expect(name).toBe('bob/welcome');
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
    const dest = access.trashProject('bob/welcome');
    expect(existsSync(join(ROOT, 'projects', 'bob', 'welcome'))).toBe(false);
    expect(existsSync(join(dest, 'welcome.tex'))).toBe(true);
    expect(access.ensureWelcomeProject(bob)).toBeNull();
    expect(access.accessibleProjects(bob).map(p => p.name)).not.toContain('bob/welcome');
    // the tombstone does not keep the name: bob can call a project "welcome" himself
    expect(access.projectRow('bob/welcome')).toBeUndefined();
    access.addMember('jan/paper', 'bob', 'edit', jan);
    access.trashProject('jan/paper');
    expect(access.projectRow('jan/paper')).toBeUndefined();
    expect(access.roleFor(bob, 'jan/paper')).toBeNull();
  });

  it('transfers ownership: the project moves into the new owner\'s namespace, the old keys lead there', () => {
    const to = access.setOwner('jan/legacy', access.newOwner('bob'));
    expect(to).toBe('bob/legacy');
    expect(access.roleFor(bob, 'bob/legacy')).toBe('owner');
    expect(access.roleFor(jan, 'bob/legacy')).toBeNull();
    expect(access.projectRow('jan/legacy')).toBeUndefined();
    expect(existsSync(join(ROOT, 'projects', 'bob', 'legacy'))).toBe(true);
    expect(existsSync(join(ROOT, 'projects', 'jan', 'legacy'))).toBe(false);
    expect(canonicalProject('jan/legacy')).toBe('bob/legacy');
    expect(canonicalProject('legacy')).toBe('bob/legacy');
    expect(canonicalDocId('jan/legacy/sub/a.tex')).toBe('bob/legacy/sub/a.tex');
    expect(() => access.newOwner('nobody')).toThrow(/no user/);
  });
});
