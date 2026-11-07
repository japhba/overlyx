/**
 * The HTTP side of end-to-end encrypted projects (store.ts), under /api/e2e: an account's key pair,
 * the wrapped project keys of a project's members, the encrypted blobs, and the public TeX Live and
 * LyX files the browser compiles and parses with (texlive.ts). Everything a browser sends here is
 * ciphertext or a public key; everything it gets back is too.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import { db } from '../db.ts';
import { roleFor, atLeast, projectRow, logAccess, type Role } from '../access.ts';
import { canonicalProject } from '../namespaces.ts';
import { assertRoom, ProjectFullError } from '../projectsize.ts';
import {
  e2eEnabled, isE2eProject, OPAQUE_ID, userKeys, setUserKeys, resealPrivate, dropKeysEverywhere, publicKeysOf, wrappedKeys, grantKey,
  keyVersion, needsRotation, rotateKey, writeBlob, blobFile, blobSize, deleteBlob, docIds, deleteDoc,
} from './store.ts';
import { texliveFile, texliveVersion, texliveNames, lyxlibBundle, luaotfloadNames } from './texlive.ts';
import { announceKey } from './relay.ts';

/** a public key / wrapped key / sealed private key: base64url text of a few hundred bytes */
const KEY_TEXT = /^[A-Za-z0-9_.:-]{16,8192}$/;
const MAX_BLOB = 100 * 1024 * 1024;

export function e2eRoutes(): express.Router {
  const r = express.Router();

  r.get('/e2e/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: e2eEnabled, texlive: texliveVersion(), lyxlib: lyxlibBundle().version });
  });

  // public files: TeX Live's (for the engine) and LyX's library (for the parser), versioned in the URL
  r.get('/e2e/texlive/:ver/names.txt', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', req.params.ver === texliveVersion() ? 'private, max-age=31536000, immutable' : 'no-store');
    const gz = texliveNames();
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) { res.setHeader('Content-Encoding', 'gzip'); res.end(gz); }
    else res.end(zlib.gunzipSync(gz));
  });
  r.get('/e2e/texlive/:ver/luaotfload-names.lua.gz', async (_req, res) => {
    const names = await luaotfloadNames();
    if (!names) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'application/gzip');
    res.end(names);
  });
  r.get('/e2e/texlive/:ver/:program/:format/:name', async (req, res) => {
    const file = await texliveFile(String(req.params.program), Number(req.params.format), String(req.params.name));
    // the version is in the URL: a miss is as lasting as a hit (the engine asks for many files that do not exist)
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    if (!file) { res.status(404).end(); return; }
    res.setHeader('X-TeX-File', path.basename(file));
    res.sendFile(file);
  });
  r.get('/e2e/lyxlib/:ver', (req, res) => {
    const b = lyxlibBundle();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', req.params.ver === b.version ? 'private, max-age=31536000, immutable' : 'no-store');
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) { res.setHeader('Content-Encoding', 'gzip'); res.end(b.gz); }
    else res.end(b.json);
  });

  r.use('/e2e', (_req, res, next) => { if (!e2eEnabled) { res.status(503).json({ error: 'End-to-end encrypted projects are switched off on this server' }); return; } next(); });

  /* ------------------------------------------------------------- the account's key pair */

  r.get('/e2e/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ keys: userKeys(req.user!.id) });
  });
  /** A key pair made in the browser: `{ publicKey, sealedPrivate, replace? }`. Replacing one drops the project keys wrapped for the old one. */
  r.put('/e2e/me', (req, res) => {
    const { publicKey, sealedPrivate, replace } = req.body ?? {};
    if (typeof publicKey !== 'string' || !KEY_TEXT.test(publicKey) || typeof sealedPrivate !== 'string' || !KEY_TEXT.test(sealedPrivate)) { res.status(400).json({ error: 'bad keys' }); return; }
    const had = userKeys(req.user!.id);
    if (had && had.publicKey !== publicKey) {
      if (replace !== true) { res.status(409).json({ error: 'This account has a key pair already' }); return; }
      dropKeysEverywhere(req.user!.id);
    }
    setUserKeys(req.user!.id, publicKey, sealedPrivate);
    res.json({ keys: userKeys(req.user!.id) });
  });
  /** The private key sealed with a new recovery code. */
  r.post('/e2e/me/reseal', (req, res) => {
    const s = req.body?.sealedPrivate;
    if (typeof s !== 'string' || !KEY_TEXT.test(s)) { res.status(400).json({ error: 'bad key' }); return; }
    res.json({ ok: resealPrivate(req.user!.id, s) });
  });

  /* ------------------------------------------------------------------ project routes */

  const need = (min: Role) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const project = req.params.project = canonicalProject(String(req.params.project ?? ''));
    if (!isE2eProject(project)) { res.status(404).json({ error: 'not an end-to-end encrypted project' }); return; }
    const role = roleFor(req.user!, project);
    if (!atLeast(role, min)) { res.status(403).json({ error: role ? 'You can only view this project' : 'You do not have access to this project' }); return; }
    req.role = role!;
    next();
  };

  /** the project's members (owner first) and their roles; not those who only see it because it is public */
  const membersOf = (project: string): Map<number, { role: string; via: string }> => {
    const row = projectRow(project)!;
    const members = new Map<number, { role: string; via: string }>();
    if (row.owner_id != null) members.set(row.owner_id, { role: 'owner', via: 'owner' });
    for (const m of db.prepare("SELECT user_id, role, via FROM project_members WHERE project = ? AND user_id IS NOT NULL AND via != 'public'").all(project) as { user_id: number; role: string; via: string }[]) {
      const had = members.get(m.user_id);
      if (!had || (had.role === 'view' && m.role === 'edit')) members.set(m.user_id, { role: m.role, via: m.via });
    }
    return members;
  };

  /** Grants as sent (`[{ userId, version, wrapped }]`): those for members who have a key pair (the wrapped key names the public key it was made for). */
  const validGrants = (project: string, body: unknown): { userId: number; version: number; wrapped: string }[] => {
    const list = Array.isArray(body) ? body.slice(0, 200) : [];
    const pub = publicKeysOf(list.map((g: { userId?: unknown }) => Number(g?.userId)).filter(Number.isInteger));
    const out: { userId: number; version: number; wrapped: string }[] = [];
    for (const g of list) {
      const userId = Number(g?.userId), version = Number(g?.version), wrapped = g?.wrapped;
      if (!Number.isInteger(userId) || !Number.isInteger(version) || version < 1 || version > 65535 || typeof wrapped !== 'string' || !KEY_TEXT.test(wrapped)) continue;
      const u = db.prepare('SELECT id, username, display_name, color, is_admin, is_guest, email FROM users WHERE id = ?').get(userId) as { id: number; username: string; display_name: string; color: string; is_admin: number; is_guest: number; email: string | null } | undefined;
      if (!u || !pub.has(userId)) continue;
      if (!roleFor({ id: u.id, username: u.username, name: u.display_name, color: u.color, isAdmin: !!u.is_admin, guest: !!u.is_guest, email: u.email }, project, false)) continue;
      out.push({ userId, version, wrapped });
    }
    return out;
  };

  /**
   * The project's members with their public keys and which key versions they hold; the caller's
   * wrapped keys; and `rotate` when someone who held the key is no longer a member (an editor's
   * browser then makes a new one: POST …/keys/rotate).
   */
  r.get('/e2e/projects/:project/keys', need('view'), (req, res) => {
    const project = req.params.project;
    const members = membersOf(project);
    const keys = wrappedKeys(project);
    const pub = publicKeysOf([...members.keys()]);
    const users = new Map((db.prepare(`SELECT id, display_name, username, is_guest FROM users WHERE id IN (${[...members.keys()].map(() => '?').join(',') || 'NULL'})`).all(...members.keys()) as { id: number; display_name: string; username: string; is_guest: number }[]).map(u => [u.id, u]));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      version: keyVersion(project),
      rotate: needsRotation(project, new Set(members.keys())),
      mine: keys.filter(k => k.userId === req.user!.id).map(k => ({ version: k.version, wrapped: k.wrapped })),
      members: [...members].map(([id, m]) => ({
        userId: id, role: m.role, via: m.via, name: users.get(id)?.display_name ?? '?', username: users.get(id)?.username ?? '?', guest: !!users.get(id)?.is_guest,
        publicKey: pub.get(id) ?? null, versions: keys.filter(k => k.userId === id).map(k => k.version),
      })),
    });
  });
  /**
   * `{ grants: [{ userId, version, wrapped }] }`: the project key wrapped for members' public keys,
   * by a member who holds it — versions that exist (or the first); a member's key already there stays.
   */
  r.post('/e2e/projects/:project/keys', need('edit'), (req, res) => {
    const project = req.params.project;
    const newest = keyVersion(project);
    let n = 0;
    for (const g of validGrants(project, req.body?.grants)) {
      if (g.version > Math.max(newest, 1)) continue;
      if (grantKey(project, g.userId, g.version, g.wrapped, req.user!.id) && g.version === Math.max(newest, 1)) n++;
    }
    if (n) logAccess(project, req.user!.id, 'share', `gave the encryption key to ${n} member${n === 1 ? '' : 's'}`);
    res.json({ granted: n });
  });
  /**
   * `{ version, grants: [{ userId, wrapped }] }`: a new project key, the next version, wrapped for the
   * members who stay (the caller among them). 409 when another browser made it first.
   */
  r.post('/e2e/projects/:project/keys/rotate', need('edit'), (req, res) => {
    const project = req.params.project;
    const version = Number(req.body?.version);
    const raw = Array.isArray(req.body?.grants) ? req.body.grants.map((g: Record<string, unknown>) => ({ ...g, version })) : [];
    const grants = validGrants(project, raw);
    if (!Number.isInteger(version) || !grants.some(g => g.userId === req.user!.id)) { res.status(400).json({ error: 'a new key needs a version and the caller\'s own copy' }); return; }
    if (!rotateKey(project, version, grants, req.user!.id)) { res.status(409).json({ error: 'The key was replaced already', version: keyVersion(project) }); return; }
    logAccess(project, req.user!.id, 'share', 'replaced the encryption key (a member had left)');
    announceKey(project, version);
    res.json({ ok: true, version });
  });

  /* --------------------------------------------------------------------- blobs, logs */

  r.put('/e2e/projects/:project/blobs/:id', need('edit'), express.raw({ type: '*/*', limit: MAX_BLOB }), (req, res) => {
    const { project, id } = req.params;
    if (!OPAQUE_ID.test(id)) { res.status(400).json({ error: 'bad id' }); return; }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try { assertRoom(project, body.length, blobSize(project, id) ?? 0, 'This file'); }
    catch (e) { if (e instanceof ProjectFullError) { res.status(413).json({ error: e.message }); return; } throw e; }
    writeBlob(project, id, body);
    res.json({ ok: true, size: body.length });
  });
  r.get('/e2e/projects/:project/blobs/:id', need('view'), (req, res) => {
    const { project, id } = req.params;
    if (!OPAQUE_ID.test(id)) { res.status(400).json({ error: 'bad id' }); return; }
    const f = blobFile(project, id);
    if (!f) { res.status(404).json({ error: 'no such file' }); return; }
    // blobs never change: a new version of a file is a new blob
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(f).pipe(res);
  });
  r.delete('/e2e/projects/:project/blobs/:id', need('edit'), (req, res) => {
    if (!OPAQUE_ID.test(req.params.id)) { res.status(400).json({ error: 'bad id' }); return; }
    res.json({ ok: deleteBlob(req.params.project, req.params.id) });
  });
  r.get('/e2e/projects/:project/docs', need('view'), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ docs: docIds(req.params.project) });
  });
  r.delete('/e2e/projects/:project/docs/:doc', need('edit'), (req, res) => {
    if (!OPAQUE_ID.test(req.params.doc)) { res.status(400).json({ error: 'bad id' }); return; }
    deleteDoc(req.params.project, req.params.doc);
    res.json({ ok: true });
  });

  return r;
}
