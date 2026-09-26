/**
 * Owner namespaces (server/namespaces.ts, core projectKey.ts): the migration from the flat layout
 * (`<projects>/<name>`) moves every project into its owner's namespace (`<projects>/<owner>/<name>`)
 * with everything that names it — the rows of every table, document ids, build directories — and
 * keeps the old names as aliases; an interrupted move is finished at the next start.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-namespaces-test');
rmSync(ROOT, { recursive: true, force: true });
const P = (...parts: string[]) => join(ROOT, 'projects', ...parts);
for (const [dir, file] of [['thesis', 'main.tex'], ['welcome-jan', 'welcome.tex'], ['jan', 'main.tex'], ['bob', 'notes.tex'], ['handmade', 'x.tex']]) {
  mkdirSync(P(dir), { recursive: true });
  writeFileSync(P(dir, file), `% ${dir}\n`);
}
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_OWNER_EMAIL = 'jan@example.com';

const { splitDocId, projectOfDoc, docPathOf, docDirOf, isProjectKey, isProjectName, projectShortName } = await import('../packages/core/src/projectKey.ts');
const { db } = await import('../packages/server/src/db.ts');
const { createUser, toSessionUser } = await import('../packages/server/src/auth.ts');
const access = await import('../packages/server/src/access.ts');
const ns = await import('../packages/server/src/namespaces.ts');
const { listProjects } = await import('../packages/server/src/projects.ts');

const jan = createUser('jan', 'Jan', null, { email: 'jan@example.com', googleSub: 'g-jan' });
const bob = createUser('bob', 'Bob', 'pw');
const kim = createUser('kim', 'Kim', 'pw');

// the flat layout's rows, as a database from before namespaces holds them
const now = Date.now();
for (const [name, owner, kind] of [['thesis', jan.id, 'project'], ['welcome-jan', jan.id, 'example'], ['jan', jan.id, 'project'], ['bob', jan.id, 'project'], ['welcome-kim', kim.id, 'example-gone']] as const) {
  db.prepare('INSERT INTO projects (name, owner_id, kind, created_at) VALUES (?, ?, ?, ?)').run(name, owner, kind, now);
}
db.prepare("INSERT INTO project_members (project, user_id, role, via, created_at) VALUES ('thesis', ?, 'edit', 'user', ?)").run(bob.id, now);
db.prepare("INSERT INTO access_log (project, user_id, action, detail, at) VALUES ('thesis', ?, 'open', 'main.tex', ?)").run(bob.id, now);
db.prepare("INSERT INTO mirrors (project, repo, enabled) VALUES ('thesis', 'thesis', 1)").run();
db.prepare("INSERT INTO agent_threads (thread_id, project, user_id, created_at, updated_at) VALUES ('t1', 'thesis', ?, ?, ?)").run(jan.id, now, now);
db.prepare("INSERT INTO ydocs (id, state, file_hash, updated_at) VALUES ('thesis/main.tex', x'00', 'h', ?)").run(now);
db.prepare("INSERT INTO versions (doc_id, name, author, kind, created_at, lyx) VALUES ('thesis/main.tex', 'v1', 'jan', 'named', ?, 'x')").run(now);
db.prepare("INSERT INTO pdf_links (token, doc_id, created_at) VALUES ('tok', 'thesis/main.tex', ?)").run(now);
db.prepare("INSERT INTO user_doc_state (user_id, doc_id, key, value, updated_at) VALUES (?, 'thesis/chapters/one.tex', 'opened', '1', ?)").run(bob.id, now);
db.prepare("INSERT INTO pdf_publish (doc_id, repo, path, created_at) VALUES ('thesis/main.tex', 'jan/site', 'cv.pdf', ?)").run(now);
// the master's build, and a child whose row points into the master's build directory
const oldBuild = ns.buildDirPath('thesis/main.tex');
mkdirSync(oldBuild, { recursive: true });
writeFileSync(join(oldBuild, 'main.pdf'), '%PDF');
db.prepare('INSERT INTO builds (doc_id, status, log, pdf_path, tex_path, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('thesis/main.tex', 'ok', '', join(oldBuild, 'main.pdf'), join(oldBuild, 'main.tex'), now);
db.prepare('INSERT INTO builds (doc_id, status, log, pdf_path, tex_path, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('thesis/chapters/one.tex', 'ok', '', join(oldBuild, 'main.pdf'), null, now);

describe('project keys (core)', () => {
  it('split document ids into the project key and the path', () => {
    expect(splitDocId('jan/thesis/chapters/one.tex')).toEqual({ project: 'jan/thesis', path: 'chapters/one.tex' });
    expect(projectOfDoc('jan/thesis/main.tex')).toBe('jan/thesis');
    expect(projectOfDoc('jan/thesis')).toBe('jan/thesis');
    expect(projectOfDoc('thesis')).toBe('');
    expect(docPathOf('jan/thesis/main.tex')).toBe('main.tex');
    expect(docDirOf('jan/thesis/chapters/one.tex')).toBe('chapters');
    expect(docDirOf('jan/thesis/main.tex')).toBe('');
    expect(projectShortName('noah.rw.wells/My Paper')).toBe('My Paper');
  });
  it('accept keys and names, refuse what could leave the projects directory or hide', () => {
    expect(isProjectKey('noah.rw.wells/My Paper v2')).toBe(true);
    expect(isProjectKey('thesis')).toBe(false);
    expect(isProjectKey('../x')).toBe(false);
    expect(isProjectKey('jan/..')).toBe(false);
    expect(isProjectKey('jan/a/b')).toBe(false);
    expect(isProjectName('My Paper')).toBe(true);
    expect(isProjectName('.hidden')).toBe(false);
    expect(isProjectName('a/b')).toBe(false);
    expect(isProjectName('trailing ')).toBe(false);
  });
});

describe('migration from the flat layout', () => {
  it('moves every project into its owner\'s namespace, with all rows and build products', () => {
    access.adoptProjects();
    expect(readFileSync(P('jan', 'thesis', 'main.tex'), 'utf8')).toBe('% thesis\n');
    expect(existsSync(P('thesis'))).toBe(false);
    // rows naming the project, and rows naming its documents
    expect(access.projectRow('jan/thesis')?.owner_id).toBe(jan.id);
    expect(access.projectRow('thesis')).toBeUndefined();
    const one = (sql: string) => db.prepare(sql).get();
    expect(one("SELECT project FROM project_members WHERE user_id = " + bob.id)).toEqual({ project: 'jan/thesis' });
    expect(one("SELECT project FROM access_log")).toEqual({ project: 'jan/thesis' });
    expect(one("SELECT project, repo FROM mirrors")).toEqual({ project: 'jan/thesis', repo: 'thesis' });   // the GitHub repository keeps its name
    expect(one("SELECT project FROM agent_threads")).toEqual({ project: 'jan/thesis' });
    expect(one("SELECT id FROM ydocs")).toEqual({ id: 'jan/thesis/main.tex' });
    expect(one("SELECT doc_id FROM versions")).toEqual({ doc_id: 'jan/thesis/main.tex' });
    expect(one("SELECT doc_id FROM pdf_links WHERE token = 'tok'")).toEqual({ doc_id: 'jan/thesis/main.tex' });
    expect(one("SELECT doc_id FROM user_doc_state")).toEqual({ doc_id: 'jan/thesis/chapters/one.tex' });
    expect(one("SELECT doc_id FROM pdf_publish")).toEqual({ doc_id: 'jan/thesis/main.tex' });
    // the build directory is named by the document id: it moves, and the paths follow
    const newBuild = ns.buildDirPath('jan/thesis/main.tex');
    expect(existsSync(join(newBuild, 'main.pdf'))).toBe(true);
    expect(existsSync(oldBuild)).toBe(false);
    const builds = db.prepare('SELECT doc_id, pdf_path FROM builds ORDER BY doc_id').all();
    expect(builds).toEqual([
      { doc_id: 'jan/thesis/chapters/one.tex', pdf_path: join(newBuild, 'main.pdf') },
      { doc_id: 'jan/thesis/main.tex', pdf_path: join(newBuild, 'main.pdf') },
    ]);
  });

  it('the welcome project becomes <owner>/welcome, a deleted one\'s tombstone a hidden name', () => {
    expect(existsSync(P('jan', 'welcome', 'welcome.tex'))).toBe(true);
    expect(access.projectRow('jan/welcome')?.kind).toBe('example');
    expect(access.ensureWelcomeProject(toSessionUser(jan))).toBe('jan/welcome');   // the moved one, not a second
    expect(access.projectRow('kim/.welcome-kim')?.kind).toBe('example-gone');
    expect(access.ensureWelcomeProject(toSessionUser(kim))).toBeNull();   // still not re-created
  });

  it('a flat project named like an account moves too — into its owner\'s namespace, not that account\'s', () => {
    expect(readFileSync(P('jan', 'jan', 'main.tex'), 'utf8')).toBe('% jan\n');
    expect(readFileSync(P('jan', 'bob', 'notes.tex'), 'utf8')).toBe('% bob\n');
    expect(access.projectRow('jan/jan')?.owner_id).toBe(jan.id);
    expect(access.projectRow('jan/bob')?.owner_id).toBe(jan.id);
    expect(access.accessibleProjects(toSessionUser(bob)).map(p => p.name)).toEqual(['jan/thesis']);
  });

  it('a directory without a row goes to the instance owner', () => {
    expect(existsSync(P('jan', 'handmade', 'x.tex'))).toBe(true);
    expect(access.projectRow('jan/handmade')?.owner_id).toBe(jan.id);
    expect(listProjects().map(p => p.name)).toEqual(['jan/bob', 'jan/handmade', 'jan/jan', 'jan/thesis', 'jan/welcome']);
  });

  it('old names lead to the projects and their documents', () => {
    expect(ns.canonicalProject('thesis')).toBe('jan/thesis');
    expect(ns.canonicalProject('welcome-jan')).toBe('jan/welcome');
    expect(ns.canonicalProject('jan/thesis')).toBe('jan/thesis');
    expect(ns.canonicalProject('nothing')).toBe('nothing');
    expect(ns.canonicalDocId('thesis/chapters/one.tex')).toBe('jan/thesis/chapters/one.tex');
    expect(ns.canonicalDocId('jan/thesis/main.tex')).toBe('jan/thesis/main.tex');
    // the flat project "jan": its old id and the new key look alike, the new key wins
    expect(ns.canonicalDocId('jan/main.tex')).toBe('jan/jan/main.tex');
    expect(ns.canonicalDocId('jan/jan/main.tex')).toBe('jan/jan/main.tex');
    expect(ns.canonicalDocId('bob/notes.tex')).toBe('jan/bob/notes.tex');
  });

  it('is idempotent', () => {
    const before = db.prepare('SELECT name FROM projects ORDER BY name').all();
    access.adoptProjects();
    expect(db.prepare('SELECT name FROM projects ORDER BY name').all()).toEqual(before);
  });

  it('finishes a move that was interrupted after the rows were renamed', () => {
    // a crash between the database and the directory: the journal names both ends and the staging name
    mkdirSync(P('.moving-crash'), { recursive: true });
    writeFileSync(P('.moving-crash', 'main.tex'), 'staged\n');
    db.prepare("INSERT INTO projects (name, owner_id, kind, created_at) VALUES ('bob/paper', ?, 'project', ?)").run(bob.id, now);
    db.prepare("INSERT INTO project_moves (from_key, to_key, stage) VALUES ('paper', 'bob/paper', ?)").run(P('.moving-crash'));
    access.adoptProjects();
    expect(readFileSync(P('bob', 'paper', 'main.tex'), 'utf8')).toBe('staged\n');
    expect(existsSync(P('.moving-crash'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_moves').get()).toEqual({ n: 0 });
  });
});
