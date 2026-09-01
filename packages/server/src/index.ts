import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.ts';
import { requestAiRepair, AiRepairError } from './airepair.ts';
import { aiStatus, aiAvailable, rewrite as aiRewrite, complete as aiComplete, allow as aiAllow, AiError } from './ai.ts';
import { mcpRouter } from './mcp.ts';
import { createMcpToken, listMcpTokens, deleteMcpToken } from './mcpTokens.ts';
import { userSettings, setUserSettings } from './userSettings.ts';
import { authMiddleware, authRouter, requireAuth, createUser, generatePassword } from './auth.ts';
import { attachWebSocket } from './ws.ts';
import { manager } from './docs.ts';
import { listProjects, resolveProjectPath, projectDir, createProject, newDocumentText, fileKind, findMaster, isBackupFile, isDocumentFile } from './projects.ts';
import { cachedParseFile, importLyxFile, parseDocumentText, parseFragmentText } from './texdoc.ts';
import { toPdf } from './graphics.ts';
import { toPng, isDirectImage } from './graphics.ts';
import { buildPdf, exportTex, lastBuild, requestBuild, currentJob, cancelBuild, publicJob, cleanupProjectData, synctexView, synctexEdit } from './export.ts';
import { db } from './db.ts';
import { accessibleProjects, adoptProjects, roleFor, atLeast, isRole, registerProject, shareInfo, addMember, setMemberRole, removeMember, memberRow, linkMemberIds, setLink, acceptLink, setOwner, trashProject, ensureWelcomeProject, type Role } from './access.ts';
import { sandboxAvailable } from './sandbox.ts';
import { grantAdminAccess, projectsForAdmin, activityOf, logAccess, pruneAccessLog } from './access.ts';
import { statusOf as mirrorStatus, pushProject as mirrorPush, setMirrorEnabled, archiveMirror, startMirrorSweeper } from './mirror.ts';
import { feedbackRoutes, reportServerError, feedbackEnabled } from './feedback.ts';
import { searchLiterature, bibtexFor, addToCitedBib, sourcesAvailable, type Hit } from './bibsearch.ts';
import { gitRouter, ensureAllRepos, ensureRepo, repoInfo, cloneUrl, commitProject, touchProject, createToken, listTokens, deleteToken, flushCommits } from './git.ts';
import { texHeadings, collectMacros, toMathliveMacros, parseBibtex, getTextClass, getModules, getAuthors, headerValue, paramMap, unquote, walkInsets, walkParagraphs as walkParagraphsAll, plainText, lyxToPm } from '@overlyx/core';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(authMiddleware);
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Only our own scripts run in the app; project files are user content and are served as
  // downloads (see /file/*), so a stray script in a project can never run as us.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  next();
});

app.use('/api/auth', authRouter());
// git over HTTP (Basic auth, see git.ts) — before the API's cookie auth and JSON parsing
app.use('/git', gitRouter());
app.use('/mcp', mcpRouter());

const api = express.Router();
api.use(requireAuth);
api.use(express.json({ limit: '5mb' }));
api.use(feedbackRoutes());

/* ----------------------------------------------------------------- access */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { role?: Role } }
}

function deny(res: express.Response, role: Role | null): void {
  res.status(403).json({ error: role ? 'You can only view this project' : 'You do not have access to this project (ask its owner to share it with you)' });
}

/** Project routes: the user needs at least `min` in `:project`. */
const needProject = (min: Role) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const role = roleFor(req.user!, String(req.params.project ?? ''));
  if (!atLeast(role, min)) { deny(res, role); return; }
  req.role = role!;
  next();
};

/**
 * Document routes (`/docs/<id>/<action>`): reading needs *view*, changing the document *edit*.
 * Building a PDF / exporting only reads the document, so viewers may do it.
 */
api.all('/docs/*', (req, res, next) => {
  const full = String((req.params as any)[0] ?? '');
  const m = /^(.*?)(?:\/(meta|tex|outline|source|bib|reset|save|header|versions(?:\/\d+(?:\/restore)?)?|export(?:\/cancel)?|pdf|build|synctex\/(?:view|edit)))?$/.exec(full)!;
  const id = decodeURIComponent(m[1]);
  const action = m[2] ?? '';
  const write = req.method !== 'GET' && !/^export/.test(action);
  const role = roleFor(req.user!, id.split('/')[0]);
  if (!atLeast(role, write ? 'edit' : 'view')) { deny(res, role); return; }
  req.role = role!;
  next();
});

/* ---------------------------------------------------------------- projects */

api.get('/projects', (req, res) => {
  ensureWelcomeProject(req.user!);
  res.json({ projects: accessibleProjects(req.user!).map(p => ({ name: p.name, title: p.title, kind: p.kind, role: p.role, via: p.via, owner: p.owner, files: p.files })) });
  void ensureAllRepos();   // directories that appeared since (created by hand, the welcome project) get their repository
});

api.post('/projects', (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!/^[A-Za-z0-9._ -]+$/.test(name)) { res.status(400).json({ error: 'invalid project name' }); return; }
    if (fs.existsSync(projectDir(name))) { res.status(409).json({ error: 'a project with this name exists already' }); return; }
    const p = createProject(name);
    registerProject(name, req.user!.id);
    ensureRepo(name).catch(e => console.error('[git] init failed:', e));
    res.json({ project: { name: p.name, title: null, kind: 'project', role: 'owner', via: 'owner', files: p.files } });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Remove a project (owner): the directory is moved to <data>/trash, never deleted. */
api.delete('/projects/:project', needProject('owner'), async (req, res) => {
  try {
    await manager.closeProject(req.params.project);
    const dest = trashProject(req.params.project);
    cleanupProjectData(req.params.project);
    void archiveMirror(req.params.project);
    res.json({ ok: true, trash: dest });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/* ----------------------------------------------------------------- sharing */

api.get('/projects/:project/share', needProject('owner'), (req, res) => {
  res.json(shareInfo(req.params.project));
});
api.post('/projects/:project/share/members', needProject('owner'), (req, res) => {
  try {
    const role = req.body?.role;
    if (!isRole(role)) { res.status(400).json({ error: 'role must be view or edit' }); return; }
    const m = addMember(req.params.project, String(req.body?.who ?? ''), role, req.user!);
    logAccess(req.params.project, req.user!.id, 'share', `added ${memberLabel(m)} as ${role === 'edit' ? 'editor' : 'viewer'}`);
    res.json({ member: m, share: shareInfo(req.params.project) });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
api.post('/projects/:project/share/members/:id', needProject('owner'), (req, res) => {
  const role = req.body?.role;
  if (!isRole(role)) { res.status(400).json({ error: 'role must be view or edit' }); return; }
  const m = memberRow(req.params.project, Number(req.params.id));
  setMemberRole(req.params.project, Number(req.params.id), role);
  logAccess(req.params.project, req.user!.id, 'share', `made ${memberLabel(m)} ${role === 'edit' ? 'an editor' : 'a viewer'}`);
  // their open editors reconnect with the new role
  if (m?.user_id != null) manager.kick(req.params.project, [m.user_id]);
  res.json({ share: shareInfo(req.params.project) });
});
api.delete('/projects/:project/share/members/:id', needProject('owner'), (req, res) => {
  const m = memberRow(req.params.project, Number(req.params.id));
  removeMember(req.params.project, Number(req.params.id));
  logAccess(req.params.project, req.user!.id, 'share', `removed ${memberLabel(m)}`);
  if (m?.user_id != null) manager.kick(req.params.project, [m.user_id]);
  res.json({ share: shareInfo(req.params.project) });
});
/** Link sharing: body { role: 'view' | 'edit' | null } (null turns it off and revokes link members). */
api.post('/projects/:project/share/link', needProject('owner'), (req, res) => {
  try {
    const role = req.body?.role ?? null;
    if (role !== null && !isRole(role)) { res.status(400).json({ error: 'role must be view, edit or null' }); return; }
    const affected = linkMemberIds(req.params.project);
    const link = setLink(req.params.project, role);
    if (affected.length) manager.kick(req.params.project, affected);
    logAccess(req.params.project, req.user!.id, 'share', role ? `turned on link sharing (${role === 'edit' ? 'editors' : 'viewers'})` : 'turned off link sharing');
    res.json({ link, share: shareInfo(req.params.project) });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
api.post('/projects/:project/share/owner', needProject('owner'), (req, res) => {
  try { setOwner(req.params.project, String(req.body?.username ?? '')); logAccess(req.params.project, req.user!.id, 'share', `made ${String(req.body?.username ?? '')} the owner`); res.json({ share: shareInfo(req.params.project) }); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
/** Open a share link: join the project and learn what to open. */
api.post('/share/:token/accept', (req, res) => {
  try {
    const { project, role } = acceptLink(String(req.params.token), req.user!);
    const files = listProjects().find(p => p.name === project.name)?.files ?? [];
    const lyx = files.filter(f => f.kind === 'doc' && !isBackupFile(f.name)).sort((a, b) => Number(!/(^|\/)main\.tex$/.test(a.path)) - Number(!/(^|\/)main\.tex$/.test(b.path)) || a.path.length - b.path.length || a.path.localeCompare(b.path));
    res.json({ project: project.name, title: project.title, role, doc: lyx[0] ? `${project.name}/${lyx[0].path}` : null });
  } catch (e) { res.status(404).json({ error: (e as Error).message }); }
});

/** The owner's activity log: who opened, built, pulled/pushed, shared — and administrator access. */
api.get('/projects/:project/activity', needProject('owner'), (req, res) => {
  res.json({ entries: activityOf(req.params.project, Number(req.query.limit ?? 50) || 50) });
});
function memberLabel(m: ReturnType<typeof memberRow>): string {
  if (!m) return 'a member';
  if (m.user_id != null) { const u = db.prepare('SELECT username FROM users WHERE id = ?').get(m.user_id) as { username: string } | undefined; if (u) return u.username; }
  return m.email ?? 'a member';
}

/* ------------------------------------------------------------ administration */

/** Every project on the instance (administrators): who owns it, whether the administrator can open it now. */
api.get('/admin/projects', (req, res) => {
  if (!req.user?.isAdmin) { res.status(403).json({ error: 'admin only' }); return; }
  res.json({ projects: projectsForAdmin(req.user) });
});
/** Open somebody else's project as administrator for a while (default 60 min) — logged in that project's activity. */
api.post('/admin/projects/:project/access', (req, res) => {
  if (!req.user?.isAdmin) { res.status(403).json({ error: 'admin only' }); return; }
  try { res.json({ until: grantAdminAccess(req.user, req.params.project, Number(req.body?.minutes ?? 60)) }); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

/** Switch a per-account setting for a user (Settings ▸ Account; currently: allowRecopyTokens). */
api.post('/admin/users/:id/settings', (req, res) => {
  if (!req.user?.isAdmin) { res.status(403).json({ error: 'admin only' }); return; }
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) { res.status(404).json({ error: 'no such user' }); return; }
  if (typeof req.body?.allowRecopyTokens !== 'boolean') { res.status(400).json({ error: 'allowRecopyTokens must be a boolean' }); return; }
  res.json({ settings: setUserSettings(id, { allowRecopyTokens: req.body.allowRecopyTokens }) });
});

/* ------------------------------------------------------------------ mirror */

/** The project's off-site mirror (GitHub organisation): where, when it was pushed last, whether it is behind. */
api.get('/projects/:project/mirror', needProject('view'), async (req, res) => {
  try { res.json(await mirrorStatus(req.params.project)); } catch (e) { res.status(400).json({ error: String(e) }); }
});
/** Owner: pause/resume the mirror ({ enabled }) or push right now ({ now: true }). */
api.post('/projects/:project/mirror', needProject('owner'), async (req, res) => {
  try {
    if (typeof req.body?.enabled === 'boolean') setMirrorEnabled(req.params.project, req.body.enabled);
    if (req.body?.now) await mirrorPush(req.params.project, { force: true });
    res.json(await mirrorStatus(req.params.project));
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/* --------------------------------------------------------------------- git */

/** The project's repository: clone URL, recent commits, what is not committed yet. */
api.get('/projects/:project/git', needProject('view'), async (req, res) => {
  try {
    const info = await repoInfo(req.params.project);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string | null } | undefined;
    res.json({ ...info, url: cloneUrl(req, req.params.project), username: req.user!.username, role: req.role, hasPassword: !!row?.password_hash });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});
/** Commit what changed, now (editors). */
api.post('/projects/:project/git/commit', needProject('edit'), async (req, res) => {
  try {
    const committed = await commitProject(req.params.project, { message: typeof req.body?.message === 'string' && req.body.message.trim() ? req.body.message.trim().slice(0, 500) : undefined, by: req.user!.id });
    res.json({ committed, ...(await repoInfo(req.params.project)) });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});
/** Personal access tokens (the password for git over HTTPS; Google accounts have no other). */
api.get('/git/tokens', (req, res) => { res.json({ tokens: listTokens(req.user!.id, userSettings(req.user!.id).allowRecopyTokens) }); });
api.post('/git/tokens', (req, res) => {
  const name = String(req.body?.name ?? '').trim() || 'token';
  const allow = userSettings(req.user!.id).allowRecopyTokens;
  const t = createToken(req.user!.id, name, allow);
  res.json({ id: t.id, token: t.token, tokens: listTokens(req.user!.id, allow) });
});
api.delete('/git/tokens/:id', (req, res) => {
  deleteToken(req.user!.id, Number(req.params.id));
  res.json({ tokens: listTokens(req.user!.id, userSettings(req.user!.id).allowRecopyTokens) });
});

/** The signed-in account's server-side settings (userSettings.ts) — the Settings panel. */
api.get('/settings', (req, res) => { res.json({ settings: userSettings(req.user!.id) }); });

/** MCP agent tokens: one per external agent, scoped to the signed-in account — usable on any project the account can access (see mcp.ts). */
api.get('/mcp-tokens', (req, res) => { res.json({ tokens: listMcpTokens(req.user!.id, userSettings(req.user!.id).allowRecopyTokens) }); });
api.post('/mcp-tokens', (req, res) => {
  const name = String(req.body?.name ?? '').trim() || 'agent';
  const allow = userSettings(req.user!.id).allowRecopyTokens;
  const t = createMcpToken(req.user!.id, name, allow);
  res.json({ id: t.id, token: t.token, tokens: listMcpTokens(req.user!.id, allow) });
});
api.delete('/mcp-tokens/:id', (req, res) => {
  deleteMcpToken(req.user!.id, Number(req.params.id));
  res.json({ tokens: listMcpTokens(req.user!.id, userSettings(req.user!.id).allowRecopyTokens) });
});

api.post('/projects/:project/new', needProject('edit'), (req, res) => {
  try {
    let rel = String(req.body?.path ?? 'untitled.tex');
    if (rel.endsWith('.lyx')) rel = rel.slice(0, -4) + '.tex';
    if (!rel.endsWith('.tex')) rel += '.tex';
    const abs = resolveProjectPath(req.params.project, rel);
    if (fs.existsSync(abs)) { res.status(409).json({ error: 'file exists' }); return; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, newDocumentText({ textclass: req.body?.textclass, title: req.body?.title, author: req.user?.name }), 'utf8');
    touchProject(req.params.project, req.user!.id);
    res.json({ id: `${req.params.project}/${rel}` });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Upload a file (raw body) into a project, e.g. figures/plot.png */
api.post('/projects/:project/upload', needProject('edit'), express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
  try {
    const rel = String(req.query.path ?? '');
    if (!rel || rel.includes('..')) { res.status(400).json({ error: 'bad path' }); return; }
    const abs = resolveProjectPath(req.params.project, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, req.body as Buffer);
    touchProject(req.params.project, req.user!.id);
    res.json({ ok: true, path: rel, kind: fileKind(rel) });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** File operations behind the explorer's context menu (VS Code-like). Deleted files go to the data
 * directory's trash, never into the void — project files are the user's documents. */
api.post('/projects/:project/fileops', needProject('edit'), (req, res) => {
  try {
    const project = req.params.project;
    const op = String(req.body?.op ?? '');
    const guard = (rel: string) => {
      if (!rel || rel.split('/').some(part => part === '.git' || part === '..' || part === '' || part === '.')) throw new Error('bad path');
      return resolveProjectPath(project, rel);
    };
    const moveOut = (abs: string, rel: string) => {   // to the trash; a rename across file systems falls back to copy + delete
      const trash = path.join(config.dataDir, 'trash', 'files', `${project}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      const dest = path.join(trash, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { fs.renameSync(abs, dest); }
      catch { fs.cpSync(abs, dest, { recursive: true }); fs.rmSync(abs, { recursive: true, force: true }); }
    };
    if (op === 'mkdir') {
      fs.mkdirSync(guard(String(req.body?.to ?? '')), { recursive: true });
    } else if (op === 'delete') {
      const rel = String(req.body?.from ?? '');
      const abs = guard(rel);
      if (!fs.existsSync(abs)) throw new Error('not found');
      moveOut(abs, rel);
    } else if (op === 'rename' || op === 'copy') {
      const from = guard(String(req.body?.from ?? ''));
      const to = guard(String(req.body?.to ?? ''));
      if (!fs.existsSync(from)) throw new Error('not found');
      if (fs.existsSync(to)) { res.status(409).json({ error: 'a file with that name exists' }); return; }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (op === 'rename') fs.renameSync(from, to);
      else fs.cpSync(from, to, { recursive: true });
    } else throw new Error('unknown operation');
    touchProject(req.params.project, req.user!.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: (e as Error).message ?? String(e) }); }
});

/** File types a browser may render in place; everything else (html, svg, …) is offered as a download — a project's files are user content and must not run as a page of our origin. */
const INLINE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt']);

/** Serve a project file (bib, pdf, images, ...). */
api.get('/projects/:project/file/*', needProject('view'), (req, res) => {
  try {
    const rel = decodeURIComponent((req.params as any)[0]);
    const abs = resolveProjectPath(req.params.project, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.status(404).end(); return; }
    if (!INLINE_EXT.has(path.extname(abs).toLowerCase()) || req.query.download === '1') res.attachment(path.basename(abs));
    res.sendFile(abs);
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/* ------------------------------------------------------------ text files */

const TEXT_MAX = 4 * 1024 * 1024;

/** A text file of the project (.tex, .bib, .sty, …) for the built-in text editor. */
api.get('/projects/:project/text/*', needProject('view'), (req, res) => {
  try {
    const rel = decodeURIComponent((req.params as any)[0]);
    if (rel.endsWith('.lyx') || isDocumentFile(req.params.project, rel)) { res.status(400).json({ error: 'Documents are opened as documents, not as text' }); return; }
    const abs = resolveProjectPath(req.params.project, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.status(404).json({ error: 'not found' }); return; }
    const st = fs.statSync(abs);
    if (st.size > TEXT_MAX) { res.status(413).json({ error: 'file too large for the text editor (4 MB)' }); return; }
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) { res.status(415).json({ error: 'not a text file' }); return; }
    res.json({ text: buf.toString('utf8'), mtime: st.mtimeMs, size: st.size, role: req.role ?? 'edit' });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/**
 * Save a text file. `mtime` is the modification time the client loaded; if the file changed since
 * (someone else, desktop LyX, git), the save is refused with 409 and the current content.
 */
api.get('/bib/sources', (_req, res) => { res.json({ enabled: config.literature, sources: config.literature ? sourcesAvailable() : [] }); });
/** Literature search for the citation dialog (open indexes; see bibsearch.ts). */
api.get('/bib/search', async (req, res) => {
  if (!config.literature) { res.status(503).json({ error: 'Literature search is switched off on this server (OVERLYX_LITERATURE=off).' }); return; }
  const q = String(req.query.q ?? '').trim().slice(0, 300);
  if (!q) { res.json({ hits: [] }); return; }
  try { const r = await searchLiterature(q, Math.min(25, Number(req.query.limit) || 10)); res.json({ hits: r.hits, warnings: r.warnings, sources: sourcesAvailable() }); }
  catch (e) { res.status(502).json({ error: (e as Error).message }); }
});
/** Add a paper to the project's cited.bib: either a search hit (BibTeX fetched here) or pasted BibTeX. */
api.post('/projects/:project/bib/add', needProject('edit'), async (req, res) => {
  try {
    const project = req.params.project;
    const dir = projectDir(project);
    let bibtex = typeof req.body?.bibtex === 'string' ? req.body.bibtex : '';
    if (!bibtex && req.body?.hit) {
      if (!config.literature) { res.status(503).json({ error: 'Literature search is switched off on this server.' }); return; }
      bibtex = await bibtexFor(req.body.hit as Hit);
    }
    if (!bibtex.trim()) { res.status(400).json({ error: 'No BibTeX entry given' }); return; }
    if (bibtex.length > 20000) { res.status(413).json({ error: 'BibTeX entry too long' }); return; }
    const r = addToCitedBib(dir, bibtex, { commit: () => touchProject(project, req.user!.id) });
    res.json(r);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

api.put('/projects/:project/text/*', needProject('edit'), (req, res) => {
  try {
    const rel = decodeURIComponent((req.params as any)[0]);
    if (rel.endsWith('.lyx') || isDocumentFile(req.params.project, rel)) { res.status(400).json({ error: 'Documents are opened as documents, not as text' }); return; }
    const abs = resolveProjectPath(req.params.project, rel);
    const text = req.body?.text;
    if (typeof text !== 'string') { res.status(400).json({ error: 'text missing' }); return; }
    if (Buffer.byteLength(text) > TEXT_MAX) { res.status(413).json({ error: 'file too large (4 MB)' }); return; }
    const expected = typeof req.body?.mtime === 'number' ? req.body.mtime : undefined;
    if (expected !== undefined && fs.existsSync(abs)) {
      const cur = fs.statSync(abs);
      if (Math.abs(cur.mtimeMs - expected) > 1) {
        res.status(409).json({ error: 'The file was changed on the server since you loaded it', text: fs.readFileSync(abs, 'utf8'), mtime: cur.mtimeMs });
        return;
      }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.overlyx-tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, abs);
    const st = fs.statSync(abs);
    touchProject(req.params.project, req.user!.id);
    res.json({ ok: true, mtime: st.mtimeMs, size: st.size });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Graphics rendered to PNG for the editor (svg/pdf/eps/... converted; png/jpg passed through). */
api.get('/projects/:project/graphics/*', needProject('view'), async (req, res) => {
  try {
    const rel = decodeURIComponent((req.params as any)[0]);
    const abs = resolveProjectPath(req.params.project, rel);
    if (!fs.existsSync(abs)) { res.status(404).json({ error: 'not found' }); return; }
    const width = Math.min(4000, Math.max(100, Number(req.query.w ?? 1200)));
    const download = req.query.download === '1';
    if (isDirectImage(abs) && !download) { res.sendFile(abs); return; }
    const png = await toPng(abs, width);
    if (download) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(abs, path.extname(abs))}.png"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(png);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

/* -------------------------------------------------------------------- docs */

function docId(req: express.Request): string {
  return decodeURIComponent((req.params as any)[0] ?? req.params.id);
}

/**
 * Parsed BibTeX files, cached in memory and on disk (data/cache/bib-*.json) by path + mtime + size:
 * bibliographies are often several MB and parsing one takes over a second, which used to make the
 * first open of a document after a server restart slow.
 */
const bibCache = new Map<string, { key: string; entries: ReturnType<typeof parseBibtex> }>();
function cachedBib(abs: string): ReturnType<typeof parseBibtex> {
  try {
    const st = fs.statSync(abs);
    const key = `${st.mtimeMs}:${st.size}:v2`;   // v2: entries carry the (short) author list
    const hit = bibCache.get(abs);
    if (hit && hit.key === key) return hit.entries;
    const diskFile = path.join(config.dataDir, 'cache', 'bib-' + crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16) + '.json');
    let entries: ReturnType<typeof parseBibtex> | null = null;
    try {
      const cached = JSON.parse(fs.readFileSync(diskFile, 'utf8')) as { key: string; entries: ReturnType<typeof parseBibtex> };
      if (cached.key === key && Array.isArray(cached.entries)) entries = cached.entries;
    } catch { /* no disk cache */ }
    if (!entries) {
      // `author`: the "A and B" / "A et al." form shown in the editor and the citation dialog
      entries = parseBibtex(fs.readFileSync(abs, 'utf8')).map(e => ({ ...e, key: String(e.key ?? ''), author: String(e.authorShort || e.fields?.author || ''), year: String(e.year ?? ''), title: String(e.title ?? '') }));
      try { fs.writeFileSync(diskFile, JSON.stringify({ key, entries })); } catch { /* cache dir not writable: ignore */ }
    }
    bibCache.set(abs, { key, entries });
    return entries;
  } catch { return []; }
}


/** bib files used by a document (filled by the meta route) for the /bib search endpoint */
const bibIndex = new Map<string, { files: string[]; fallbackProject: string | null }>();

/** Search the bibliography of a document: ?q=words (matches key/author/year/title) or ?keys=a,b */
api.get('/docs/*/bib', async (req, res) => {
  try {
    const id = docId(req);
    if (!bibIndex.has(id)) { await manager.open(id); }
    let idx = bibIndex.get(id);
    if (!idx) {
      // metadata not requested yet in this process: use all .bib files of the project
      const doc = await manager.open(id);
      idx = { files: [], fallbackProject: doc.project };
    }
    let entries: ReturnType<typeof parseBibtex> = [];
    for (const f of idx.files) entries.push(...cachedBib(f));
    if (!entries.length && idx.fallbackProject) {
      const proj = projectDir(idx.fallbackProject);
      for (const f of listProjects().find(p => p.name === idx!.fallbackProject)?.files ?? []) if (f.kind === 'bib' && !isBackupFile(f.name)) entries.push(...cachedBib(path.join(proj, f.path)));
    }
    const seen = new Set<string>();
    entries = entries.filter(e => (seen.has(e.key) ? false : (seen.add(e.key), true)));
    const keys = String(req.query.keys ?? '').split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length) { res.json({ entries: entries.filter(e => keys.includes(e.key)), total: entries.length }); return; }
    const terms = String(req.query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.min(500, Number(req.query.limit ?? 100) || 100);
    const hits = terms.length
      ? entries.filter(e => terms.every(t => e.key.toLowerCase().includes(t) || (e.fields?.author ?? '').toLowerCase().includes(t) || e.authorShort.toLowerCase().includes(t) || e.year.includes(t) || e.title.toLowerCase().includes(t)))
      : entries;
    res.json({ entries: hits.slice(0, limit), total: entries.length, matches: hits.length });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Document metadata for the editor: class, layouts, macros, bib entries, labels, authors. */
api.get('/docs/*/meta', async (req, res) => {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  let tPrev = t0;
  const lap = (name: string) => { const t = performance.now(); timings[name] = Math.round(t - tPrev); tPrev = t; };
  try {
    const id = docId(req);
    const doc = await manager.open(id);
    lap('open');
    const lyx = doc.toLyxDocument();
    lap('toLyx');
    const proj = projectDir(doc.project);
    // child documents inherit macros, bibliography and labels from their master
    const masterRel = findMaster(doc.project, doc.relPath);
    lap('findMaster');
    const masterId = masterRel ? `${doc.project}/${masterRel}` : null;
    const readDoc = (rel: string) => {
      const open = manager.docs.get(`${doc.project}/${rel}`);
      if (open) return open.toLyxDocument();
      return cachedParseFile(doc.project, rel).doc;
    };
    const rootRel = masterRel ?? doc.relPath;
    const rootLyx = masterRel ? readDoc(masterRel) : lyx;
    const docDir = path.dirname(path.join(proj, rootRel));
    const safe = (fn: string) => { const abs = path.resolve(docDir, fn); return abs.startsWith(proj) ? abs : null; };
    const texName = (fn: string) => (fn.endsWith('.tex') || fn.includes('.') ? fn : fn + '.tex');
    const includeDoc = (fn: string) => { const abs = safe(texName(fn)); if (!abs || !abs.endsWith('.tex') || !fs.existsSync(abs)) return undefined; try { return readDoc(path.relative(proj, abs)); } catch { return undefined; } };
    const macros = collectMacros(rootLyx, {
      include: includeDoc,
      readFile: (fn) => { const abs = safe(fn); try { return abs ? fs.readFileSync(abs, 'utf8') : undefined; } catch { return undefined; } },
    });
    if (masterRel) {
      // the child's own macros come last (they override for the child's view)
      macros.push(...collectMacros(lyx, { include: includeDoc, readFile: (fn) => { const abs = safe(fn); try { return abs ? fs.readFileSync(abs, 'utf8') : undefined; } catch { return undefined; } } }));
    }
    lap('macros');
    // labels across the master tree (for the cross-reference dialog)
    const labels: { name: string; context: string; file: string }[] = [];
    const seenLabelFiles = new Set<string>();
    const collectLabels = (d: typeof lyx, rel: string, depth: number) => {
      if (depth > 4 || seenLabelFiles.has(rel)) return;
      seenLabelFiles.add(rel);
      const dir = path.dirname(path.join(proj, rel));
      for (const par of walkParagraphsAll(d.body)) {
        for (const it of par.items) {
          if (it.kind !== 'inset') continue;
          const ins = it.inset;
          if (ins.type === 'Leaf' && ins.name === 'CommandInset' && ins.arg === 'label') {
            labels.push({ name: unquote(paramMap(ins.params).get('name')), context: plainText([par]).slice(0, 80), file: rel });
          } else if (ins.type === 'Formula' && !ins.inline) {
            for (const m of ins.latex.matchAll(/\\label\{([^}]*)\}/g)) labels.push({ name: m[1], context: '(equation)', file: rel });
          } else if (ins.type === 'Leaf' && ins.name === 'CommandInset' && ins.arg === 'include') {
            const fn = texName(unquote(paramMap(ins.params).get('filename')));
            if (fn.endsWith('.tex')) {
              const abs = path.resolve(dir, fn);
              if (abs.startsWith(proj) && fs.existsSync(abs)) { try { collectLabels(readDoc(path.relative(proj, abs)), path.relative(proj, abs), depth + 1); } catch { /* ignore */ } }
            }
          }
        }
      }
    };
    collectLabels(rootLyx, rootRel, 0);
    lap('labels');
    // bibliography files referenced by bibtex insets (in this doc and children), and the keys cited
    const bibFiles = new Set<string>();
    const citedKeys = new Set<string>();
    const scanned = new Set<string>([rootRel, doc.relPath]);
    const scan = (d: typeof lyx, depth: number) => {
      if (depth > 4) return;
      for (const { inset } of walkInsets(d.body)) {
        if (inset.type !== 'Leaf' || inset.name !== 'CommandInset') continue;
        const pm = paramMap(inset.params);
        if (inset.arg === 'bibtex') {
          for (const f of unquote(pm.get('bibfiles')).split(',')) if (f.trim()) bibFiles.add(f.trim());
        } else if (inset.arg === 'citation') {
          for (const k of unquote(pm.get('key')).split(',')) if (k.trim()) citedKeys.add(k.trim());
        } else if (inset.arg === 'include') {
          const fn = texName(unquote(pm.get('filename')));
          const abs = safe(fn);
          if (abs && fn.endsWith('.tex') && fs.existsSync(abs)) {
            const rel = path.relative(proj, abs);
            if (scanned.has(rel)) continue;     // child documents may include each other (appendix ↔ macros file)
            scanned.add(rel);
            try { scan(readDoc(rel), depth + 1); } catch { /* ignore */ }
          }
        }
      }
    };
    scan(rootLyx, 0);
    if (masterRel) scan(lyx, 0);
    lap('bibscan');
    const bib: ReturnType<typeof parseBibtex> = [];
    for (const f of bibFiles) {
      const abs = safe(f.endsWith('.bib') ? f : f + '.bib');
      if (abs && fs.existsSync(abs)) bib.push(...cachedBib(abs));
    }
    // also offer all .bib files of the project when none is referenced
    if (!bib.length) {
      for (const f of listProjects().find(p => p.name === doc.project)?.files ?? []) {
        if (f.kind === 'bib' && !isBackupFile(f.name)) bib.push(...cachedBib(path.join(proj, f.path)));
      }
    }
    lap('bib');
    let layouts: unknown = null;
    let flexInsets: unknown = null;
    try {
      const mod = await import('@overlyx/core/latex/index.ts') as any;
      const dc = mod.loadDocumentClass(getTextClass(lyx), getModules(lyx), config.layoutDir, [proj, docDir]);
      layouts = mod.describeLayouts(dc);
      flexInsets = dc.insetLayouts ? mod.flexInsetNames(dc) : null;
    } catch (e) {
      layouts = null;
    }
    lap('layouts');
    if (req.query.debug) console.log('meta', id, timings, 'total', Math.round(performance.now() - t0), 'ms');
    // de-duplicate bibliography entries by key; large bibliographies are searched through /bib instead of shipped whole
    const seenKeys = new Set<string>();
    const bibAll = bib.filter(e => (seenKeys.has(e.key) ? false : (seenKeys.add(e.key), true)));
    const bibUnique = bibAll.length > 400 ? bibAll.filter(e => citedKeys.has(e.key)) : bibAll;
    bibIndex.set(id, { files: [...bibFiles].map(f => safe(f.endsWith('.bib') ? f : f + '.bib')).filter((x): x is string => !!x), fallbackProject: bibFiles.size ? null : doc.project });
    res.json({
      id, project: doc.project, path: doc.relPath, master: masterId,
      role: req.role ?? 'edit',
      labels,
      textclass: getTextClass(lyx), modules: getModules(lyx),
      language: headerValue(lyx.header, 'language') ?? 'english',
      useRefstyle: headerValue(lyx.header, 'use_refstyle') === '1',
      citeEngine: headerValue(lyx.header, 'cite_engine') ?? 'basic',
      citeEngineType: headerValue(lyx.header, 'cite_engine_type') ?? 'default',
      trackingChanges: headerValue(lyx.header, 'tracking_changes') === 'true',
      bibTotal: bibAll.length,
      secnumdepth: Number(headerValue(lyx.header, 'secnumdepth') ?? 3),
      tocdepth: Number(headerValue(lyx.header, 'tocdepth') ?? 3),
      authors: getAuthors(lyx.header),
      macros: toMathliveMacros(macros),
      macroList: macros.map(m => ({ name: m.name, args: m.args, def: m.def, display: m.display, source: m.source })),
      bib: bibUnique.slice(0, 30000).map(e => ({ key: e.key, author: e.authorShort, year: e.year, title: e.title })),
      layouts, flexInsets,
      files: listProjects().find(p => p.name === doc.project)?.files ?? [],
      health: doc.health(),
    });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Mend mechanically-fixable structural damage (managed-block markers) left by an external edit. */
api.post('/docs/*/repair', async (req, res) => {
  try {
    if (!atLeast(req.role, 'edit')) { res.status(403).json({ error: 'view-only' }); return; }
    const doc = await manager.open(docId(req));
    res.json(doc.repair());
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Parse a LaTeX fragment against this document's own preamble (pasting LaTeX text into the
 *  editor): the ProseMirror blocks to insert. Nothing is written — the client inserts them. */
api.post('/docs/*/clip', async (req, res) => {
  try {
    if (!atLeast(req.role, 'edit')) { res.status(403).json({ error: 'view-only' }); return; }
    const latex = String(req.body?.latex ?? '');
    if (!latex.trim() || latex.length > 256 * 1024) { res.status(400).json({ error: 'no LaTeX' }); return; }
    const doc = await manager.open(docId(req));
    const r = parseFragmentText(latex, doc.project, doc.relPath, doc.getMeta().headerLines);
    res.json({ blocks: (lyxToPm(r.doc) as { content?: unknown[] }).content ?? [], warnings: r.warnings });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Ask the configured OpenRouter model to propose a fix for structural damage the mechanical
 *  repair can't handle. Never applied automatically — see POST .../ai-repair/apply. */
api.post('/docs/*/ai-repair', async (req, res) => {
  try {
    if (!atLeast(req.role, 'edit')) { res.status(403).json({ error: 'view-only' }); return; }
    if (!config.openrouter.apiKey) { res.status(503).json({ error: 'AI repair is not configured on this server (OPENROUTER_API_KEY is unset).' }); return; }
    const doc = await manager.open(docId(req));
    const original = doc.fileText ?? doc.toText();
    const issues = doc.health();
    const proposed = await requestAiRepair(original, issues);
    res.json({ original, proposed, issues });
  } catch (e) { res.status(e instanceof AiRepairError ? 502 : 400).json({ error: (e as Error).message ?? String(e) }); }
});

/** Apply an AI-proposed fix once the user has approved it in the merge editor. */
api.post('/docs/*/ai-repair/apply', async (req, res) => {
  try {
    if (!atLeast(req.role, 'edit')) { res.status(403).json({ error: 'view-only' }); return; }
    const { original, proposed } = req.body ?? {};
    if (typeof original !== 'string' || typeof proposed !== 'string') { res.status(400).json({ error: 'original/proposed missing' }); return; }
    const doc = await manager.open(docId(req));
    const r = doc.applyAiRepair(proposed, original);
    if (!r.ok) { res.status(409).json({ error: r.error }); return; }
    res.json({ ok: true, remaining: r.remaining });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/* ---------------------------------------------------------- AI assistance (ai.ts) */

/** Whether ⌘K rewriting / autocomplete can work on this server (a key is configured) and with which models. */
api.get('/ai/status', (_req, res) => { res.json(aiStatus()); });

/** ⌘K: rewrite the selected passage (or a formula) according to an instruction; the client previews the proposal. */
api.post('/docs/*/ai/rewrite', async (req, res) => {
  try {
    if (!atLeast(req.role, 'edit')) { res.status(403).json({ error: 'view-only' }); return; }
    if (!aiAvailable()) { res.status(503).json({ error: 'AI assistance is not configured on this server (OPENROUTER_API_KEY is unset).' }); return; }
    if (!aiAllow(`rewrite:${req.user!.id}`, config.ai.rewritesPerMinute)) { res.status(429).json({ error: 'Too many AI requests — wait a moment.' }); return; }
    const body = req.body ?? {};
    if (typeof body.instruction !== 'string') { res.status(400).json({ error: 'instruction missing' }); return; }
    const doc = await manager.open(docId(req));
    const ac = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const r = await aiRewrite(doc, { instruction: body.instruction, content: Array.isArray(body.content) ? body.content : [], layout: typeof body.layout === 'string' ? body.layout : undefined, before: typeof body.before === 'string' ? body.before : undefined, after: typeof body.after === 'string' ? body.after : undefined, model: body.model, math: body.math && typeof body.math.latex === 'string' ? body.math : undefined }, ac.signal);
    res.json(r);
  } catch (e) {
    if (e instanceof AiError) { if (e.status !== 499) res.status(e.status).json({ error: e.message }); return; }
    res.status(400).json({ error: (e as Error).message ?? String(e) });
  }
});

/** Autocomplete: a short continuation at the cursor (text: parsed nodes for the ghost; math: LaTeX). */
api.post('/docs/*/ai/complete', async (req, res) => {
  try {
    if (!atLeast(req.role, 'edit')) { res.status(403).json({ error: 'view-only' }); return; }
    if (!aiAvailable()) { res.status(503).json({ error: 'AI assistance is not configured on this server.' }); return; }
    if (!aiAllow(`complete:${req.user!.id}`, config.ai.completionsPerMinute)) { res.status(429).json({ error: 'Too many completion requests — wait a moment.' }); return; }
    const body = req.body ?? {};
    const kind = body.kind === 'math' ? 'math' : 'text';
    const doc = await manager.open(docId(req));
    const ac = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const r = await aiComplete(doc, { kind, before: String(body.before ?? ''), after: String(body.after ?? ''), formula: typeof body.formula === 'string' ? body.formula : undefined, paragraph: typeof body.paragraph === 'string' ? body.paragraph : undefined, model: body.model }, ac.signal);
    res.json(r);
  } catch (e) {
    if (e instanceof AiError) { if (e.status !== 499) res.status(e.status).json({ error: e.message }); return; }
    res.status(400).json({ error: (e as Error).message ?? String(e) });
  }
});

/** The document's LaTeX source (what the file on disk contains once saved). */
api.get('/docs/*/tex', async (req, res) => {
  try {
    const doc = await manager.open(docId(req));
    res.setHeader('Content-Type', 'application/x-tex; charset=utf-8');
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${path.basename(doc.relPath)}"`);
    res.send(doc.toText());
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** The headings of a document from its file on disk (no parse, no loading): the document panel's outline of documents that are not open. */
api.get('/docs/*/outline', (req, res) => {
  try {
    const id = docId(req);
    const project = id.split('/')[0], rel = id.slice(project.length + 1);
    const abs = resolveProjectPath(project, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.status(404).json({ error: 'not found' }); return; }
    const st = fs.statSync(abs);
    const text = fs.readFileSync(abs, 'utf8');
    const depth = /\\setcounter\{secnumdepth\}\{(-?\d+)\}/.exec(text);
    res.json({ headings: texHeadings(text, depth ? Number(depth[1]) : 3), mtime: st.mtimeMs });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Replace the document by LaTeX source edited by hand (applied as a diff: untouched paragraphs keep their identity). */
api.post('/docs/*/source', async (req, res) => {
  try {
    const text = req.body?.text;
    if (typeof text !== 'string') { res.status(400).json({ error: 'text missing' }); return; }
    if (text.length > 20_000_000) { res.status(413).json({ error: 'too large' }); return; }
    const doc = await manager.open(docId(req));
    const r = parseDocumentText(text, doc.project, doc.relPath);
    doc.loadFromLyx(r.doc, 'source');
    doc.scheduleSave();
    res.json({ ok: true, warnings: r.warnings });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Import a .lyx file of the project (and the children it includes) into .tex documents next to it. */
api.post('/projects/:project/import', needProject('edit'), async (req, res) => {
  try {
    const rel = String(req.body?.path ?? '');
    if (!rel.endsWith('.lyx') || rel.includes('..')) { res.status(400).json({ error: 'a .lyx file of the project is expected' }); return; }
    const abs = resolveProjectPath(req.params.project, rel);
    if (!fs.existsSync(abs)) { res.status(404).json({ error: 'not found' }); return; }
    const r = await importLyxFile(req.params.project, rel, toPdf);
    touchProject(req.params.project, req.user!.id);
    res.json(r);
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Admin: start a fresh collaboration history for a document (see DocManager.reset). */
api.post('/docs/*/reset', async (req, res) => {
  if (!req.user?.isAdmin) { res.status(403).json({ error: 'admin only' }); return; }
  try { await manager.reset(docId(req)); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: String(e) }); }
});

api.post('/docs/*/save', async (req, res) => {
  try {
    const doc = await manager.open(docId(req));
    const ok = await doc.saveToFile();
    res.json({ ok });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** The document settings (header lines) — for clients that need the master's settings. */
api.get('/docs/*/header', async (req, res) => {
  try { const doc = await manager.open(docId(req)); res.json({ headerLines: doc.getMeta().headerLines }); }
  catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Update header (document settings): full header lines list, or preamble text. */
/** Header updates are read-modify-write on one value: run them one at a time per document. */
const headerQueue = new Map<string, Promise<unknown>>();
api.post('/docs/*/header', async (req, res) => {
  const id = docId(req);
  const prev = headerQueue.get(id) ?? Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
  try {
    const doc = await manager.open(id);
    const meta = doc.getMeta();
    let lines: string[] = meta.headerLines;
    if (Array.isArray(req.body?.headerLines)) lines = req.body.headerLines.map(String);
    if (typeof req.body?.preamble === 'string') {
      const start = lines.indexOf('\\begin_preamble');
      const content = req.body.preamble.replace(/\r\n/g, '\n').split('\n');
      if (start >= 0) { const end = lines.indexOf('\\end_preamble', start); lines.splice(start + 1, end - start - 1, ...content); }
      else { const idx = lines.findIndex(l => l.startsWith('\\textclass')); lines.splice(idx + 1, 0, '\\begin_preamble', ...content, '\\end_preamble'); }
    }
    if (req.body?.set && typeof req.body.set === 'object') {
      for (const [k, v] of Object.entries(req.body.set as Record<string, string>)) {
        const i = lines.findIndex(l => l === '\\' + k || l.startsWith('\\' + k + ' '));
        if (i >= 0) lines[i] = `\\${k} ${v}`; else lines.push(`\\${k} ${v}`);
      }
    }
    doc.ydoc.transact(() => { doc.meta.set('header', JSON.stringify(lines)); }, 'header');
    res.json({ ok: true, headerLines: lines });
  } catch (e) { res.status(400).json({ error: String(e) }); }
  });
  headerQueue.set(id, job);
  await job;
  if (headerQueue.get(id) === job) headerQueue.delete(id);
});

/* ---------------------------------------------------------------- versions */

api.get('/docs/*/versions', (req, res) => {
  res.json({ versions: manager.listVersions(docId(req)) });
});
api.post('/docs/*/versions', async (req, res) => {
  try {
    // `lyx` = explicit content (a client's offline edits that could not be merged), else the current state
    const lyx = typeof req.body?.lyx === 'string' && req.body.lyx.length < 20_000_000 ? req.body.lyx : undefined;
    const id = await manager.createVersion(docId(req), String(req.body?.name ?? 'version'), req.user!.name, lyx ? 'offline' : 'manual', lyx);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});
api.get('/docs/*/versions/:vid', (req, res) => {
  const v = manager.getVersion(docId(req), Number(req.params.vid));
  if (!v) { res.status(404).json({ error: 'not found' }); return; }
  res.json(v);
});
api.post('/docs/*/versions/:vid/restore', async (req, res) => {
  try { await manager.restoreVersion(docId(req), Number(req.params.vid), req.user!.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: String(e) }); }
});
api.delete('/docs/*/versions/:vid', (req, res) => {
  db.prepare('DELETE FROM versions WHERE id = ? AND doc_id = ?').run(Number(req.params.vid), docId(req));
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ export */

api.post('/docs/*/export', async (req, res) => {
  try {
    const id = docId(req);
    const format = String(req.body?.format ?? 'pdf');
    const engine = 'overlyx';
    if (format === 'tex') {
      const r = await exportTex(id);
      res.json({ ok: true, tex: r.tex, warnings: r.warnings });
      return;
    }
    logAccess(id.split('/')[0], req.user!.id, 'build', id.slice(id.indexOf('/') + 1));
    if (req.body?.wait) {
      // synchronous variant (scripts): wait for the build to finish
      const r = await buildPdf(id, { engine, requestedBy: req.user!.name });
      res.json({ ok: r.ok, log: r.log, warnings: r.warnings, pdf: r.pdfPath ? `/api/docs/${encodeURIComponent(id)}/pdf?t=${Date.now()}` : null, tex: r.tex });
      return;
    }
    // background job: returns at once, poll GET /build for progress and the result
    const job = requestBuild(id, engine, req.user!.name);
    res.json({ ok: true, job: publicJob(job) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

api.post('/docs/*/export/cancel', (req, res) => {
  res.json({ ok: cancelBuild(docId(req)) });
});

api.get('/docs/*/pdf', (req, res) => {
  const b = lastBuild(docId(req));
  if (!b?.pdf_path || !fs.existsSync(b.pdf_path)) { res.status(404).json({ error: 'no pdf built yet' }); return; }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${path.basename(b.pdf_path)}"`);
  res.sendFile(b.pdf_path);
});

/** SyncTeX forward search: the PDF boxes of a line (1-based) of the .tex as built (`?line=`). */
api.get('/docs/*/synctex/view', async (req, res) => {
  const line = Number(req.query.line), column = Number(req.query.column ?? 0);
  if (!Number.isFinite(line) || line < 1) { res.status(400).json({ error: 'line required' }); return; }
  try { res.json({ boxes: await synctexView(docId(req), Math.floor(line), Number.isFinite(column) ? column : 0) }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
/** SyncTeX inverse search: the source line under a point of the PDF (`?page=&x=&y=`, points from the page's top-left). */
api.get('/docs/*/synctex/edit', async (req, res) => {
  const page = Number(req.query.page), x = Number(req.query.x), y = Number(req.query.y);
  if (!(page >= 1) || !Number.isFinite(x) || !Number.isFinite(y)) { res.status(400).json({ error: 'page, x, y required' }); return; }
  try { res.json(await synctexEdit(docId(req), Math.floor(page), x, y) ?? { line: null }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

/** Last build result + the current job (running / queued / just finished), for the PDF panel. */
api.get('/docs/*/build', (req, res) => {
  const id = docId(req);
  const b = lastBuild(id);
  const job = currentJob(id);
  const tex = req.query.tex === '1' && b?.tex_path && fs.existsSync(b.tex_path) ? fs.readFileSync(b.tex_path, 'utf8') : undefined;
  res.json({
    build: b ? { ...b, pdf: b.pdf_path && fs.existsSync(b.pdf_path) ? `/api/docs/${encodeURIComponent(id)}/pdf?t=${b.updated_at}` : null, tex } : null,
    job: job ? publicJob(job) : null,
  });
});

/* ------------------------------------------------------------------- users */

/** A user's profile picture (fetched from the identity provider once and cached on disk). */
api.get('/users/:id/avatar', async (req, res) => {
  try {
    const row = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(Number(req.params.id)) as { avatar_url: string | null } | undefined;
    if (!row?.avatar_url) { res.status(404).end(); return; }
    const file = path.join(config.dataDir, 'cache', `avatar-${Number(req.params.id)}`);
    const metaFile = file + '.json';
    let type = 'image/png';
    let fresh = false;
    try {
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { url: string; type: string; at: number };
      fresh = m.url === row.avatar_url && Date.now() - m.at < 7 * 24 * 3600 * 1000 && fs.existsSync(file);
      type = m.type;
    } catch { /* not cached */ }
    if (!fresh) {
      const r = await fetch(row.avatar_url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) { if (fs.existsSync(file)) { res.setHeader('Content-Type', type); res.sendFile(file); } else res.status(502).end(); return; }
      type = r.headers.get('content-type') ?? 'image/png';
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      fs.writeFileSync(metaFile, JSON.stringify({ url: row.avatar_url, type, at: Date.now() }));
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file);
  } catch (e) { res.status(502).json({ error: String(e) }); }
});

api.get('/users', (req, res) => {
  if (!req.user?.isAdmin) { res.status(403).json({ error: 'admin only' }); return; }
  const rows = db.prepare('SELECT id, username, display_name AS name, color, is_admin AS isAdmin, email FROM users ORDER BY username').all() as { id: number }[];
  res.json({ users: rows.map(u => ({ ...u, allowRecopyTokens: userSettings(u.id).allowRecopyTokens })) });
});
api.post('/users', (req, res) => {
  if (!req.user?.isAdmin) { res.status(403).json({ error: 'admin only' }); return; }
  try {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,32}$/.test(username)) { res.status(400).json({ error: 'invalid username' }); return; }
    const password = String(req.body?.password || generatePassword());
    const u = createUser(username, String(req.body?.name || username), password, { email: req.body?.email });
    res.json({ user: { id: u.id, username: u.username, name: u.display_name, color: u.color }, password });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

app.use('/api', api);

/* ------------------------------------------------------------------ static */

if (fs.existsSync(config.clientDist)) {
  app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/|\/ws).*/, (_req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('text').send('OverLyX server running. Build the client (npm run build) or use the Vite dev server.'));
}

adoptProjects();
sandboxAvailable();
void ensureAllRepos().then(() => startMirrorSweeper());
pruneAccessLog();

const server = http.createServer(app);
attachWebSocket(server);

server.listen(config.port, config.host, () => {
  console.log(`OverLyX server listening on http://${config.host}:${config.port}  (projects: ${config.projectsDir}, data: ${config.dataDir})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('shutting down, saving open documents…');
    manager.saveAll().then(() => flushCommits()).finally(() => process.exit(0));
  });
}
// A promise nobody awaited must not take the server (and everybody's session) down: log it.
process.on('unhandledRejection', (reason) => { console.error('[server] unhandled rejection:', reason); reportServerError(reason); });
// A real crash: save what can be saved, then let systemd restart us.
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception — saving open documents and exiting:', err);
  const bail = setTimeout(() => process.exit(1), 5000);
  manager.saveAll().finally(() => { clearTimeout(bail); process.exit(1); });
});
