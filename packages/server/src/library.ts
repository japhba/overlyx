/**
 * My library: an account's own reference library, a Zotero of its own (the owner, 14 Nov 2026: "a
 * Zotero alternative at the account level, but well integrated with the interface").
 *
 * Each account keeps references — type, authors, title, venue, year, DOI, arXiv id, URL, abstract,
 * tags, a note and a BibTeX key (`vaswani2017attention`, Scholar style, unique within the account)
 * — and, per reference, a PDF (`<data>/library/<user id>/<ref id>.pdf`, PDF_MAX each, ACCOUNT_MAX
 * in all). The full BibTeX of a reference is kept as it came (Crossref's, arXiv's, Zotero's, a
 * pasted one) with its key rewritten; the edit form changes its fields in place.
 *
 * Adding: a DOI / arXiv id / ISBN / a paper's link or words (bibsearch.ts searchLiterature — the
 * citation dialog's lookups, with their user agent, timeouts and netguard for pasted pages), BibTeX
 * (one entry or a whole .bib file), a dropped PDF (its DOI or arXiv id read from the file:
 * pdfIdentifiers), the account's Zotero library (zotero.ts). A paper already in the library (same
 * DOI, arXiv id, or title and year) is not added twice: the caller is told which entry has it.
 *
 * Privacy: a library is its owner's alone — every route answers about `req.user` only, guests have
 * none. A project gets only the entries its documents cite: the citation dialog's "My library"
 * list adds the chosen one to the cited.bib beside the document (index.ts /bib/add `library`),
 * without the abstract, notes or file links (zotero.ts slimBibtex); the note and tags never leave
 * the library. Lookups send the identifier or the words only.
 *
 *   GET    /api/library                  { refs, tags, pdfBytes, zotero }
 *   GET    /api/library/lookup?q=        candidates for the add box { hits, warnings }
 *   POST   /api/library { hit | text }   add → { added, duplicates, failed }
 *   POST   /api/library/zotero           import the connected Zotero library → the same
 *   POST   /api/library/pdf  (a PDF)     a reference from a dropped PDF → { ref, duplicate, found }
 *   GET    /api/library/export.bib       the whole library as one .bib file
 *   GET    /api/library/:id              one reference with its abstract and BibTeX
 *   PATCH  /api/library/:id              edit fields, tags, note, key, or the BibTeX itself
 *   DELETE /api/library/:id
 *   PUT    /api/library/:id/pdf (a PDF), GET (open it), DELETE
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseBibtex, cleanTex, type BibEntry } from '@overlyx/core';
import { db } from './db.ts';
import { config } from './config.ts';
import { searchLiterature, bibtexFor, hitFromDoi, scholarKey, rewriteEntry, normTitle, type Hit } from './bibsearch.ts';
import { identify, resolveLink } from './citelinks.ts';
import { slimBibtex, zoteroLibraryItems, zoteroStatus } from './zotero.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS library_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  authors TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT '',
  year INTEGER,
  doi TEXT,
  arxiv TEXT,
  url TEXT,
  abstract TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  bibtex TEXT NOT NULL,
  pdf_size INTEGER,
  source TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS library_refs_key ON library_refs(user_id, key);
CREATE INDEX IF NOT EXISTS library_refs_doi ON library_refs(user_id, doi);
`);

/** one PDF at most (a long thesis with figures fits) */
export const PDF_MAX = 64 * 1024 * 1024;
/** all of an account's PDFs */
export const ACCOUNT_MAX = 2 * 1024 * 1024 * 1024;
/** entries one import takes */
const IMPORT_MAX = 5000;
const BIB_MAX = 40000;

interface Row {
  id: number; user_id: number; key: string; type: string; title: string; authors: string; venue: string; year: number | null;
  doi: string | null; arxiv: string | null; url: string | null; abstract: string; tags: string; note: string; bibtex: string;
  pdf_size: number | null; source: string; created_at: number; updated_at: number;
}
export interface LibRef {
  id: number; key: string; type: string; title: string; authors: string[]; venue: string; year: number | null;
  doi: string | null; arxiv: string | null; url: string | null; tags: string[]; note: string; pdf: boolean; pdfSize: number | null;
  source: string; added: number; updated: number; abstract?: string; bibtex?: string;
}

const pub = (r: Row, full = false): LibRef => ({
  id: r.id, key: r.key, type: r.type, title: r.title, authors: JSON.parse(r.authors), venue: r.venue, year: r.year, doi: r.doi, arxiv: r.arxiv, url: r.url,
  tags: JSON.parse(r.tags), note: r.note, pdf: r.pdf_size != null, pdfSize: r.pdf_size, source: r.source, added: r.created_at, updated: r.updated_at,
  ...(full ? { abstract: r.abstract, bibtex: r.bibtex } : {}),
});

const pdfDir = (uid: number) => path.join(config.dataDir, 'library', String(uid));
const pdfPath = (uid: number, id: number) => path.join(pdfDir(uid), `${id}.pdf`);

export function getRef(uid: number, id: number): Row | undefined {
  return db.prepare('SELECT * FROM library_refs WHERE user_id = ? AND id = ?').get(uid, id) as Row | undefined;
}

/* ------------------------------------------------------------------ BibTeX in and out */

/** a person as people write the name: "Ashish Vaswani" from "Vaswani, Ashish" */
export function personName(a: string): string {
  const c = cleanTex(texAccents(a)).trim();
  const parts = c.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length >= 2 ? `${parts.slice(1).join(' ')} ${parts[0]}` : c;
}

const ACCENTS: Record<string, Record<string, string>> = {
  '"': { a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü', e: 'ë', i: 'ï', y: 'ÿ' },
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', s: 'ś', z: 'ź', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', N: 'Ñ' },
  c: { c: 'ç', C: 'Ç', s: 'ş' },
  v: { c: 'č', s: 'š', z: 'ž', r: 'ř', e: 'ě', C: 'Č', S: 'Š', Z: 'Ž' },
};
/** the common LaTeX accents as letters ({\"o} → ö), before cleanTex drops the commands */
export function texAccents(s: string): string {
  return s
    .replace(/\{?\\([`'^"~])\s*\{?\\?([A-Za-z])\}?\}?/g, (m, acc, ch) => ACCENTS[acc]?.[ch] ?? m)
    .replace(/\{?\\([cv])\s*\{([A-Za-z])\}\}?/g, (m, acc, ch) => ACCENTS[acc]?.[ch] ?? m)
    .replace(/\{\\ss\}|\\ss\b\s?/g, 'ß').replace(/\{\\o\}/g, 'ø').replace(/\{\\O\}/g, 'Ø').replace(/\{\\aa\}/g, 'å').replace(/\{\\l\}/g, 'ł').replace(/\\&/g, '&');
}
const clean = (s: string | undefined) => cleanTex(texAccents(s ?? ''));

/** The entries of a BibTeX text, each as it is written (@string, @comment and @preamble left out). */
export function splitEntries(text: string): string[] {
  const out: string[] = [];
  const re = /@([a-zA-Z]{2,24})\s*([{(])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length <= IMPORT_MAX) {
    const close = m[2] === '{' ? '}' : ')';
    let depth = 0, i = re.lastIndex - 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === m[2] || (m[2] === '(' && c === '{')) depth++;
      else if (c === close || (m[2] === '(' && c === '}')) { if (--depth === 0) break; }
    }
    if (depth !== 0) break;
    if (!/^(string|comment|preamble)$/i.test(m[1])) out.push(text.slice(m.index, i + 1));
    re.lastIndex = i + 1;
  }
  return out;
}

/** where each field of an entry is: name, and the text from its name to the end of its value */
function fieldSpans(bib: string): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  const head = /^\s*@\w+\s*[{(]\s*[^,]*,/.exec(bib);
  if (!head) return out;
  let i = head[0].length;
  while (i < bib.length) {
    const m = /^\s*([A-Za-z][\w:.+-]*)\s*=\s*/.exec(bib.slice(i));
    if (!m) break;
    const start = i + m[0].length - m[0].trimStart().length;
    let j = i + m[0].length;
    // a value: {…}, "…", a bare word or number, joined with #
    for (;;) {
      if (bib[j] === '{') { for (let depth = 0; j < bib.length; j++) { if (bib[j] === '{') depth++; else if (bib[j] === '}' && --depth === 0) { j++; break; } } }
      else if (bib[j] === '"') { j++; while (j < bib.length && bib[j] !== '"') { if (bib[j] === '{') { for (let d = 0; j < bib.length; j++) { if (bib[j] === '{') d++; else if (bib[j] === '}' && --d === 0) break; } } j++; } j++; }
      else while (j < bib.length && /[\w.:+-]/.test(bib[j])) j++;
      const hash = /^\s*#\s*/.exec(bib.slice(j));
      if (!hash) break;
      j += hash[0].length;
    }
    out.push({ name: m[1].toLowerCase(), start, end: j });
    const comma = /^\s*,/.exec(bib.slice(j));
    if (!comma) break;
    i = j + comma[0].length;
  }
  return out;
}

/** a field's value as BibTeX writes it: braces, with &, % and # escaped in text (not in addresses) */
function bibValue(name: string, value: string): string {
  const v = value.replace(/[\r\n]+/g, ' ').trim();
  if (/^(url|doi|eprint|file|isbn)$/.test(name)) return `{${v.replace(/[{}]/g, '')}}`;
  return `{${v.replace(/(^|[^\\])([&%#])/g, '$1\\$2')}}`;
}

/** The entry with one field set (an empty value removes it). */
export function setBibField(bib: string, name: string, value: string): string {
  const spans = fieldSpans(bib);
  const f = spans.find(s => s.name === name.toLowerCase());
  if (f) {
    if (!value.trim()) {
      // the field and the comma before it
      const before = bib.slice(0, f.start).replace(/,\s*$/, '');
      return before + bib.slice(f.end);
    }
    return bib.slice(0, f.start) + `${name} = ${bibValue(name, value)}` + bib.slice(f.end);
  }
  if (!value.trim()) return bib;
  const end = bib.trimEnd().length - 1;   // the closing } or )
  const body = bib.slice(0, end).replace(/[\s,]*$/, '');
  return `${body},\n  ${name} = ${bibValue(name, value)}\n${bib.slice(end)}`;
}

interface Meta { type: string; title: string; authors: string[]; venue: string; year: number | null; doi: string | null; arxiv: string | null; url: string | null; abstract: string }

/** What a reference's BibTeX says about it. */
export function metaOf(e: BibEntry): Meta {
  const f = e.fields;
  const doi = (f.doi ?? '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim() || null;
  const arxiv = (/^arxiv$/i.test(f.archiveprefix ?? f.eprinttype ?? '') && f.eprint ? f.eprint.replace(/^arxiv:/i, '').replace(/v\d+$/, '') : null)
    ?? /arxiv\.org\/(?:abs|pdf)\/([\w./-]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(f.url ?? '')?.[1]
    ?? /arXiv:\s*(\d{4}\.\d{4,5})/i.exec(`${f.journal ?? ''} ${f.note ?? ''} ${f.howpublished ?? ''}`)?.[1]
    ?? (/^10\.48550\/arxiv\./i.test(doi ?? '') ? doi!.replace(/^10\.48550\/arxiv\./i, '') : null);
  const authors = (f.author ?? f.editor ?? '').split(/\s+and\s+/i).map(personName).filter(Boolean);
  return {
    type: e.type, title: clean(e.title) || '(untitled)', authors, year: Number(String(e.year).replace(/\D/g, '').slice(0, 4)) || null,
    venue: clean(f.journal ?? f.booktitle ?? f.publisher ?? f.school ?? f.institution ?? f.howpublished ?? ''),
    doi, arxiv, url: (f.url ?? '').trim() || (doi ? `https://doi.org/${doi}` : arxiv ? `https://arxiv.org/abs/${arxiv}` : null), abstract: clean(f.abstract ?? ''),
  };
}

/* ------------------------------------------------------------------ duplicates and keys */

interface DupIndex { doi: Map<string, Row>; arxiv: Map<string, Row>; title: Map<string, Row[]>; keys: Set<string> }

function dupIndex(uid: number): DupIndex {
  const idx: DupIndex = { doi: new Map(), arxiv: new Map(), title: new Map(), keys: new Set() };
  for (const r of db.prepare('SELECT * FROM library_refs WHERE user_id = ?').all(uid) as Row[]) remember(idx, r);
  return idx;
}
function remember(idx: DupIndex, r: Row): void {
  if (r.doi) idx.doi.set(r.doi.toLowerCase(), r);
  if (r.arxiv) idx.arxiv.set(r.arxiv.toLowerCase(), r);
  const t = normTitle(r.title);
  if (t) idx.title.set(t, [...(idx.title.get(t) ?? []), r]);
  idx.keys.add(r.key);
}
/** the reference that is this paper already: same DOI, same arXiv id, or same title within a year */
function duplicateOf(idx: DupIndex, m: Meta): Row | undefined {
  if (m.doi && idx.doi.has(m.doi.toLowerCase())) return idx.doi.get(m.doi.toLowerCase());
  if (m.arxiv && idx.arxiv.has(m.arxiv.toLowerCase())) return idx.arxiv.get(m.arxiv.toLowerCase());
  const t = normTitle(m.title);
  if (!t || t === 'untitled') return undefined;
  return idx.title.get(t)?.find(r => !m.year || !r.year || Math.abs(r.year - m.year) <= 1);
}
function uniqueKey(keys: Set<string>, base: string): string {
  if (!keys.has(base)) return base;
  for (let i = 0; i < 26; i++) { const k = base + 'abcdefghijklmnopqrstuvwxyz'[i]; if (!keys.has(k)) return k; }
  let n = 2;
  while (keys.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** Add one BibTeX entry, or say which reference has the paper already. */
function addEntry(uid: number, idx: DupIndex, bib: string, extra: { tags?: string[]; abstract?: string; source: string }): { ref: Row; duplicate: boolean } {
  if (bib.length > BIB_MAX) throw new Error('This BibTeX entry is too long');
  const e = parseBibtex(bib)[0];
  if (!e) throw new Error('That is not a BibTeX entry (it should start with @article{…, @inproceedings{…, …)');
  const m = metaOf(e);
  const dup = duplicateOf(idx, m);
  if (dup) return { ref: dup, duplicate: true };
  const key = uniqueKey(idx.keys, scholarKey(e));
  const now = Date.now();
  const tags = [...new Set((extra.tags ?? []).map(t => t.trim()).filter(Boolean))].slice(0, 30);
  const info = db.prepare(`INSERT INTO library_refs (user_id, key, type, title, authors, venue, year, doi, arxiv, url, abstract, tags, note, bibtex, pdf_size, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, NULL, ?, ?, ?)`)
    .run(uid, key, m.type, m.title, JSON.stringify(m.authors), m.venue, m.year, m.doi, m.arxiv, m.url, (m.abstract || extra.abstract || '').slice(0, 20000), JSON.stringify(tags), rewriteEntry(bib, key).trim(), extra.source, now, now);
  const ref = getRef(uid, Number(info.lastInsertRowid))!;
  remember(idx, ref);
  return { ref, duplicate: false };
}

export interface AddOutcome { added: LibRef[]; duplicates: LibRef[]; failed: string[] }

/** BibTeX text — one entry or a whole .bib file. */
export function addBibtex(uid: number, text: string, source = 'bibtex'): AddOutcome {
  const out: AddOutcome = { added: [], duplicates: [], failed: [] };
  const entries = splitEntries(text);
  if (!entries.length) throw new Error('No BibTeX entry found (an entry starts with @article{…, @book{…, …)');
  if (entries.length > IMPORT_MAX) throw new Error(`At most ${IMPORT_MAX} entries at a time`);
  const idx = dupIndex(uid);
  db.transaction(() => {
    for (const bib of entries) {
      try {
        const r = addEntry(uid, idx, bib, { source });
        (r.duplicate ? out.duplicates : out.added).push(pub(r.ref));
      } catch (e) { out.failed.push(`${/^@\w+\s*[{(]\s*([^,\s]*)/.exec(bib)?.[1] || 'an entry'}: ${(e as Error).message}`); }
    }
  })();
  return out;
}

/** A paper found by a lookup (a hit of the citation dialog's kind): its best BibTeX. */
export async function addHit(uid: number, hit: Hit): Promise<{ ref: LibRef; duplicate: boolean }> {
  const idx = dupIndex(uid);
  // a hit names its paper already: no need to fetch BibTeX for one the library has
  const known = duplicateOf(idx, { type: hit.type, title: hit.title, authors: hit.authors, venue: hit.venue, year: hit.year, doi: hit.doi, arxiv: hit.arxiv, url: hit.url, abstract: '' });
  if (known) return { ref: pub(known), duplicate: true };
  const bib = await bibtexFor(hit);
  const r = addEntry(uid, idx, bib, { source: hit.sources?.[0] ?? 'lookup' });
  return { ref: pub(r.ref), duplicate: r.duplicate };
}

/** Identifiers or links, one per line: each looked up, its first paper added. */
export async function addIdentifiers(uid: number, text: string): Promise<AddOutcome> {
  const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const out: AddOutcome = { added: [], duplicates: [], failed: [] };
  for (const line of lines.slice(0, 20)) {
    const link = identify(line);
    if (!link) { out.failed.push(`${line.slice(0, 80)}: not a DOI, arXiv id, ISBN or a paper's link`); continue; }
    take(uid);
    const r = await resolveLink(link);
    const hit = r.hits[0];
    if (!hit) { out.failed.push(r.warnings[0] ?? `${line.slice(0, 80)}: nothing found`); continue; }
    try { const a = await addHit(uid, hit); (a.duplicate ? out.duplicates : out.added).push(a.ref); }
    catch (e) { out.failed.push(`${line.slice(0, 80)}: ${(e as Error).message}`); }
  }
  return out;
}

/** Everything in the connected Zotero library (its own items and the groups the key reads). */
export async function importZotero(uid: number): Promise<AddOutcome> {
  const items = await zoteroLibraryItems(uid, IMPORT_MAX);
  if (!items) throw new Error('Connect Zotero first (Settings ▸ Account ▸ Zotero)');
  const out: AddOutcome = { added: [], duplicates: [], failed: [] };
  const idx = dupIndex(uid);
  db.transaction(() => {
    for (const it of items) {
      if (!it.hit.bibtex) { out.failed.push(`${it.hit.title.slice(0, 80)}: Zotero gave no BibTeX`); continue; }
      try {
        const r = addEntry(uid, idx, it.hit.bibtex, { tags: it.tags, abstract: it.abstract, source: 'zotero' });
        (r.duplicate ? out.duplicates : out.added).push(pub(r.ref));
      } catch (e) { out.failed.push(`${it.hit.title.slice(0, 80)}: ${(e as Error).message}`); }
    }
  })();
  return out;
}

/** Edit a reference: its fields (written into its BibTeX), tags, note, key — or the BibTeX itself. */
export function editRef(uid: number, id: number, body: Record<string, unknown>): LibRef {
  const r = getRef(uid, id);
  if (!r) throw Object.assign(new Error('No such reference'), { status: 404 });
  let bib = r.bibtex;
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).slice(0, k === 'abstract' || k === 'note' ? 20000 : 2000) : undefined);
  if (typeof body.bibtex === 'string') {
    const one = splitEntries(body.bibtex);
    if (one.length !== 1 || !parseBibtex(one[0])[0]) throw new Error('Give one BibTeX entry');
    if (one[0].length > BIB_MAX) throw new Error('This BibTeX entry is too long');
    bib = rewriteEntry(one[0], r.key).trim();
  } else {
    const FIELDS: [string, string][] = [['title', 'title'], ['year', 'year'], ['doi', 'doi'], ['url', 'url'], ['abstract', 'abstract']];
    for (const [k, field] of FIELDS) { const v = str(k); if (v !== undefined) bib = setBibField(bib, field, v); }
    if (Array.isArray(body.authors)) bib = setBibField(bib, 'author', (body.authors as unknown[]).map(a => String(a).trim()).filter(Boolean).join(' and '));
    const venue = str('venue');
    if (venue !== undefined) {
      const e = parseBibtex(bib)[0];
      const field = e?.fields.journal !== undefined ? 'journal' : e?.fields.booktitle !== undefined ? 'booktitle' : e?.type === 'article' ? 'journal' : e?.type === 'inproceedings' ? 'booktitle' : 'howpublished';
      bib = setBibField(bib, field, venue);
    }
    const arxiv = str('arxiv');
    if (arxiv !== undefined) { bib = setBibField(bib, 'eprint', arxiv); bib = setBibField(bib, 'archiveprefix', arxiv ? 'arXiv' : ''); }
    const type = str('type');
    if (type && /^[a-z]{2,24}$/i.test(type)) bib = bib.replace(/^(\s*)@\w+/, `$1@${type.toLowerCase()}`);
  }
  let key = r.key;
  const k = str('key')?.trim();
  if (k !== undefined && k !== r.key) {
    if (!/^[A-Za-z0-9_:.+/-]{1,80}$/.test(k)) throw new Error('A key is letters, digits and _ : . + / - (no spaces)');
    if (db.prepare('SELECT 1 FROM library_refs WHERE user_id = ? AND key = ? AND id != ?').get(uid, k, id)) throw new Error(`Another reference has the key ${k}`);
    key = k;
    bib = rewriteEntry(bib, key).trim();
  }
  const e = parseBibtex(bib)[0];
  if (!e) throw new Error('The BibTeX entry could not be read after this change');
  const m = metaOf(e);
  const tags = Array.isArray(body.tags) ? JSON.stringify([...new Set((body.tags as unknown[]).map(t => String(t).trim()).filter(Boolean))].slice(0, 30)) : r.tags;
  const note = str('note') ?? r.note;
  db.prepare('UPDATE library_refs SET key = ?, type = ?, title = ?, authors = ?, venue = ?, year = ?, doi = ?, arxiv = ?, url = ?, abstract = ?, tags = ?, note = ?, bibtex = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(key, m.type, m.title, JSON.stringify(m.authors), m.venue, m.year, m.doi, m.arxiv, m.url, m.abstract || (typeof body.abstract === 'string' ? '' : r.abstract), tags, note, bib, Date.now(), id, uid);
  return pub(getRef(uid, id)!, true);
}

export function deleteRef(uid: number, id: number): void {
  db.prepare('DELETE FROM library_refs WHERE user_id = ? AND id = ?').run(uid, id);
  fs.rmSync(pdfPath(uid, id), { force: true });
}

/** The account's library goes with the account (accounts.ts). */
export function forgetLibrary(uid: number): void {
  db.prepare('DELETE FROM library_refs WHERE user_id = ?').run(uid);
  fs.rmSync(pdfDir(uid), { recursive: true, force: true });
}

/**
 * A reference's BibTeX as a project gets it (index.ts /bib/add `library`): without the abstract,
 * keywords, file links or notes. Null when the account has no such reference.
 */
export function bibtexForProject(uid: number, id: number): { bibtex: string; key: string } | null {
  const r = getRef(uid, id);
  return r ? { bibtex: slimBibtex(r.bibtex), key: r.key } : null;
}

/* ------------------------------------------------------------------ PDFs */

function pdfBytes(uid: number): number {
  return (db.prepare('SELECT COALESCE(SUM(pdf_size), 0) AS n FROM library_refs WHERE user_id = ?').get(uid) as { n: number }).n;
}

export function attachPdf(uid: number, id: number, buf: Buffer): LibRef {
  const r = getRef(uid, id);
  if (!r) throw Object.assign(new Error('No such reference'), { status: 404 });
  if (buf.subarray(0, 1024).indexOf('%PDF-') < 0) throw new Error('That file is not a PDF');
  if (buf.length > PDF_MAX) throw Object.assign(new Error(`A PDF may be ${PDF_MAX / 1024 / 1024} MB at most`), { status: 413 });
  if (pdfBytes(uid) - (r.pdf_size ?? 0) + buf.length > ACCOUNT_MAX) throw Object.assign(new Error(`Your library's PDFs would take more than ${ACCOUNT_MAX / 1024 ** 3} GB — remove some first`), { status: 413 });
  fs.mkdirSync(pdfDir(uid), { recursive: true });
  const tmp = pdfPath(uid, id) + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, pdfPath(uid, id));
  db.prepare('UPDATE library_refs SET pdf_size = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(buf.length, Date.now(), id, uid);
  return pub(getRef(uid, id)!);
}

/** The text a content stream shows: its literal strings, words apart where the stream moves on. */
function contentText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') {
      let depth = 1, j = i + 1, str = '';
      for (; j < s.length && depth; j++) {
        const d = s[j];
        if (d === '\\') {
          const oct = /^[0-7]{1,3}/.exec(s.slice(j + 1, j + 4));
          if (oct) { str += String.fromCharCode(parseInt(oct[0], 8)); j += oct[0].length; }
          else { const n = s[++j] ?? ''; str += n === 'n' || n === 'r' ? ' ' : n; }
          continue;
        }
        if (d === '(') depth++;
        else if (d === ')' && --depth === 0) break;
        str += d;
      }
      out += str;
      i = j;
    } else if (c === ']' || c === '\n') out += ' ';
    else if (c === '-' && /^-\d{3,}/.test(s.slice(i, i + 5))) out += ' ';
    else if (c === 'T' && /^T[jJ*dDm]/.test(s.slice(i, i + 2)) && s[i + 1] !== 'J') out += ' ';
  }
  return out;
}

const DOI_IN = /\b(10\.\d{4,9}\/[^\s"'<>()[\]{}]+[^\s"'<>()[\]{}.,;:])/;
const ARXIV_IN = /arXiv:\s?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/;
const ARXIV_LINK = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/;

/**
 * The identifiers a PDF names about itself: the DOI its metadata (XMP, the info dictionary) or its
 * first pages carry, arXiv's stamp along a preprint's margin, the title its metadata gives. Read
 * from the file's own bytes — the uncompressed parts and the first Flate streams — with no tool run.
 */
export function pdfIdentifiers(buf: Buffer): { doi?: string; arxiv?: string; title?: string } {
  const head = buf.subarray(0, Math.min(buf.length, 2 * 1024 * 1024)).toString('latin1');
  const found: { doi?: string; arxiv?: string; title?: string } = {};
  const meta = (/<prism:doi>\s*([^<]+)</i.exec(head)?.[1] ?? /<dc:identifier>[\s\S]{0,200}?(?:doi:)?(10\.\d{4,9}\/[^<\s]+)/i.exec(head)?.[1] ?? /\/doi\s*\((10\.[^)]+)\)/i.exec(head)?.[1]);
  if (meta) found.doi = meta.trim();
  const t = /\/Title\s*\(((?:[^()\\]|\\.){4,300})\)/.exec(head)?.[1] ?? /<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]{4,300})</.exec(head)?.[1];
  if (t && !/^(untitled|microsoft word|title)/i.test(t.trim()) && !/\.(docx?|tex|dvi)$/i.test(t.trim())) found.title = t.replace(/\\(.)/g, '$1').trim();
  const texts: string[] = [head];
  let pos = 0, streams = 0, total = 0;
  while (streams < 80 && total < 8 * 1024 * 1024) {
    const s = buf.indexOf('stream', pos, 'latin1');
    if (s < 0) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf('endstream', start, 'latin1');
    if (e < 0) break;
    pos = e + 9;
    const dict = buf.subarray(Math.max(0, s - 500), s).toString('latin1');
    const d = dict.slice(dict.lastIndexOf('obj') + 1);
    if (!/FlateDecode/.test(d) || /\/Subtype\s*\/Image|\/Length[123]\b|\/DCTDecode|\/JPXDecode/.test(d)) continue;
    try {
      const raw = zlib.inflateSync(buf.subarray(start, e), { maxOutputLength: 4 * 1024 * 1024 }).toString('latin1');
      streams++; total += raw.length;
      texts.push(raw, contentText(raw));
    } catch { /* not a stream we can read */ }
  }
  const all = texts.join('\n');
  found.arxiv = ARXIV_IN.exec(all)?.[1] ?? ARXIV_LINK.exec(all)?.[1];
  if (!found.doi) {
    // a DOI written as a link (doi.org/…) is the paper's own more often than one in the references
    const linked = /(?:doi\.org\/|doi:\s?)(10\.\d{4,9}\/[^\s"'<>()[\]{}]+[^\s"'<>()[\]{}.,;:])/i.exec(all)?.[1];
    found.doi = linked ?? DOI_IN.exec(all)?.[1];
  }
  if (found.doi) found.doi = found.doi.replace(/(?:\/full|\/abstract|\/pdf|\.pdf)$/i, '');
  if (found.arxiv && found.doi && !/^10\.48550\//.test(found.doi) && !meta) delete found.doi;   // a preprint's stamp beats a DOI from its references
  return found;
}

/** A reference from a dropped PDF: its DOI or arXiv id looked up, else its title; the PDF attached. */
export async function addFromPdf(uid: number, buf: Buffer, fileName: string): Promise<{ ref: LibRef; duplicate: boolean; found: 'doi' | 'arxiv' | 'title' | null }> {
  if (buf.subarray(0, 1024).indexOf('%PDF-') < 0) throw new Error('That file is not a PDF');
  if (buf.length > PDF_MAX) throw Object.assign(new Error(`A PDF may be ${PDF_MAX / 1024 / 1024} MB at most`), { status: 413 });
  const ids = pdfIdentifiers(buf);
  let hit: Hit | null = null, found: 'doi' | 'arxiv' | 'title' | null = null;
  if (config.literature) {
    try {
      take(uid);
      if (ids.arxiv) { hit = (await resolveLink({ kind: 'arxiv', id: ids.arxiv })).hits.at(-1) ?? null; found = hit ? 'arxiv' : null; }
      if (!hit && ids.doi) { hit = await hitFromDoi(ids.doi); found = hit ? 'doi' : null; }
      if (!hit && ids.title && ids.title.split(/\s+/).length >= 3) {
        const r = await searchLiterature(ids.title, 3);
        hit = r.hits.find(h => normTitle(h.title) === normTitle(ids.title!)) ?? null;
        found = hit ? 'title' : null;
      }
    } catch { hit = null; found = null; }
  }
  let res: { ref: LibRef; duplicate: boolean };
  if (hit) res = await addHit(uid, hit);
  else {
    const title = (ids.title || fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ')).replace(/[{}\\]/g, '').slice(0, 300) || 'Untitled PDF';
    const r = addEntry(uid, dupIndex(uid), `@misc{tmp,\n  title = {${title}}${ids.doi ? `,\n  doi = {${ids.doi}}` : ''}${ids.arxiv ? `,\n  eprint = {${ids.arxiv}},\n  archiveprefix = {arXiv}` : ''}\n}`, { source: 'pdf' });
    res = { ref: pub(r.ref), duplicate: r.duplicate };
  }
  // the PDF goes to the reference — a duplicate's too, unless it has one already
  const ref = res.duplicate && res.ref.pdf ? res.ref : attachPdf(uid, res.ref.id, buf);
  return { ref, duplicate: res.duplicate, found };
}

/* ------------------------------------------------------------------ lookups, politely */

/** lookups an account may start per minute (Crossref, arXiv and the others ask servers to go easy) */
const LOOKUPS_PER_MIN = 40;
const lookups = new Map<number, number[]>();
function take(uid: number): void {
  const now = Date.now();
  const recent = (lookups.get(uid) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= LOOKUPS_PER_MIN) throw Object.assign(new Error('Too many lookups in a minute — wait a moment'), { status: 429 });
  recent.push(now);
  lookups.set(uid, recent);
}

/* ------------------------------------------------------------------ routes */

const fail = (res: express.Response, e: unknown) => {
  const status = (e as { status?: number }).status ?? 400;
  res.status(status).json({ error: (e as Error).message });
};

export function libraryRoutes(): express.Router {
  const r = express.Router();
  // a library is its owner's: guests have none
  r.use('/library', (req, res, next) => { if (req.user!.guest) { res.status(403).json({ error: 'Sign in to keep a library' }); return; } next(); });
  const pdfBody = express.raw({ type: () => true, limit: PDF_MAX + 1024 });

  r.get('/library', (req, res) => {
    const uid = req.user!.id;
    const rows = db.prepare('SELECT * FROM library_refs WHERE user_id = ? ORDER BY created_at DESC').all(uid) as Row[];
    const tags = new Map<string, number>();
    for (const row of rows) for (const t of JSON.parse(row.tags) as string[]) tags.set(t, (tags.get(t) ?? 0) + 1);
    res.json({ refs: rows.map(x => pub(x)), tags: [...tags].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })), pdfBytes: pdfBytes(uid), pdfMax: ACCOUNT_MAX, zotero: zoteroStatus(uid).connected, lookups: config.literature });
  });
  r.get('/library/lookup', async (req, res) => {
    if (!config.literature) { res.status(503).json({ error: 'Looking papers up is switched off on this server (OVERLYX_LITERATURE=off) — paste BibTeX instead' }); return; }
    const q = String(req.query.q ?? '').trim().slice(0, 300);
    if (q.length < 3) { res.json({ hits: [], warnings: [] }); return; }
    try { take(req.user!.id); res.json(await searchLiterature(q, 8)); } catch (e) { fail(res, e); }
  });
  r.post('/library', async (req, res) => {
    const uid = req.user!.id;
    try {
      if (req.body?.hit && typeof req.body.hit === 'object') {
        if (!config.literature) throw new Error('Looking papers up is switched off on this server');
        const a = await addHit(uid, req.body.hit as Hit);
        res.json({ added: a.duplicate ? [] : [a.ref], duplicates: a.duplicate ? [a.ref] : [], failed: [] } satisfies AddOutcome);
        return;
      }
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      if (!text.trim()) throw new Error('Paste a DOI, an arXiv id, an ISBN, a paper’s link or BibTeX');
      if (/@[a-zA-Z]{2,24}\s*[{(]/.test(text)) { res.json(addBibtex(uid, text, req.body?.source === 'file' ? 'bib-file' : 'bibtex')); return; }
      if (!config.literature) throw new Error('Looking papers up is switched off on this server — paste BibTeX instead');
      res.json(await addIdentifiers(uid, text));
    } catch (e) { fail(res, e); }
  });
  r.post('/library/zotero', async (req, res) => {
    try {
      const out = await importZotero(req.user!.id);
      console.log(`[library] ${req.user!.username}: Zotero import — ${out.added.length} added, ${out.duplicates.length} there already, ${out.failed.length} not read`);
      res.json(out);
    } catch (e) { fail(res, e); }
  });
  r.post('/library/pdf', pdfBody, async (req, res) => {
    try {
      const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'paper.pdf')).slice(0, 200);
      res.json(await addFromPdf(req.user!.id, req.body as Buffer, name));
    } catch (e) { fail(res, e); }
  });
  r.get('/library/export.bib', (req, res) => {
    const rows = db.prepare('SELECT bibtex FROM library_refs WHERE user_id = ? ORDER BY key').all(req.user!.id) as { bibtex: string }[];
    res.setHeader('content-type', 'application/x-bibtex; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="library.bib"');
    res.send(rows.map(x => x.bibtex.trim()).join('\n\n') + '\n');
  });
  r.get('/library/:id(\\d+)', (req, res) => {
    const row = getRef(req.user!.id, Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'No such reference' }); return; }
    res.json(pub(row, true));
  });
  r.patch('/library/:id(\\d+)', (req, res) => {
    try { res.json(editRef(req.user!.id, Number(req.params.id), req.body ?? {})); } catch (e) { fail(res, e); }
  });
  r.delete('/library/:id(\\d+)', (req, res) => { deleteRef(req.user!.id, Number(req.params.id)); res.json({ ok: true }); });
  r.put('/library/:id(\\d+)/pdf', pdfBody, (req, res) => {
    try { res.json(attachPdf(req.user!.id, Number(req.params.id), req.body as Buffer)); } catch (e) { fail(res, e); }
  });
  r.get('/library/:id(\\d+)/pdf', (req, res) => {
    const uid = req.user!.id, row = getRef(uid, Number(req.params.id));
    if (!row || row.pdf_size == null || !fs.existsSync(pdfPath(uid, row.id))) { res.status(404).json({ error: 'No PDF' }); return; }
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${row.key.replace(/[^\w.-]/g, '_')}.pdf"`);
    res.setHeader('cache-control', 'private, max-age=0');
    fs.createReadStream(pdfPath(uid, row.id)).pipe(res);
  });
  r.delete('/library/:id(\\d+)/pdf', (req, res) => {
    const uid = req.user!.id, id = Number(req.params.id);
    if (!getRef(uid, id)) { res.status(404).json({ error: 'No such reference' }); return; }
    fs.rmSync(pdfPath(uid, id), { force: true });
    db.prepare('UPDATE library_refs SET pdf_size = NULL, updated_at = ? WHERE id = ? AND user_id = ?').run(Date.now(), id, uid);
    res.json(pub(getRef(uid, id)!));
  });
  return r;
}
