/**
 * Owner namespaces (core projectKey.ts): a project is `<projects root>/<owner>/<name>` and is
 * called `<owner>/<name>` everywhere — rows, document ids, URLs, git remotes, MCP.
 *
 *  - `moveProject` gives a project a new key: its directory, every row that names it or one of its
 *    documents, and its build directories move along, and the old key stays an **alias**
 *    (`project_aliases`), so old links, git remotes and MCP clients keep working (`canonicalProject`,
 *    `canonicalDocId`). It is used by the migration from the flat layout, for a directory put at the
 *    top level by hand (access.ts adoptProjects), and when a project gets a new owner;
 *  - `migrateToNamespaces` (startup) moves every project of the flat layout (`<root>/<name>`, before
 *    26 Sep 2026) into its owner's namespace. A move is journalled (`project_moves`) before the
 *    directory is touched, so one interrupted by a crash is finished at the next start.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isProjectKey, isProjectName, splitDocId } from '@overlyx/core';
import { db } from './db.ts';
import { config } from './config.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS project_aliases (
  alias TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_moves (
  from_key TEXT PRIMARY KEY,
  to_key TEXT NOT NULL,
  stage TEXT NOT NULL
);
`);

/** Tables naming a project, and tables naming documents (ids `<project>/<path>`). */
const PROJECT_COLUMNS: [string, string][] = [['projects', 'name'], ['project_members', 'project'], ['admin_grants', 'project'], ['access_log', 'project'], ['mirrors', 'project'], ['agent_threads', 'project']];
const DOC_COLUMNS: [string, string][] = [['ydocs', 'id'], ['versions', 'doc_id'], ['builds', 'doc_id'], ['pdf_links', 'doc_id'], ['user_doc_state', 'doc_id'], ['pdf_publish', 'doc_id']];

/** A document's build directory (export.ts buildDir): named by a hash of its id. */
export function buildDirPath(docId: string): string {
  return path.join(config.dataDir, 'build', crypto.createHash('sha1').update(docId).digest('hex').slice(0, 16));
}

/** The directory of a key — also of an old flat-layout name (one segment). */
function dirOf(key: string): string {
  return path.join(config.projectsDir, ...key.split('/'));
}

const rowExists = (key: string) => !!db.prepare('SELECT 1 FROM projects WHERE name = ?').get(key);

/** `<owner>/<name>`, or `<owner>/<name>-2`, … — the first key with neither a directory nor a row. */
export function freeKey(owner: string, name: string): string {
  let key = `${owner}/${name}`;
  for (let k = 2; fs.existsSync(dirOf(key)) || rowExists(key) || db.prepare('SELECT 1 FROM project_moves WHERE to_key = ?').get(key); k++) key = `${owner}/${name}-${k}`;
  return key;
}

/**
 * Give the project `from` the key `to`: the rows first (with the alias and a journal entry, in one
 * transaction), then the directory — through a staging name, since the new place may lie inside
 * the old one (a flat-layout project named like its owner). Nothing of the project may be open.
 */
export function moveProject(from: string, to: string, opts: { alias?: boolean } = {}): void {
  if (!isProjectKey(to)) throw new Error(`bad project key "${to}"`);
  if (from === to) return;
  if (fs.existsSync(dirOf(to)) || rowExists(to)) throw new Error(`a project "${to}" exists already`);
  const stage = path.join(config.projectsDir, `.moving-${crypto.randomBytes(6).toString('hex')}`);
  const builds = (db.prepare('SELECT doc_id, pdf_path, tex_path FROM builds WHERE substr(doc_id, 1, ?) = ?').all(from.length + 1, from + '/') as { doc_id: string; pdf_path: string | null; tex_path: string | null }[]);
  // the build products move along: their directories are named by the document id (a child's
  // row may point into its master's directory)
  const dirs = new Map(builds.map(b => [buildDirPath(b.doc_id), buildDirPath(to + b.doc_id.slice(from.length))]));
  const moved = new Map<string, string>();
  const movedPath = (p: string | null) => {
    if (p) for (const [o, n] of moved) if (p.startsWith(o + path.sep)) return n + p.slice(o.length);
    return p;
  };
  db.transaction(() => {
    for (const [t, c] of PROJECT_COLUMNS) db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(to, from);
    for (const [t, c] of DOC_COLUMNS) db.prepare(`UPDATE ${t} SET ${c} = ? || substr(${c}, ?) WHERE substr(${c}, 1, ?) = ?`).run(to + '/', from.length + 2, from.length + 1, from + '/');
    for (const [o, n] of dirs) if (fs.existsSync(o) && !fs.existsSync(n)) { try { fs.renameSync(o, n); moved.set(o, n); } catch (e) { console.warn(`[namespaces] build directory ${o} stays:`, e); } }
    for (const b of builds) db.prepare('UPDATE builds SET pdf_path = ?, tex_path = ? WHERE doc_id = ?').run(movedPath(b.pdf_path), movedPath(b.tex_path), to + b.doc_id.slice(from.length));
    // earlier names of the project follow it; a name that is a project again is no alias any more
    db.prepare('UPDATE project_aliases SET name = ? WHERE name = ?').run(to, from);
    db.prepare('DELETE FROM project_aliases WHERE alias = ?').run(to);
    if (opts.alias !== false) db.prepare('INSERT OR REPLACE INTO project_aliases (alias, name, created_at) VALUES (?, ?, ?)').run(from, to, Date.now());
    db.prepare('INSERT OR REPLACE INTO project_moves (from_key, to_key, stage) VALUES (?, ?, ?)').run(from, to, stage);
  })();
  finishMove(from, to, stage);
}

/** The directory part of a journalled move (idempotent: whatever of it is done already is skipped). */
function finishMove(from: string, to: string, stage: string): void {
  const src = dirOf(from), dest = dirOf(to);
  if (!fs.existsSync(dest)) {
    if (!fs.existsSync(stage) && fs.existsSync(src)) fs.renameSync(src, stage);
    if (fs.existsSync(stage)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(stage, dest);
    }
  }
  db.prepare('DELETE FROM project_moves WHERE from_key = ?').run(from);
  console.log(`[namespaces] moved project "${from}" to "${to}"`);
}

/** The current key of a project named `key` (itself, or what an old name / an alias points to). */
export function canonicalProject(key: string): string {
  if (rowExists(key)) return key;
  const a = db.prepare('SELECT name FROM project_aliases WHERE alias = ?').get(key) as { name: string } | undefined;
  return a ? a.name : key;
}

/**
 * The current id of a document: an id of the flat layout (`thesis/main.tex`) or of a project that
 * moved to another owner becomes the id under the project's key (`jan/thesis/main.tex`).
 */
export function canonicalDocId(id: string): string {
  const { project, path: rel } = splitDocId(id);
  if (project && rowExists(project)) return id;
  if (project) {
    const moved = db.prepare('SELECT name FROM project_aliases WHERE alias = ?').get(project) as { name: string } | undefined;
    if (moved) return rel ? `${moved.name}/${rel}` : moved.name;
  }
  const i = id.indexOf('/');
  const flat = db.prepare('SELECT name FROM project_aliases WHERE alias = ?').get(i < 0 ? id : id.slice(0, i)) as { name: string } | undefined;
  if (flat) return i < 0 ? flat.name : `${flat.name}/${id.slice(i + 1)}`;
  return id;
}

const usernameOf = (id: number | null) => id == null ? undefined : (db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined)?.username;
const usernames = () => new Set((db.prepare('SELECT username FROM users').all() as { username: string }[]).map(r => r.username));

/**
 * Directories at the top level of the projects root that are not namespaces — projects of the flat
 * layout, or put there by hand — move into a namespace: their owner's (from their row) or else
 * `fallbackOwner`'s. Rows of the flat layout whose directory is gone (a deleted welcome project's
 * tombstone) are renamed the same way. Finishes interrupted moves first.
 */
export function moveFlatProjects(fallbackOwner: string | null): void {
  for (const m of db.prepare('SELECT * FROM project_moves').all() as { from_key: string; to_key: string; stage: string }[]) {
    try { finishMove(m.from_key, m.to_key, m.stage); } catch (e) { console.error(`[namespaces] cannot finish moving "${m.from_key}" to "${m.to_key}":`, e); }
  }
  const root = config.projectsDir;
  const users = usernames();
  // rows first: they know the owner. A project named like an account moves before anything moves
  // into that account's namespace — its directory is where the namespace goes.
  const flat = db.prepare("SELECT name, owner_id, kind FROM projects WHERE instr(name, '/') = 0").all() as { name: string; owner_id: number | null; kind: string }[];
  flat.sort((a, b) => Number(users.has(b.name)) - Number(users.has(a.name)));
  for (const r of flat) {
    const owner = usernameOf(r.owner_id) ?? fallbackOwner;
    if (!owner) continue;
    try {
      // a deleted welcome project's tombstone: a hidden name no project can take (isProjectName)
      if (r.kind === 'example-gone') { renameRow(r.name, `${owner}/.${r.name}`); continue; }
      const name = r.kind === 'example' && r.name === `welcome-${owner}` ? 'welcome' : r.name;
      moveProject(r.name, freeKey(owner, name));
    } catch (e) { console.error(`[namespaces] cannot move project "${r.name}" into "${owner}/":`, e); }
  }
  if (!fs.existsSync(root) || !fallbackOwner) return;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || users.has(e.name) || !isProjectName(e.name)) continue;
    try { moveProject(e.name, freeKey(fallbackOwner, e.name)); }
    catch (err) { console.error(`[namespaces] cannot move directory "${e.name}" into "${fallbackOwner}/":`, err); }
  }
}

/** A row without a directory gets another name (no alias: nothing can be opened under it). */
function renameRow(from: string, to: string): void {
  db.transaction(() => {
    for (const [t, c] of PROJECT_COLUMNS) db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(to, from);
  })();
}
