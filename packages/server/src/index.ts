import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { authMiddleware, authRouter, requireAuth, createUser, generatePassword } from './auth.ts';
import { attachWebSocket } from './ws.ts';
import { manager } from './docs.ts';
import { listProjects, resolveProjectPath, projectDir, createProject, newDocumentText, fileKind } from './projects.ts';
import { toPng, isDirectImage } from './graphics.ts';
import { buildPdf, exportTex, lastBuild } from './export.ts';
import { db } from './db.ts';
import { parseLyx, collectMacros, toMathliveMacros, parseBibtex, getTextClass, getModules, getAuthors, headerValue, paramMap, unquote, walkInsets } from '@overlyx/core';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(authMiddleware);
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use('/api/auth', authRouter());

const api = express.Router();
api.use(requireAuth);
api.use(express.json({ limit: '5mb' }));

/* ---------------------------------------------------------------- projects */

api.get('/projects', (_req, res) => {
  res.json({ projects: listProjects().map(p => ({ name: p.name, files: p.files })) });
});

api.post('/projects', (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!/^[A-Za-z0-9._ -]+$/.test(name)) { res.status(400).json({ error: 'invalid project name' }); return; }
    const p = createProject(name);
    res.json({ project: { name: p.name, files: p.files } });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

api.post('/projects/:project/new', (req, res) => {
  try {
    let rel = String(req.body?.path ?? 'untitled.lyx');
    if (!rel.endsWith('.lyx')) rel += '.lyx';
    const abs = resolveProjectPath(req.params.project, rel);
    if (fs.existsSync(abs)) { res.status(409).json({ error: 'file exists' }); return; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, newDocumentText({ textclass: req.body?.textclass, title: req.body?.title, author: req.user?.name }), 'utf8');
    res.json({ id: `${req.params.project}/${rel}` });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Upload a file (raw body) into a project, e.g. figures/plot.png */
api.post('/projects/:project/upload', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
  try {
    const rel = String(req.query.path ?? '');
    if (!rel || rel.includes('..')) { res.status(400).json({ error: 'bad path' }); return; }
    const abs = resolveProjectPath(req.params.project, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, req.body as Buffer);
    res.json({ ok: true, path: rel, kind: fileKind(rel) });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Serve a project file (bib, pdf, images, ...). */
api.get('/projects/:project/file/*', (req, res) => {
  try {
    const rel = decodeURIComponent((req.params as any)[0]);
    const abs = resolveProjectPath(req.params.project, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.status(404).end(); return; }
    res.sendFile(abs);
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Graphics rendered to PNG for the editor (svg/pdf/eps/... converted; png/jpg passed through). */
api.get('/projects/:project/graphics/*', async (req, res) => {
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

/** Document metadata for the editor: class, layouts, macros, bib entries, labels, authors. */
api.get('/docs/*/meta', async (req, res) => {
  try {
    const id = docId(req);
    const doc = await manager.open(id);
    const lyx = doc.toLyxDocument();
    const docDir = path.dirname(doc.absPath);
    const proj = projectDir(doc.project);
    const safe = (fn: string) => { const abs = path.resolve(docDir, fn); return abs.startsWith(proj) ? abs : null; };
    const macros = collectMacros(lyx, {
      include: (fn) => { const abs = safe(fn); try { return abs ? parseLyx(fs.readFileSync(abs, 'utf8')) : undefined; } catch { return undefined; } },
      readFile: (fn) => { const abs = safe(fn); try { return abs ? fs.readFileSync(abs, 'utf8') : undefined; } catch { return undefined; } },
    });
    // bibliography files referenced by bibtex insets (in this doc and children)
    const bibFiles = new Set<string>();
    const scan = (d: typeof lyx, depth: number) => {
      if (depth > 3) return;
      for (const { inset } of walkInsets(d.body)) {
        if (inset.type !== 'Leaf' || inset.name !== 'CommandInset') continue;
        const pm = paramMap(inset.params);
        if (inset.arg === 'bibtex') {
          for (const f of unquote(pm.get('bibfiles')).split(',')) if (f.trim()) bibFiles.add(f.trim());
        } else if (inset.arg === 'include') {
          const fn = unquote(pm.get('filename'));
          const abs = safe(fn);
          if (abs && fn.endsWith('.lyx') && fs.existsSync(abs)) { try { scan(parseLyx(fs.readFileSync(abs, 'utf8')), depth + 1); } catch { /* ignore */ } }
        }
      }
    };
    scan(lyx, 0);
    const bib: ReturnType<typeof parseBibtex> = [];
    for (const f of bibFiles) {
      const abs = safe(f.endsWith('.bib') ? f : f + '.bib');
      if (abs && fs.existsSync(abs)) { try { bib.push(...parseBibtex(fs.readFileSync(abs, 'utf8'))); } catch { /* ignore */ } }
    }
    // also offer all .bib files of the project when none is referenced
    if (!bib.length) {
      for (const f of listProjects().find(p => p.name === doc.project)?.files ?? []) {
        if (f.kind === 'bib') { try { bib.push(...parseBibtex(fs.readFileSync(path.join(proj, f.path), 'utf8'))); } catch { /* ignore */ } }
      }
    }
    let layouts: unknown = null;
    let flexInsets: unknown = null;
    try {
      const mod = await import('@overlyx/core/latex/index.ts') as any;
      const dc = mod.loadDocumentClass(getTextClass(lyx), getModules(lyx), config.layoutDir);
      layouts = mod.describeLayouts(dc);
      flexInsets = dc.insetLayouts ? [...Object.keys(dc.insetLayouts ?? {})] : null;
    } catch (e) {
      layouts = null;
    }
    res.json({
      id, project: doc.project, path: doc.relPath,
      textclass: getTextClass(lyx), modules: getModules(lyx),
      language: headerValue(lyx.header, 'language') ?? 'english',
      useRefstyle: headerValue(lyx.header, 'use_refstyle') === '1',
      citeEngine: headerValue(lyx.header, 'cite_engine') ?? 'basic',
      citeEngineType: headerValue(lyx.header, 'cite_engine_type') ?? 'default',
      trackingChanges: headerValue(lyx.header, 'tracking_changes') === 'true',
      secnumdepth: Number(headerValue(lyx.header, 'secnumdepth') ?? 3),
      tocdepth: Number(headerValue(lyx.header, 'tocdepth') ?? 3),
      authors: getAuthors(lyx.header),
      macros: toMathliveMacros(macros),
      macroList: macros.map(m => ({ name: m.name, args: m.args, def: m.def, display: m.display, source: m.source })),
      bib: bib.slice(0, 20000).map(e => ({ key: e.key, author: e.authorShort, year: e.year, title: e.title })),
      layouts, flexInsets,
      files: listProjects().find(p => p.name === doc.project)?.files ?? [],
    });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

api.get('/docs/*/lyx', async (req, res) => {
  try {
    const doc = await manager.open(docId(req));
    res.setHeader('Content-Type', 'application/x-lyx; charset=utf-8');
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${path.basename(doc.relPath)}"`);
    res.send(doc.toLyxText());
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

api.post('/docs/*/save', async (req, res) => {
  try {
    const doc = await manager.open(docId(req));
    const ok = await doc.saveToFile();
    res.json({ ok });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

/** Update header (document settings): full header lines list, or preamble text. */
api.post('/docs/*/header', async (req, res) => {
  try {
    const doc = await manager.open(docId(req));
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

/* ---------------------------------------------------------------- versions */

api.get('/docs/*/versions', (req, res) => {
  res.json({ versions: manager.listVersions(docId(req)) });
});
api.post('/docs/*/versions', async (req, res) => {
  try {
    const id = await manager.createVersion(docId(req), String(req.body?.name ?? 'version'), req.user!.name, 'manual');
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
    const engine = req.body?.engine === 'lyx' ? 'lyx' : 'overlyx';
    if (format === 'tex') {
      const r = await exportTex(id);
      res.json({ ok: true, tex: r.tex, warnings: r.warnings });
      return;
    }
    const r = await buildPdf(id, { engine });
    res.json({ ok: r.ok, log: r.log, warnings: r.warnings, pdf: r.pdfPath ? `/api/docs/${encodeURIComponent(id)}/pdf?t=${Date.now()}` : null, tex: r.tex });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

api.get('/docs/*/pdf', (req, res) => {
  const b = lastBuild(docId(req));
  if (!b?.pdf_path || !fs.existsSync(b.pdf_path)) { res.status(404).json({ error: 'no pdf built yet' }); return; }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${path.basename(b.pdf_path)}"`);
  res.sendFile(b.pdf_path);
});

api.get('/docs/*/build', (req, res) => {
  res.json({ build: lastBuild(docId(req)) ?? null });
});

/* ------------------------------------------------------------------- users */

api.get('/users', (_req, res) => {
  res.json({ users: db.prepare('SELECT id, username, display_name AS name, color, is_admin AS isAdmin FROM users ORDER BY username').all() });
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

const server = http.createServer(app);
attachWebSocket(server);

server.listen(config.port, config.host, () => {
  console.log(`OverLyX server listening on http://${config.host}:${config.port}  (projects: ${config.projectsDir}, data: ${config.dataDir})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('shutting down, saving open documents…');
    manager.saveAll().finally(() => process.exit(0));
  });
}
