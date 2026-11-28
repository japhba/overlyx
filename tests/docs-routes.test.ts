/**
 * Document routes (`/docs/<id>/<action>`, packages/server/src/docaccess.ts): every one is registered
 * with its access check `needDoc(role)` in front, and this table is what each one needs. A route
 * added without the check fails here (and has no document to work on: docId() throws); a role that
 * changes changes this table on purpose. Then the check itself, against a scratch database: both
 * directions for project members and for people who have only a folder of the project.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-docs-routes-test');
rmSync(ROOT, { recursive: true, force: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
const P = join(ROOT, 'projects', 'jan', 'paper');
mkdirSync(join(P, 'talk'), { recursive: true });
mkdirSync(join(P, 'private'), { recursive: true });
writeFileSync(join(P, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{talk/part}\n\\end{document}\n');
writeFileSync(join(P, 'talk', 'part.tex'), 'A child of main.tex.\n');
writeFileSync(join(P, 'talk', 'own.tex'), '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n');
writeFileSync(join(P, 'talk', '50%.tex'), '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n');
writeFileSync(join(P, 'private', 'notes.tex'), 'secret\n');

const ROLES: Record<string, string> = {
  'GET /docs/*/external': 'view',
  'GET /docs/*/bib': 'view',
  'GET /docs/*/meta': 'view',
  'GET /docs/*/tex': 'view',
  'GET /docs/*/lyx': 'view',
  'GET /docs/*/outline': 'view',
  'GET /docs/*/header': 'view',
  'GET /docs/*/frontmatter': 'view',
  'GET /docs/*/versions': 'view',
  'GET /docs/*/versions/:vid': 'view',
  // the user's own way of looking at a document: viewers keep theirs too
  'GET /docs/*/folds': 'view',
  'PUT /docs/*/folds': 'view',
  'GET /docs/*/place': 'view',
  'PUT /docs/*/place': 'view',
  'PUT /docs/*/opened': 'view',
  // building only reads the document; its build is not shown to someone whose folder lacks the master
  'POST /docs/*/export': 'view built',
  'POST /docs/*/export/cancel': 'view built',
  'GET /docs/*/pdf': 'view built',
  'GET /docs/*/build': 'view built',
  'GET /docs/*/synctex/view': 'view built',
  'GET /docs/*/synctex/edit': 'view built',
  'GET /docs/*/synctex/pages': 'view built',
  'GET /docs/*/layoutcheck': 'view built',
  'POST /docs/*/source': 'edit',
  'POST /docs/*/save': 'edit',
  'POST /docs/*/reset': 'edit',
  'POST /docs/*/header': 'edit',
  'POST /docs/*/frontmatter': 'edit',
  'POST /docs/*/legacy-merge': 'edit',
  'POST /docs/*/versions': 'edit',
  'PATCH /docs/*/versions/:vid': 'edit',
  'DELETE /docs/*/versions/:vid': 'edit',
  'POST /docs/*/versions/:vid/restore': 'edit',
  'POST /docs/*/versions/:vid/part': 'edit',
  'POST /docs/*/as-article': 'edit',
  'POST /docs/*/repair': 'edit',
  'POST /docs/*/clip': 'edit',
  // (below edit only the document's own raw objects: snippets.ts ownOnly)
  'POST /docs/*/snippet': 'view',
  'POST /docs/*/ai-repair': 'edit',
  'POST /docs/*/ai-repair/apply': 'edit',
  'POST /docs/*/ai/rewrite': 'edit',
  'POST /docs/*/ai/merge': 'edit',
  'POST /docs/*/ai/complete': 'edit',
  'POST /docs/*/gdocs/link': 'edit',
  'POST /docs/*/gdocs/sync': 'edit',
  'POST /docs/*/gdocs/unlink': 'edit',
  'POST /docs/*/gdocs/auto': 'edit',
  'POST /docs/*/lesswrong/link': 'edit',
  'POST /docs/*/lesswrong/key': 'edit',
  'POST /docs/*/lesswrong/sync': 'edit',
  'POST /docs/*/lesswrong/unlink': 'edit',
  'POST /docs/*/lesswrong/auto': 'edit',
};

function serverSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? serverSources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
}

describe('document routes', () => {
  it('are each registered with their access check, and need what this table says', () => {
    const found: Record<string, string> = {};
    const ungated: string[] = [];
    for (const file of serverSources(join(__dirname, '..', 'packages', 'server', 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\.(get|post|put|patch|delete|all|use)\(\s*(['"`])(\/docs\/[^'"`]*)\2\s*,\s*([^\n]*)/g)) {
        const key = `${m[1].toUpperCase()} ${m[3]}`;
        const gate = /^needDoc\('(view|edit)'(\s*,\s*\{\s*built:\s*true\s*\})?\)\s*,/.exec(m[4]);
        if (!gate) { ungated.push(`${file}: ${key}`); continue; }
        expect(found[key], `${key} registered twice`).toBeUndefined();
        found[key] = gate[1] + (gate[2] ? ' built' : '');
      }
    }
    expect(ungated).toEqual([]);
    expect(found).toEqual(ROLES);
  });
});

const access = await import('../packages/server/src/access.ts');
const { createUser, toSessionUser } = await import('../packages/server/src/auth.ts');
const { needDoc, docId } = await import('../packages/server/src/docaccess.ts');
const express = (await import('express')).default;

const jan = toSessionUser(createUser('jan', 'Jan', 'pw'));
const users = {
  jan,
  vic: toSessionUser(createUser('vic', 'Vic', 'pw')),
  eddie: toSessionUser(createUser('eddie', 'Eddie', 'pw')),
  ada: toSessionUser(createUser('ada', 'Ada', 'pw')),
  fred: toSessionUser(createUser('fred', 'Fred', 'pw')),
  bob: toSessionUser(createUser('bob', 'Bob', 'pw')),
};
access.adoptProjects();
access.addMember('jan/paper', 'vic', 'view', jan);
access.addMember('jan/paper', 'eddie', 'edit', jan);
access.addFolderMember('jan/paper', 'talk', 'ada', 'view', jan);
access.addFolderMember('jan/paper', 'talk', 'fred', 'edit', jan);

const app = express();
app.use((req, _res, next) => { req.user = users[String(req.headers['x-user']) as keyof typeof users]; next(); });
const answer = (req: import('express').Request, res: import('express').Response) => { res.json({ id: docId(req), role: req.role, partial: !!req.partial }); };
app.get('/docs/*/meta', needDoc('view'), answer);
app.post('/docs/*/source', needDoc('edit'), answer);
app.get('/docs/*/layoutcheck', needDoc('view', { built: true }), answer);
app.get('/docs/*/ungated', answer);
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(who: keyof typeof users, method: 'GET' | 'POST', doc: string, action: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/docs/${encodeURIComponent(doc)}/${action}`, { method, headers: { 'x-user': who } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe('needDoc', () => {
  it('lets project members read with view and change with edit, and nobody else', async () => {
    expect((await call('bob', 'GET', 'jan/paper/main.tex', 'meta')).status).toBe(403);
    expect(await call('vic', 'GET', 'jan/paper/main.tex', 'meta')).toEqual({ status: 200, body: { id: 'jan/paper/main.tex', role: 'view', partial: false } });
    expect((await call('vic', 'POST', 'jan/paper/main.tex', 'source')).status).toBe(403);
    expect(await call('eddie', 'POST', 'jan/paper/main.tex', 'source')).toEqual({ status: 200, body: { id: 'jan/paper/main.tex', role: 'edit', partial: false } });
    expect((await call('bob', 'POST', 'jan/paper/main.tex', 'source')).status).toBe(403);
  });

  it('lets people with a folder use its documents, at the folder\'s role, and nothing outside it', async () => {
    expect(await call('ada', 'GET', 'jan/paper/talk/own.tex', 'meta')).toEqual({ status: 200, body: { id: 'jan/paper/talk/own.tex', role: 'view', partial: true } });
    expect((await call('ada', 'GET', 'jan/paper/private/notes.tex', 'meta')).status).toBe(403);
    expect((await call('ada', 'GET', 'jan/paper/main.tex', 'meta')).status).toBe(403);
    expect((await call('ada', 'POST', 'jan/paper/talk/own.tex', 'source')).status).toBe(403);
    expect(await call('fred', 'POST', 'jan/paper/talk/own.tex', 'source')).toEqual({ status: 200, body: { id: 'jan/paper/talk/own.tex', role: 'edit', partial: true } });
    expect((await call('fred', 'POST', 'jan/paper/private/notes.tex', 'source')).status).toBe(403);
  });

  it('does not show someone with a folder the build of a master document outside it (the layout check too)', async () => {
    const r = await call('ada', 'GET', 'jan/paper/talk/part.tex', 'layoutcheck');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/built through main\.tex/);
    expect((await call('fred', 'GET', 'jan/paper/talk/part.tex', 'layoutcheck')).status).toBe(403);
    // the document itself, and a document of the folder built on its own, are theirs
    expect((await call('ada', 'GET', 'jan/paper/talk/part.tex', 'meta')).status).toBe(200);
    expect((await call('ada', 'GET', 'jan/paper/talk/own.tex', 'layoutcheck')).status).toBe(200);
    // the project's people see every build
    expect((await call('vic', 'GET', 'jan/paper/talk/part.tex', 'layoutcheck')).status).toBe(200);
  });

  it('names the document the route was asked about: a % in a file name stays a %', async () => {
    expect((await call('jan', 'GET', 'jan/paper/talk/50%.tex', 'meta')).body.id).toBe('jan/paper/talk/50%.tex');
    expect((await call('jan', 'GET', 'jan/paper/talk/a%41.tex', 'meta')).body.id).toBe('jan/paper/talk/a%41.tex');
    // an action's name inside the id is part of the id, not the action
    expect((await call('jan', 'GET', 'jan/paper/meta/x.tex', 'meta')).body.id).toBe('jan/paper/meta/x.tex');
  });

  it('gives a route registered without it no document', async () => {
    expect((await call('jan', 'GET', 'jan/paper/main.tex', 'ungated')).status).toBe(500);
    server.close();
  });
});
