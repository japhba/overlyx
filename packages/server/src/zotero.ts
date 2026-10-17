/**
 * Connect to Zotero (Settings ▸ Account ▸ Zotero, or the citation dialog's "Connect Zotero…"): the
 * account links its Zotero library with a Zotero Web API key (zotero.org/settings/keys — "Allow
 * library access" is enough; nothing is ever written to Zotero). The citation dialog's search then
 * lists the matching items of that library, and of the groups the key can read, above the papers
 * found online; picking one adds Zotero's own BibTeX of it to the project's cited.bib like any found
 * paper (bibsearch.ts addToCitedBib: a Scholar-style key, no duplicates).
 *
 * The key is kept sealed (sealed.ts), never sent back to the browser, and goes with Disconnect or the
 * account (accounts.ts). Zotero's OAuth (which hands a key over without copying it) would need the
 * server registered as a Zotero application: see DOCS.md.
 *
 *   GET    /api/zotero          { connected, username?, libraries? }
 *   POST   /api/zotero { key }  checks the key with Zotero, keeps it → the same
 *   DELETE /api/zotero          forgets it
 */
import express from 'express';
import { cleanTex } from '@overlyx/core';
import { db } from './db.ts';
import { config } from './config.ts';
import { sealer } from './sealed.ts';
import { fetchImpl, normTitle, type Hit } from './bibsearch.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS zotero_accounts (
  user_id INTEGER PRIMARY KEY,
  api_key TEXT NOT NULL,
  zotero_user INTEGER NOT NULL,
  username TEXT NOT NULL,
  libraries TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

const API = 'https://api.zotero.org';
const { seal, unseal } = sealer('zotero');
const headers = (key: string) => ({ 'Zotero-API-Version': '3', 'Zotero-API-Key': key });

interface Library { type: 'user' | 'group'; id: number; name: string }
export interface ZoteroStatus { connected: boolean; username?: string; libraries?: string[] }
interface Row { api_key: string; username: string; libraries: string }

export function zoteroStatus(userId: number): ZoteroStatus {
  const r = db.prepare('SELECT username, libraries FROM zotero_accounts WHERE user_id = ?').get(userId) as Omit<Row, 'api_key'> | undefined;
  if (!r) return { connected: false };
  return { connected: true, username: r.username, libraries: (JSON.parse(r.libraries) as Library[]).map(l => l.name) };
}

/** Check a key with Zotero (whose library it opens, which groups it reads) and keep it. Errors are for the user. */
export async function connectZotero(userId: number, key: string): Promise<ZoteroStatus> {
  const k = key.trim();
  if (!/^[A-Za-z0-9]{24}$/.test(k)) throw new Error('A Zotero API key is 24 letters and digits — create one at zotero.org/settings/keys');
  const r = await fetchImpl(`${API}/keys/current`, { headers: headers(k) });
  if (r.status === 403 || r.status === 404) throw new Error('Zotero does not know this key (mistyped, or revoked?)');
  if (!r.ok) throw new Error(`Zotero did not answer (${r.status}) — try again in a moment`);
  const d: any = await r.json();
  const userID = Number(d.userID);
  if (!userID) throw new Error('Zotero did not say whose key this is');
  const libs: Library[] = [];
  if (d.access?.user?.library) libs.push({ type: 'user', id: userID, name: 'My Library' });
  const groups = d.access?.groups;
  if (groups && Object.keys(groups).length) {
    try {
      const g = await fetchImpl(`${API}/users/${userID}/groups?limit=100`, { headers: headers(k) });
      if (g.ok) {
        for (const x of (await g.json()) as any[]) {
          const id = Number(x?.id ?? x?.data?.id);
          const access = groups.all ?? groups[String(id)];
          if (id && access?.library) libs.push({ type: 'group', id, name: String(x?.data?.name ?? `Group ${id}`) });
        }
      }
    } catch { /* the user's own library alone */ }
  }
  if (!libs.length) throw new Error('This key cannot read any library — edit it at zotero.org/settings/keys and tick “Allow library access”');
  db.prepare('INSERT OR REPLACE INTO zotero_accounts (user_id, api_key, zotero_user, username, libraries, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, seal(k), userID, String(d.username || d.displayName || `user ${userID}`), JSON.stringify(libs.slice(0, 20)), Date.now());
  return zoteroStatus(userId);
}

export function disconnectZotero(userId: number): void {
  db.prepare('DELETE FROM zotero_accounts WHERE user_id = ?').run(userId);
}

/**
 * The account's Zotero items matching the words (title, creator, year), from its library and the
 * groups the key reads; null when no Zotero is connected. A library that does not answer is a warning.
 */
export async function searchZotero(userId: number, q: string, limit = 6): Promise<{ hits: Hit[]; warnings: string[] } | null> {
  const row = db.prepare('SELECT api_key, username, libraries FROM zotero_accounts WHERE user_id = ?').get(userId) as Row | undefined;
  if (!row) return null;
  let key: string;
  try { key = unseal(row.api_key); } catch { return { hits: [], warnings: ['The Zotero connection can no longer be read — connect Zotero again (Settings ▸ Account)'] }; }
  const libs = JSON.parse(row.libraries) as Library[];
  // (the Web API has no relevance order: the most recently changed matches come first)
  const params = new URLSearchParams({ q, qmode: 'titleCreatorYear', include: 'data,bibtex', limit: String(limit), itemType: '-attachment' });
  const settled = await Promise.allSettled(libs.slice(0, 6).map(async lib => {
    const r = await fetchImpl(`${API}/${lib.type === 'user' ? 'users' : 'groups'}/${lib.id}/items/top?${params}`, { headers: headers(key) });
    if (r.status === 403) throw new Error('Zotero refused the key — connect Zotero again (Settings ▸ Account)');
    if (!r.ok) throw new Error(`Zotero answered ${r.status}`);
    return ((await r.json()) as any[]).map(it => zoteroHit(it, lib)).filter((h): h is Hit => !!h);
  }));
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const h of s.value) {
      const id = h.doi?.toLowerCase() || normTitle(h.title);
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push(h);
    }
  }
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  const warnings = failed && !hits.length ? [`Your Zotero library did not answer: ${failed.reason?.message ?? 'no answer'}`] : [];
  return { hits: hits.slice(0, limit), warnings };
}

/** A Zotero item (Web API JSON, with `include=data,bibtex`) as a hit carrying Zotero's BibTeX of it. */
export function zoteroHit(item: any, lib: Library): Hit | null {
  const d = item?.data;
  if (!d || ['note', 'attachment', 'annotation'].includes(d.itemType)) return null;
  const title = String(d.title ?? '').trim();
  if (!title) return null;
  const creators: any[] = Array.isArray(d.creators) ? d.creators : [];
  const authors = creators.filter(c => c.creatorType === 'author' || c.creatorType === 'inventor' || c.creatorType === 'presenter');
  const named = (authors.length ? authors : creators).map(c => String(c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' '))).filter(Boolean);
  const extra = String(d.extra ?? '');
  const doi = String(d.DOI ?? '').trim() || /^DOI:\s*(10\.\S+)/im.exec(extra)?.[1] || null;
  // a preprint's archive id, Zotero's note of it ("arXiv:1706.03762 [cs]"), or its address
  const arxiv = /^arXiv:\s*([\w./-]+?)(?:v\d+)?(?:\s|$)/im.exec(`${d.archiveID ?? ''}\n${extra}`)?.[1] ?? /arxiv\.org\/(?:abs|pdf)\/([\w./-]+?)(?:v\d+)?(?:\.pdf)?$/.exec(String(d.url ?? ''))?.[1] ?? null;
  const bib = typeof item.bibtex === 'string' && item.bibtex.trim().startsWith('@') ? slimBibtex(item.bibtex.trim()) : undefined;
  return {
    id: `zotero:${lib.type}${lib.id}:${item.key ?? d.key}`, title: cleanTex(title), authors: named, year: Number(/\b(\d{4})\b/.exec(String(d.date ?? ''))?.[1]) || null,
    venue: String(d.publicationTitle || d.proceedingsTitle || d.conferenceName || d.bookTitle || d.repository || d.university || d.institution || d.publisher || d.websiteTitle || ''),
    type: String(d.itemType ?? ''), doi, arxiv, url: String(d.url || '') || (doi ? `https://doi.org/${doi}` : null), citations: null, sources: ['zotero'],
    bibtex: bib, note: lib.type === 'group' ? `Zotero · ${lib.name}` : 'Your Zotero library',
  };
}

/** Zotero's BibTeX without what a bibliography does not need (abstract, keywords, file links, notes). */
export function slimBibtex(bib: string): string {
  const DROP = /^(abstract|keywords|file|annote|note|mendeley-\w+|langid)$/i;
  let out = '', i = 0;
  while (i < bib.length) {
    // a field starts after the entry's key or a field's comma: name = value
    const m = /[,{]\s*$/.test(out) ? /^\s*([A-Za-z][\w-]*)\s*=\s*/.exec(bib.slice(i)) : null;
    if (!m) { out += bib[i++]; continue; }
    // the value: {…} with nesting, "…", or a bare word or number (month = dec)
    let j = i + m[0].length;
    if (bib[j] === '{') { for (let depth = 0; j < bib.length; j++) { if (bib[j] === '{') depth++; else if (bib[j] === '}' && --depth === 0) { j++; break; } } }
    else if (bib[j] === '"') { j++; while (j < bib.length && bib[j] !== '"') j++; j++; }
    else while (j < bib.length && /[\w.-]/.test(bib[j])) j++;
    // a dropped field takes its comma with it
    if (DROP.test(m[1])) { i = j + (/^\s*,/.exec(bib.slice(j))?.[0].length ?? 0); continue; }
    out += bib.slice(i, j);
    i = j;
  }
  return out.replace(/,(\s*\})\s*$/, '$1');
}

export function zoteroRoutes(): express.Router {
  const r = express.Router();
  r.get('/zotero', (req, res) => { res.json(zoteroStatus(req.user!.id)); });
  r.post('/zotero', async (req, res) => {
    if (req.user!.guest) { res.status(403).json({ error: 'Sign in first' }); return; }
    if (!config.literature) { res.status(503).json({ error: 'Literature search is switched off on this server (OVERLYX_LITERATURE=off).' }); return; }
    try { res.json(await connectZotero(req.user!.id, String(req.body?.key ?? ''))); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  r.delete('/zotero', (req, res) => { disconnectZotero(req.user!.id); res.json(zoteroStatus(req.user!.id)); });
  return r;
}
