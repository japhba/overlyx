import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.ts';
import { authMiddleware, authRouter, requireAuth, createUser, generatePassword } from './auth.ts';
import { attachWebSocket } from './ws.ts';
import { manager } from './docs.ts';
import { listProjects, resolveProjectPath, projectDir, createProject, newDocumentText, fileKind, findMaster, isBackupFile } from './projects.ts';
import { toPng, isDirectImage } from './graphics.ts';
import { buildPdf, exportTex, lastBuild, requestBuild, currentJob, cancelBuild, publicJob } from './export.ts';
import { db } from './db.ts';
import { parseLyx, collectMacros, toMathliveMacros, parseBibtex, getTextClass, getModules, getAuthors, headerValue, paramMap, unquote, walkInsets, walkParagraphs as walkParagraphsAll, plainText } from '@overlyx/core';

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

/**
 * Parsed BibTeX files, cached in memory and on disk (data/cache/bib-*.json) by path + mtime + size:
 * bibliographies are often several MB and parsing one takes over a second, which used to make the
 * first open of a document after a server restart slow.
 */
const bibCache = new Map<string, { key: string; entries: ReturnType<typeof parseBibtex> }>();
function cachedBib(abs: string): ReturnType<typeof parseBibtex> {
  try {
    const st = fs.statSync(abs);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = bibCache.get(abs);
    if (hit && hit.key === key) return hit.entries;
    const diskFile = path.join(config.dataDir, 'cache', 'bib-' + crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16) + '.json');
    let entries: ReturnType<typeof parseBibtex> | null = null;
    try {
      const cached = JSON.parse(fs.readFileSync(diskFile, 'utf8')) as { key: string; entries: ReturnType<typeof parseBibtex> };
      if (cached.key === key && Array.isArray(cached.entries)) entries = cached.entries;
    } catch { /* no disk cache */ }
    if (!entries) {
      entries = parseBibtex(fs.readFileSync(abs, 'utf8')).map(e => ({ ...e, key: String(e.key ?? ''), author: String(e.author ?? ''), year: String(e.year ?? ''), title: String(e.title ?? '') }));
      try { fs.writeFileSync(diskFile, JSON.stringify({ key, entries })); } catch { /* cache dir not writable: ignore */ }
    }
    bibCache.set(abs, { key, entries });
    return entries;
  } catch { return []; }
}

/** Parsed LyX files that are not open (child documents, macro files), cached by mtime + size. */
const parseCache = new Map<string, { key: string; doc: ReturnType<typeof parseLyx> }>();
function cachedParse(abs: string): ReturnType<typeof parseLyx> {
  const st = fs.statSync(abs);
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = parseCache.get(abs);
  if (hit && hit.key === key) return hit.doc;
  const doc = parseLyx(fs.readFileSync(abs, 'utf8'));
  if (parseCache.size > 200) parseCache.clear();
  parseCache.set(abs, { key, doc });
  return doc;
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
      ? entries.filter(e => terms.every(t => e.key.toLowerCase().includes(t) || e.author.toLowerCase().includes(t) || e.year.includes(t) || e.title.toLowerCase().includes(t)))
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
      return cachedParse(path.join(proj, rel));
    };
    const rootRel = masterRel ?? doc.relPath;
    const rootLyx = masterRel ? readDoc(masterRel) : lyx;
    const docDir = path.dirname(path.join(proj, rootRel));
    const safe = (fn: string) => { const abs = path.resolve(docDir, fn); return abs.startsWith(proj) ? abs : null; };
    const includeDoc = (fn: string) => { const abs = safe(fn); if (!abs) return undefined; try { return readDoc(path.relative(proj, abs)); } catch { return undefined; } };
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
            const fn = unquote(paramMap(ins.params).get('filename'));
            if (fn.endsWith('.lyx')) {
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
          const fn = unquote(pm.get('filename'));
          const abs = safe(fn);
          if (abs && fn.endsWith('.lyx') && fs.existsSync(abs)) {
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
      const dc = mod.loadDocumentClass(getTextClass(lyx), getModules(lyx), config.layoutDir);
      layouts = mod.describeLayouts(dc);
      flexInsets = dc.insetLayouts ? [...Object.keys(dc.insetLayouts ?? {})] : null;
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
    const engine = req.body?.engine === 'lyx' ? 'lyx' : 'overlyx';
    if (format === 'tex') {
      const r = await exportTex(id);
      res.json({ ok: true, tex: r.tex, warnings: r.warnings });
      return;
    }
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
