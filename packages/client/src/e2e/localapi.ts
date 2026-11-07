/**
 * The app's API for end-to-end encrypted projects, answered in the browser (api.ts hands every
 * request here first: `routeLocal`). A request about such a project — its files, a document's
 * metadata, a build, the text of a file — is served from the decrypted project (project.ts) and never
 * goes to the server; what the server still does for it (sharing, the member list, deleting it) goes
 * through. Anything not listed here is refused rather than sent: the server must never receive the
 * content of an encrypted project, not even by mistake (the AI features, the snippet previews, the
 * outline).
 */
import * as Y from 'yjs';
import { newDocumentText, newMarkdownText, texHeadings, parseBibtex, lyxToPm, markEditedSettings, pageBreaks, synctexView, synctexEdit } from '@overlyx/core';
import { openE2eProject, isE2eProject, isE2eDocId, markE2eProject, noteProjects, e2eUser, type E2eProject } from './project';
import { tex } from './project';
import { forgetProjectKey, KeyMissing } from './keys';

const NOT_HERE = 'This is not available in end-to-end encrypted projects: the server would see the content';
export function refuse(message = NOT_HERE, status = 403): never { throw Object.assign(new Error(message), { status, data: { error: message, code: 'e2e' } }); }

const DOC_ACTIONS = /^\/api\/docs\/(.+?)\/(meta|tex|lyx|outline|source|bib|reset|save|header|frontmatter|versions(?:\/\d+(?:\/restore)?)?|export(?:\/cancel)?|pdf|build|folds|place|opened|external|legacy-merge|synctex\/(?:view|edit|pages)|layoutcheck|clip|snippet|repair|ai-repair(?:\/apply)?|ai\/[a-z]+|as-article|gdocs\/[a-z]+|lesswrong\/[a-z]+)$/;
const PROJECT = /^\/api\/projects\/([^/?]+)(\/.*)?$/;

/** the document open in the app (the AI routes that name no document act on it) */
let currentDoc: () => string | null = () => null;
export function setCurrentDoc(fn: () => string | null): void { currentDoc = fn; }

/**
 * The answer to a request about an encrypted project, or `undefined` when the request is not about
 * one (it goes to the server as usual).
 */
export function routeLocal(method: string, url: string, body: unknown, raw: BodyInit | undefined): Promise<unknown> | undefined {
  const [path, query = ''] = url.split('?');
  const q = new URLSearchParams(query);
  // requests that carry content but name no project: refused while an encrypted document is open
  if (/^\/api\/(ai|snippets)\//.test(path)) { const d = currentDoc(); if (d && isE2eDocId(d)) return Promise.reject(Object.assign(new Error(NOT_HERE), { status: 403 })); return undefined; }
  if (method === 'POST' && path === '/api/projects' && (body as { e2e?: boolean } | undefined)?.e2e) return createEncryptedProject(body as { name: string });
  const d = DOC_ACTIONS.exec(path);
  if (d) {
    let id: string;
    try { id = decodeURIComponent(d[1]); } catch { return undefined; }
    if (!isE2eDocId(id)) return undefined;
    return docRoute(method, id, d[2], q, body).catch(e => { throw normalize(e); });
  }
  const p = PROJECT.exec(path);
  if (p) {
    let project: string;
    try { project = decodeURIComponent(p[1]); } catch { return undefined; }
    if (!isE2eProject(project)) return undefined;
    const rest = p[2] ?? '';
    // what the server keeps doing for an encrypted project
    if (/^\/(share(\/(members|links|owner)(\/[^/]+)?)?|activity)$/.test(rest) || (rest === '' && method === 'DELETE')) {
      if (rest === '' && method === 'DELETE') void forgetProjectKey(project);
      return undefined;
    }
    return projectRoute(method, project, rest, q, body, raw).catch(e => { throw normalize(e); });
  }
  return undefined;
}

function normalize(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  const x = err as Error & { status?: number; data?: unknown };
  x.status ??= 400;
  x.data ??= { error: err.message };
  return err;
}

/** After the project list came: the encrypted projects' files are those of their manifests (those unlocked here). */
export async function patchProjects<T extends { name: string; e2e?: boolean; role?: string; files: unknown[]; e2eLocked?: 'account' | 'waiting' }>(list: T[]): Promise<T[]> {
  noteProjects(list);
  await Promise.all(list.filter(p => p.e2e).map(async p => {
    try {
      const proj = await Promise.race([openE2eProject(p.name, { prompt: false }), new Promise<null>(r => setTimeout(r, 4000, null))]);
      if (proj) p.files = proj.list();
    } catch (e) {
      // locked here: no files until it is unlocked
      p.e2eLocked = e instanceof KeyMissing ? e.reason : 'account';
    }
  }));
  return list;
}

async function createEncryptedProject(body: { name: string }): Promise<unknown> {
  const res = await fetch('/api/projects', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: body.name, e2e: true }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `${res.status}`), { status: res.status, data });
  const name = data.project.name as string;
  markE2eProject(name, 'owner');
  await openE2eProject(name, { create: true });
  return data;
}

/* ------------------------------------------------------------------------- documents */

interface Job { id: number; status: 'queued' | 'exporting' | 'compiling' | 'ok' | 'error' | 'cancelled'; engine: string; requestedBy: string; startedAt: number; phaseAt: number; finishedAt?: number; progress: string; rerun: boolean }
interface Build { status: string; log: string; pdf: string | null; pdf_path: string | null; tex_path: string | null; updated_at: number; warnings: string[]; tex?: string; pdf_at?: number | null; source_at?: number | null }
const builds = new Map<string, { job: Job | null; build: Build | null; cancel: boolean }>();
/** the last build's SyncTeX data of each document (gzipped, as the engine wrote it), the built .tex's name and text: for PDF ⇄ source */
const synctexOf = new Map<string, { gz: Uint8Array; texName: string; tex: string }>();
const synctexText = new Map<string, { gz: Uint8Array; text: string; breaks?: unknown }>();

/** the last build's SyncTeX file of the document, as text (gunzipped once per build) */
async function synctexFile(id: string): Promise<{ texName: string; tex: string; text: string; memo: { breaks?: unknown } } | null> {
  const s = synctexOf.get(id);
  if (!s) return null;
  let t = synctexText.get(id);
  if (t?.gz !== s.gz) {
    const text = await new Response(new Blob([s.gz.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    synctexText.set(id, t = { gz: s.gz, text });
  }
  return { texName: s.texName, tex: s.tex, text: t.text, memo: t };
}

/** the Pages view's page breaks of the last build (core pagebreaks.ts, without the PDF's words) */
async function localPageBreaks(id: string): Promise<unknown> {
  const f = await synctexFile(id);
  if (!f) return null;
  if (f.memo.breaks === undefined) {
    const bodyLine = f.tex.split('\n').findIndex(l => /^[^%]*\\begin\{document\}/.test(l)) + 1;
    f.memo.breaks = pageBreaks(f.text, f.texName, bodyLine, null, f.tex);
  }
  return f.memo.breaks;
}
let jobIds = 1;

async function docRoute(method: string, id: string, action: string, q: URLSearchParams, body: unknown): Promise<unknown> {
  const project = id.split('/').slice(0, 2).join('/'), rel = id.slice(project.length + 1);
  const p = await openE2eProject(project, { doc: id });
  const b = (body ?? {}) as Record<string, unknown>;
  const ver = /^versions\/(\d+)(\/restore)?$/.exec(action);
  if (ver) {
    const vid = Number(ver[1]);
    if (ver[2] && method === 'POST') { await p.restoreVersion(rel, vid); return { ok: true }; }
    if (method === 'GET') { const { text, version } = await p.versionText(rel, vid); return { lyx: text, name: version.name, created_at: version.created_at, author: version.author }; }
    if (method === 'DELETE') { await p.deleteVersion(rel, vid); return { ok: true }; }
  }
  switch (action) {
    case 'meta': {
      const { documentMetaLocal } = await tex();
      await p.prefetchDocs();
      await p.prefetchTexts();
      const lyx = p.modelNow(rel) ?? await p.docModel(rel);
      const m = documentMetaLocal(rel, lyx, p.view());
      return { id, project, path: rel, role: p.role, ...m, master: m.master ? `${project}/${m.master}` : null, files: p.list(), health: [] };
    }
    case 'tex': {
      const text = await p.docText(rel);
      return q.get('map') ? { text, spans: null } : text;
    }
    case 'outline': {
      const text = await p.docText(rel);
      const depth = /\\setcounter\{secnumdepth\}\{(-?\d+)\}/.exec(text);
      return { headings: texHeadings(text, depth ? Number(depth[1]) : 3), mtime: Date.now() };
    }
    case 'source': {
      if (method !== 'POST') break;
      await p.applyText(rel, String(b.text ?? ''));
      return { ok: true, warnings: [] };
    }
    case 'clip': {
      const { lyxDocumentOf, parseText } = await tex();
      const live = p.open.get(rel);
      const header = live ? lyxDocumentOf(live).header.lines : (await p.docModel(rel)).header.lines;
      const r = parseText(String(b.latex ?? ''), { relPath: rel, projectText: () => undefined, masterHeader: header });
      return { blocks: (lyxToPm(r.doc) as { content?: unknown[] }).content ?? [], warnings: r.warnings };
    }
    case 'bib': {
      await p.prefetchTexts();
      const entries = p.paths().filter(x => x.endsWith('.bib')).flatMap(x => { const t = p.cachedText(x); try { return t ? parseBibtex(t) : []; } catch { return []; } });
      const seen = new Set<string>();
      const all = entries.filter(e => (seen.has(e.key) ? false : (seen.add(e.key), true)));
      const keys = (q.get('keys') ?? '').split(',').map(k => k.trim()).filter(Boolean);
      if (keys.length) return { entries: all.filter(e => keys.includes(e.key)), total: all.length };
      const terms = (q.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = terms.length ? all.filter(e => terms.every(t => e.key.toLowerCase().includes(t) || e.authorShort.toLowerCase().includes(t) || e.year.includes(t) || e.title.toLowerCase().includes(t))) : all;
      return { entries: hits.slice(0, Number(q.get('limit') ?? 100) || 100), total: all.length, matches: hits.length };
    }
    case 'header': {
      const live = p.open.get(rel);
      const meta = live?.getMap<string>('meta');
      const current = (): string[] => { try { return JSON.parse(meta?.get('header') ?? '[]'); } catch { return []; } };
      if (method === 'GET') return { headerLines: live ? current() : (await p.docModel(rel)).header.lines };
      if (!live || !meta) refuse('Open the document to change its settings');
      const before = current();
      let lines = [...before];
      if (Array.isArray(b.headerLines)) lines = (b.headerLines as unknown[]).map(String);
      if (typeof b.preamble === 'string') {
        const start = lines.indexOf('\\begin_preamble');
        const content = b.preamble.replace(/\r\n/g, '\n').split('\n');
        if (start >= 0) { const end = lines.indexOf('\\end_preamble', start); lines.splice(start + 1, end - start - 1, ...content); }
        else { const idx = lines.findIndex(l => l.startsWith('\\textclass')); lines.splice(idx + 1, 0, '\\begin_preamble', ...content, '\\end_preamble'); }
      }
      const set = (b.set && typeof b.set === 'object' ? b.set : {}) as Record<string, string>;
      for (const [k, v] of Object.entries(set)) {
        const i = lines.findIndex(l => l === '\\' + k || l.startsWith('\\' + k + ' '));
        if (i >= 0) lines[i] = `\\${k} ${v}`; else lines.push(`\\${k} ${v}`);
      }
      lines = markEditedSettings(before, lines, Object.keys(set));
      live!.transact(() => { meta!.set('header', JSON.stringify(lines)); }, 'header');
      return { ok: true, headerLines: lines };
    }
    case 'save': case 'opened': return { ok: true };
    case 'folds': return { folds: [], at: 0 };
    case 'place': return { slide: null, at: 0 };
    case 'external': return { clones: [], google: null };
    case 'versions': {
      if (method === 'GET') return { versions: p.versionsOf(rel).map(({ blob: _b, ...v }) => v) };
      if (method === 'POST') return { id: await p.saveVersion(rel, String(b.name ?? 'version'), 'manual', typeof b.lyx === 'string' ? b.lyx : undefined) };
      break;
    }
    case 'synctex/pages': return { breaks: await localPageBreaks(id).catch(() => null) };
    case 'synctex/view': {
      const f = await synctexFile(id), line = Number(q.get('line'));
      return { boxes: f && line >= 1 ? synctexView(f.text, f.texName, Math.floor(line)) : [] };
    }
    case 'synctex/edit': {
      const f = await synctexFile(id), page = Number(q.get('page')), x = Number(q.get('x')), y = Number(q.get('y'));
      return (f && page >= 1 && Number.isFinite(x) && Number.isFinite(y) ? synctexEdit(f.text, Math.floor(page), x, y) : null) ?? { line: null };
    }
    case 'export': {
      const format = (b.format ?? 'pdf') as string;
      if (format === 'tex') return { ok: true, tex: await p.docText(rel) };
      return startBuild(p, id, rel, !!b.auto);
    }
    case 'export/cancel': { const s = builds.get(id); if (s) s.cancel = true; return { ok: true }; }
    case 'build': {
      const s = builds.get(id);
      return { build: s?.build ? { ...s.build, ...(q.get('tex') ? {} : { tex: undefined }) } : null, job: s?.job ?? null, now: Date.now() };
    }
  }
  refuse();
}

function startBuild(p: E2eProject, id: string, rel: string, auto: boolean): unknown {
  const prev = builds.get(id);
  if (prev?.job && ['queued', 'exporting', 'compiling'].includes(prev.job.status)) return { ok: true, job: prev.job };
  const now = Date.now();
  const job: Job = { id: jobIds++, status: 'compiling', engine: 'LaTeX (in this browser)', requestedBy: e2eUser().name, startedAt: now, phaseAt: now, progress: 'starting', rerun: false };
  const state = { job, build: prev?.build ?? null, cancel: false };
  builds.set(id, state);
  void (async () => {
    try {
      const { compileProject } = await import('./compile');
      const r = await compileProject(p, rel, (s) => { job.progress = s; job.phaseAt = Date.now(); }, () => state.cancel);
      job.engine = r.engine;
      if (r.synctex) synctexOf.set(id, { gz: r.synctex, texName: r.texName, tex: r.tex });
      if (state.build?.pdf && r.pdf) URL.revokeObjectURL(state.build.pdf);
      const url = r.pdf ? URL.createObjectURL(new Blob([r.pdf.slice().buffer as ArrayBuffer], { type: 'application/pdf' })) : state.build?.pdf ?? null;
      const at = Date.now();
      state.build = { status: r.ok ? 'ok' : 'error', log: r.log, pdf: url, pdf_path: null, tex_path: null, updated_at: at, warnings: r.warnings, tex: r.tex, pdf_at: r.pdf ? at : state.build?.pdf_at ?? null, source_at: now };
      job.status = r.ok ? 'ok' : 'error';
    } catch (e) {
      if ((e as Error).message === 'cancelled') job.status = 'cancelled';
      else { job.status = 'error'; state.build = { status: 'error', log: String((e as Error).message ?? e), pdf: state.build?.pdf ?? null, pdf_path: null, tex_path: null, updated_at: Date.now(), warnings: [], pdf_at: state.build?.pdf_at ?? null, source_at: now }; }
    }
    job.finishedAt = Date.now();
    void auto;
  })();
  return { ok: true, job };
}

/** The latest PDF built here of a document (a blob: URL), for its download link. */
export function builtPdfUrl(id: string): string | null { return builds.get(id)?.build?.pdf ?? null; }

/* -------------------------------------------------------------------------- projects */

async function projectRoute(method: string, project: string, rest: string, q: URLSearchParams, body: unknown, raw: BodyInit | undefined): Promise<unknown> {
  const p = await openE2eProject(project);
  const b = (body ?? {}) as Record<string, unknown>;
  if (rest === '/new' && method === 'POST') {
    const path = String(b.path ?? '').replace(/^\/+/, '');
    if (!/\.(tex|md|markdown)$/i.test(path)) refuse('Only documents (.tex, .md) can be made in end-to-end encrypted projects');
    if (p.entry(path)) refuse(`${path} exists already`, 409);
    if (b.layout) refuse('Slides and posters are not available in end-to-end encrypted projects yet');
    const text = /\.(md|markdown)$/i.test(path) ? newMarkdownText(b.title as string | undefined) : newDocumentText({ textclass: b.textclass as string | undefined, title: b.title as string | undefined, author: e2eUser().name });
    await p.createDoc(path, text);
    return { id: `${project}/${path}` };
  }
  if (rest === '/upload' && method === 'POST') {
    const path = (q.get('path') ?? '').replace(/^\/+/, '');
    if (!path) refuse('no path', 400);
    if (p.entry(path) && q.get('overwrite') === '0') refuse(`${path} exists already`, 409);
    const bytes = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(0);
    await p.putFile(path, bytes);
    return { ok: true, path };
  }
  if (rest === '/fileops' && method === 'POST') {
    const op = String(b.op), from = String(b.from ?? ''), to = String(b.to ?? '');
    if (op === 'rename') p.rename(from, to);
    else if (op === 'delete') await p.remove(from);
    else if (op === 'mkdir') p.mkdir(to || from);
    else if (op === 'copy') await p.copy(from, to);
    else refuse('unknown operation', 400);
    return { ok: true };
  }
  const t = /^\/text\/(.+)$/.exec(rest);
  if (t) {
    const path = t[1].split('/').map(decodeURIComponent).join('/');
    if (method === 'GET') {
      const bytes = await p.readFile(path);
      return { text: new TextDecoder().decode(bytes), mtime: p.entry(path)?.mtime ?? 0, size: bytes.length, role: p.role };
    }
    if (method === 'PUT') {
      await p.putFile(path, new TextEncoder().encode(String(b.text ?? '')));
      return { ok: true, mtime: p.entry(path)?.mtime ?? Date.now(), size: String(b.text ?? '').length };
    }
  }
  refuse();
}

void Y;
