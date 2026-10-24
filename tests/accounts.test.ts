/**
 * Deleting an account (packages/server/src/accounts.ts) against a scratch database, projects
 * directory and file-based mirror: the projects it owns are erased with their trash copies and
 * mirrors, memberships elsewhere end (other people's projects stay), sign-ins, reports, the agent
 * home and the account row go, log entries keep no link; the instance owner cannot be deleted.
 * The trash expires after 30 days. The privacy notice (privacy.ts) renders what it promises.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-accounts-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_AGENT_USERS = 'off';   // (agent files in the data directory, as the server's own user)
process.env.OVERLYX_OWNER_EMAIL = 'owner@example.com';
process.env.OVERLYX_MIRROR_URL = `file://${join(ROOT, 'mirrors')}/{repo}.git`;
process.env.OVERLYX_OPERATOR = 'Ada Operator';
process.env.OVERLYX_PRIVACY_CONTACT = 'privacy@example.org';

const access = await import('../packages/server/src/access.ts');
const accounts = await import('../packages/server/src/accounts.ts');
const fb = await import('../packages/server/src/feedback.ts');
const { privacyHtml } = await import('../packages/server/src/privacy.ts');
const { termsHtml } = await import('../packages/server/src/terms.ts');
const { createUser, toSessionUser } = await import('../packages/server/src/auth.ts');
const { db } = await import('../packages/server/src/db.ts');

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const owner = toSessionUser(createUser('owner', 'The Owner', null, { email: 'owner@example.com', googleSub: 'g-owner' }));
const dora = toSessionUser(createUser('dora', 'Dora Leaving', null, { email: 'dora@example.com', googleSub: 'g-dora' }));
const eve = toSessionUser(createUser('eve', 'Eve Staying', null, { email: 'eve@example.com', googleSub: 'g-eve' }));

const project = (key: string, by: { id: number }) => {
  mkdirSync(join(ROOT, 'projects', ...key.split('/')), { recursive: true });
  writeFileSync(join(ROOT, 'projects', ...key.split('/'), 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n');
  access.registerProject(key, by.id);
};
const exists = (...p: string[]) => existsSync(join(ROOT, ...p));
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const stamp = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400_000).toISOString().replace(/[:.]/g, '-');

describe('deleting an account', () => {
  project('dora/thesis', dora);
  project('dora/notes', dora);
  project('eve/paper', eve);
  access.addMember('dora/thesis', 'eve', 'edit', dora);
  access.addMember('eve/paper', 'dora', 'edit', eve);

  it('previews what goes: the owned projects (shared ones with their people) and the memberships', () => {
    const p = accounts.deletionPreview(dora);
    expect(p.refused).toBeNull();
    expect(p.owned).toEqual([{ project: 'dora/notes', title: null, people: 0 }, { project: 'dora/thesis', title: null, people: 1 }]);
    expect(p.memberOf).toBe(1);
  });

  it('refuses the instance owner', async () => {
    expect(accounts.deletionPreview(owner).refused).toMatch(/owner/);
    await expect(accounts.deleteAccount(owner, { closeProject: async () => {}, kick: () => 0 })).rejects.toThrow(/owner/);
    expect(count('SELECT COUNT(*) AS n FROM users WHERE id = ?', owner.id)).toBe(1);
  });

  it('erases the owned projects with everything around them and forgets the account', async () => {
    // what accumulated around the account
    const now = Date.now();
    db.prepare("INSERT INTO git_tokens (user_id, name, token_hash, created_at) VALUES (?, 'cli', 'h-dora', ?)").run(dora.id, now);
    db.prepare("INSERT INTO mcp_tokens (user_id, name, token_hash, created_at) VALUES (?, 'mcp', 'm-dora', ?)").run(dora.id, now);
    db.prepare("INSERT INTO user_doc_state (user_id, doc_id, key, value, updated_at) VALUES (?, 'eve/paper/main.tex', 'fold', '[]', ?)").run(dora.id, now);
    db.prepare("INSERT INTO versions (doc_id, name, author, kind, created_at, lyx) VALUES ('dora/thesis/main.tex', 'v1', 'Dora Leaving', 'manual', ?, 'x')").run(now);
    db.prepare("INSERT INTO agent_threads (thread_id, project, user_id, created_at, updated_at) VALUES ('t-dora', 'eve/paper', ?, ?, ?)").run(dora.id, now, now);
    access.logAccess('eve/paper', dora.id, 'open', 'main.tex');
    const report = fb.submitFeedback({ kind: 'bug', title: 'from dora', body: 'x' }, { id: dora.id, name: 'Dora', username: 'dora' }).id;
    const error = fb.reportError({ kind: 'client-error', message: 'dora hit an error', who: { id: dora.id, name: 'Dora', username: 'dora' } })!;
    mkdirSync(join(ROOT, 'data', 'agent-home', String(dora.id)), { recursive: true });
    writeFileSync(join(ROOT, 'data', 'agent-home', String(dora.id), 'auth.json'), '{}');
    mkdirSync(join(ROOT, 'data', 'cache'), { recursive: true });
    writeFileSync(join(ROOT, 'data', 'cache', `avatar-${dora.id}`), 'png');
    // a project she deleted earlier (in the trash, its mirror archived) and a deleted file
    mkdirSync(join(ROOT, 'data', 'trash', 'dora', `old-${stamp(3)}`), { recursive: true });
    mkdirSync(join(ROOT, 'data', 'trash', 'files', 'dora', `thesis-${stamp(1)}`), { recursive: true });
    mkdirSync(join(ROOT, 'data', 'trash', 'files', 'eve', `paper-${stamp(1)}`), { recursive: true });
    for (const repo of ['dora-thesis', 'dora-notes', 'dora-old', 'eve-paper']) mkdirSync(join(ROOT, 'mirrors', `${repo}.git`), { recursive: true });
    db.prepare("INSERT INTO mirrors (project, repo) VALUES ('dora/thesis', 'dora-thesis'), ('eve/paper', 'eve-paper')").run();

    const closed: string[] = [], kicked: string[] = [];
    const erased = await accounts.deleteAccount(dora, { closeProject: async p => { closed.push(p); }, kick: (p, ids) => { kicked.push(`${p}:${ids.join(',')}`); return 1; } });
    expect(erased.sort()).toEqual(['dora/notes', 'dora/thesis']);
    expect(closed.sort()).toEqual(['dora/notes', 'dora/thesis']);
    expect(kicked).toEqual([`eve/paper:${dora.id}`]);

    // her projects: directories, rows, versions, mirrors, trash — gone; the namespace directory too
    expect(exists('projects', 'dora')).toBe(false);
    expect(access.projectRow('dora/thesis')).toBeUndefined();
    expect(count("SELECT COUNT(*) AS n FROM project_members WHERE project = 'dora/thesis'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM versions WHERE doc_id LIKE 'dora/%'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM mirrors WHERE project LIKE 'dora/%'")).toBe(0);
    for (const repo of ['dora-thesis', 'dora-notes', 'dora-old']) expect(exists('mirrors', `${repo}.git`)).toBe(false);
    expect(exists('data', 'trash', 'dora')).toBe(false);
    expect(exists('data', 'trash', 'files', 'dora')).toBe(false);
    // other people's things stay: eve's project, its mirror, eve's trash
    expect(exists('projects', 'eve', 'paper', 'main.tex')).toBe(true);
    expect(access.roleFor(eve, 'eve/paper')).toBe('owner');
    expect(exists('mirrors', 'eve-paper.git')).toBe(true);
    expect(exists('data', 'trash', 'files', 'eve')).toBe(true);
    // the account and what hung on it
    expect(count('SELECT COUNT(*) AS n FROM users WHERE id = ?', dora.id)).toBe(0);
    expect(access.roleFor(dora, 'eve/paper')).toBeNull();
    for (const t of ['project_members', 'git_tokens', 'mcp_tokens', 'user_doc_state', 'agent_threads']) expect(count(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, dora.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM access_log WHERE user_id = ?', dora.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM access_log WHERE project = 'eve/paper' AND user_id IS NULL")).toBe(1);   // the entry stays, unlinked
    expect(count('SELECT COUNT(*) AS n FROM reports WHERE id = ?', report)).toBe(0);
    expect((db.prepare('SELECT user_id FROM reports WHERE id = ?').get(error) as { user_id: number | null }).user_id).toBeNull();
    expect(exists('data', 'agent-home', String(dora.id))).toBe(false);
    expect(exists('data', 'cache', `avatar-${dora.id}`)).toBe(false);
  });
});

describe('the trash', () => {
  it('erases entries older than 30 days (projects with their archived mirror, files), keeps newer ones', async () => {
    const { readdirSync } = await import('node:fs');
    const trash = (...p: string[]) => join(ROOT, 'data', 'trash', ...p);
    const entries = { old: `old-${stamp(31)}`, recent: `recent-${stamp(5)}`, oldFile: `paper-${stamp(40)}`, oldAgentFile: `eve__paper-${stamp(35)}`, newAgentFile: `eve__paper-${stamp(2)}`, flat: `flatname-${stamp(90)}` };
    mkdirSync(trash('eve', entries.old), { recursive: true });
    mkdirSync(trash('eve', entries.recent), { recursive: true });
    mkdirSync(trash('files', 'eve', entries.oldFile, 'fig'), { recursive: true });
    mkdirSync(trash('files', entries.oldAgentFile), { recursive: true });
    mkdirSync(trash('files', entries.newAgentFile), { recursive: true });
    mkdirSync(trash(entries.flat), { recursive: true });
    mkdirSync(join(ROOT, 'mirrors', 'eve-old.git'), { recursive: true });
    expect(await accounts.pruneTrash()).toBe(4);
    expect(readdirSync(trash('eve'))).toEqual([entries.recent]);
    expect(existsSync(trash('files', 'eve', entries.oldFile))).toBe(false);
    expect(readdirSync(trash('files')).filter(n => n.startsWith('eve__'))).toEqual([entries.newAgentFile]);
    expect(existsSync(trash(entries.flat))).toBe(false);
    expect(existsSync(join(ROOT, 'mirrors', 'eve-old.git'))).toBe(false);    // the archived mirror of the expired project
    expect(existsSync(join(ROOT, 'mirrors', 'eve-paper.git'))).toBe(true);   // a live project's mirror stays
  });
});

describe('the privacy notice', () => {
  it('names the operator, the contact, the deletion and the retention it promises', () => {
    const html = privacyHtml();
    expect(html).toContain('Ada Operator');
    expect(html).toContain('mailto:privacy@example.org');
    expect(html).toContain('Settings ▸ Account ▸ Delete account');
    expect(html).toContain(`${accounts.TRASH_DAYS} days in the trash`);
    expect(html).toContain('Falkenstein, Germany');
    expect(html).toContain('href="/terms"');
    expect(html).not.toMatch(/<script/i);
  });
});

describe('the terms of use', () => {
  it('name the operator, point to the privacy notice and keep what the law does not let them limit', () => {
    const html = termsHtml();
    expect(html).toContain('Ada Operator');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('injury to life, body or health');
    expect(html).not.toMatch(/<script/i);
  });
});
