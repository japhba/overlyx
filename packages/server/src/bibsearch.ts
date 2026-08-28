/**
 * Literature search for the citation dialog, and adding entries to the project's `cited.bib`.
 *
 * Google Scholar has no API and blocks servers within minutes, so the search runs against the open
 * indexes that cover the same literature: OpenAlex (everything incl. arXiv, with citation counts) and
 * DBLP (computer science, with excellent BibTeX). A DOI, an arXiv id or a URL of either is looked up
 * directly. BibTeX comes from DBLP when it has the record, else from doi.org content negotiation
 * (Crossref / DataCite), else it is generated from the metadata. Keys are rewritten Scholar-style
 * (`vaswani2017attention`) and made unique within the project; an entry whose DOI or title is already
 * in one of the project's .bib files is not added twice — its existing key is returned.
 *
 * Nothing about the user leaves the server: the queries go out with a generic user agent
 * (OVERLYX_CONTACT_EMAIL, if set, joins the "polite pools" of OpenAlex/Crossref for better rate limits).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseBibtex, cleanTex, type BibEntry } from '@overlyx/core';
import { config } from './config.ts';

export interface Hit {
  /** stable id for the client (doi, dblp key or openalex id) */
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  type: string;
  doi: string | null;
  arxiv: string | null;
  url: string | null;
  citations: number | null;
  sources: string[];
  /** DBLP record key when DBLP knows the paper (its .bib is the best BibTeX around) */
  dblp?: string;
  /** BibTeX the index handed over with the hit (Semantic Scholar) */
  bibtex?: string;
  /** Google Scholar result id (SerpApi) — its "cite" endpoint gives the BibTeX */
  scholarId?: string;
}

/** Which indexes this server can use, best first (the dialog shows them). */
export function sourcesAvailable(): string[] {
  const out: string[] = [];
  if (config.serpApiKey) out.push('Google Scholar');
  if (config.s2ApiKey) out.push('Semantic Scholar');
  out.push('OpenAlex', 'DBLP', 'doi.org');
  return out;
}

const UA = 'OverLyX/0.1 (https://github.com/japhba/overlyx' + (config.contactEmail ? `; mailto:${config.contactEmail}` : '') + ')';
const TIMEOUT = 9000;

/** injectable for tests */
export let fetchImpl: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': UA, ...(init?.headers as Record<string, string> | undefined) } });
export function setFetch(f: typeof fetch): void { fetchImpl = f; }

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;
const ARXIV_RE = /(?:arxiv[:\s]*|arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i;

export function parseQuery(q: string): { kind: 'doi'; doi: string } | { kind: 'arxiv'; id: string } | { kind: 'text'; text: string } {
  const t = q.trim();
  const d = DOI_RE.exec(t);
  if (d && (t.length - d[1].length < 40)) return { kind: 'doi', doi: d[1].replace(/[.,;)]+$/, '') };
  const a = ARXIV_RE.exec(t);
  if (a && /^(arxiv|\d|https?:\/\/(www\.)?arxiv\.org)/i.test(t)) return { kind: 'arxiv', id: a[1] };
  return { kind: 'text', text: t };
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const normTitle = (s: string) => cleanTex(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * OpenAlex, scoped to titles + abstracts (`search=` would match full text: a mean-field query then
 * returns LeCun 1998). `mode` 'title' is the razor-precise variant, used alongside.
 */
async function openalex(q: string, limit: number, mode: 'title' | 'title_and_abstract' = 'title_and_abstract'): Promise<Hit[]> {
  const url = `https://api.openalex.org/works?filter=${mode}.search:${encodeURIComponent(q)}&per-page=${limit}&select=id,doi,display_name,publication_year,authorships,primary_location,cited_by_count,type,ids${config.contactEmail ? '&mailto=' + encodeURIComponent(config.contactEmail) : ''}`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`OpenAlex ${r.status}`);
  const d: any = await r.json();
  return (d.results ?? []).map((w: any): Hit => {
    const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, '') : null;
    const arxiv = doi && /^10\.48550\/arxiv\./i.test(doi) ? doi.replace(/^10\.48550\/arxiv\./i, '') : null;
    return {
      id: doi ?? String(w.id ?? ''), title: w.display_name ?? '', authors: (w.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
      year: w.publication_year ?? null, venue: w.primary_location?.source?.display_name ?? '', type: w.type ?? '',
      doi, arxiv, url: doi ? `https://doi.org/${doi}` : (w.primary_location?.landing_page_url ?? null), citations: w.cited_by_count ?? null, sources: ['openalex'],
    };
  });
}

async function dblp(q: string, limit: number): Promise<Hit[]> {
  const r = await fetchImpl(`https://dblp.org/search/publ/api?q=${encodeURIComponent(q)}&format=json&h=${limit}`);
  if (!r.ok) throw new Error(`DBLP ${r.status}`);
  const d: any = await r.json();
  const hits = d?.result?.hits?.hit ?? [];
  return hits.map((h: any): Hit => {
    const info = h.info ?? {};
    const authors = Array.isArray(info.authors?.author) ? info.authors.author : info.authors?.author ? [info.authors.author] : [];
    const doi = info.doi ? String(info.doi).toLowerCase() : null;
    return {
      id: doi ?? `dblp:${info.key}`, title: stripHtml(String(info.title ?? '')).replace(/\.$/, ''), authors: authors.map((a: any) => stripHtml(String(a.text ?? a))), year: info.year ? Number(info.year) : null,
      venue: info.venue ?? '', type: info.type ?? '', doi, arxiv: doi && /^10\.48550\/arxiv\./i.test(doi) ? doi.replace(/^10\.48550\/arxiv\./i, '') : null,
      url: info.ee ?? (doi ? `https://doi.org/${doi}` : null), citations: null, sources: ['dblp'], dblp: info.key,
    };
  });
}

/**
 * Merge results of several indexes: same DOI or same title → one hit (DBLP's key, Scholar's id, the
 * BibTeX and the citation count are kept from whichever index had them). `lists` are ordered by
 * trust: the order of the first list that has a paper is its rank; a "Scholar-grade" first list
 * (Google Scholar, Semantic Scholar) dominates the ranking, the open indexes only fill in.
 */
export function mergeHits(lists: Hit[][], q: string, limit: number, opts: { trusted?: boolean } = {}): Hit[] {
  const out: Hit[] = [];
  const rank = new Map<Hit, number>(), origin = new Map<Hit, number>();
  const byDoi = new Map<string, Hit>(), byTitle = new Map<string, Hit>();
  lists.forEach((list, li) => list.forEach((h, i) => {
    const doi = h.doi?.toLowerCase(), t = normTitle(h.title);
    const dup = (doi && byDoi.get(doi)) || (t && byTitle.get(t));
    if (dup) {
      dup.sources = [...new Set([...dup.sources, ...h.sources])];
      dup.dblp = dup.dblp ?? h.dblp; dup.citations = dup.citations ?? h.citations; dup.doi = dup.doi ?? h.doi; dup.arxiv = dup.arxiv ?? h.arxiv;
      dup.venue = dup.venue || h.venue; dup.year = dup.year ?? h.year; dup.url = dup.url ?? h.url; dup.bibtex = dup.bibtex ?? h.bibtex; dup.scholarId = dup.scholarId ?? h.scholarId;
      if (!dup.authors.length) dup.authors = h.authors;
      if (doi && !byDoi.has(doi)) byDoi.set(doi, dup);
      if (t && !byTitle.has(t)) byTitle.set(t, dup);
      return;
    }
    out.push(h); rank.set(h, i); origin.set(h, li);
    if (doi) byDoi.set(doi, h);
    if (t) byTitle.set(t, h);
  }));
  const words = normTitle(q).split(' ').filter(w => w.length > 2);
  const score = (h: Hit) => {
    const t = normTitle(h.title);
    const hitWords = words.filter(w => t.includes(w)).length;
    const cites = Math.log10((h.citations ?? 0) + 1), pos = rank.get(h) ?? 0, both = h.sources.length > 1;
    // a trusted first index: keep its order, everything it did not list goes below
    if (opts.trusted) return (origin.get(h) === 0 ? 10000 - pos * 10 : 0) + hitWords * 2 + cites;
    // open indexes: a title containing every query word first (the well-known one on top), then their own
    // relevance order (a paper both list goes up); citations only break ties
    if (words.length && hitWords === words.length) return 1000 + cites * 10 - pos * 2 + (both ? 6 : 0);
    return hitWords * 5 - pos * 10 + (both ? 5 : 0) + cites;
  };
  return out.sort((a, b) => score(b) - score(a)).slice(0, limit);
}

/** Semantic Scholar (needs S2_API_KEY): relevance close to Google Scholar's, BibTeX included. */
async function semanticScholar(q: string, limit: number): Promise<Hit[]> {
  const r = await fetchImpl(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${limit}&fields=title,authors,year,venue,externalIds,citationCount,publicationTypes,citationStyles`, { headers: { 'x-api-key': config.s2ApiKey } });
  if (!r.ok) throw new Error(`Semantic Scholar ${r.status}`);
  const d: any = await r.json();
  return (d.data ?? []).map((p: any): Hit => {
    const ids = p.externalIds ?? {};
    const doi = ids.DOI ? String(ids.DOI) : null;
    return {
      id: doi ?? `s2:${p.paperId}`, title: p.title ?? '', authors: (p.authors ?? []).map((a: any) => a.name).filter(Boolean), year: p.year ?? null,
      venue: p.venue ?? '', type: (p.publicationTypes ?? []).join(','), doi, arxiv: ids.ArXiv ?? null,
      url: doi ? `https://doi.org/${doi}` : (ids.ArXiv ? `https://arxiv.org/abs/${ids.ArXiv}` : `https://www.semanticscholar.org/paper/${p.paperId}`),
      citations: p.citationCount ?? null, sources: ['semanticscholar'], dblp: ids.DBLP ?? undefined, bibtex: p.citationStyles?.bibtex ?? undefined,
    };
  });
}

/** Google Scholar through SerpApi (needs SERPAPI_KEY): the real thing, incl. "cited by" counts. */
async function googleScholar(q: string, limit: number): Promise<Hit[]> {
  const r = await fetchImpl(`https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(q)}&num=${Math.min(20, limit)}&hl=en&api_key=${encodeURIComponent(config.serpApiKey)}`);
  if (!r.ok) throw new Error(`Google Scholar (SerpApi) ${r.status}`);
  const d: any = await r.json();
  if (d.error) throw new Error(`Google Scholar (SerpApi): ${d.error}`);
  return (d.organic_results ?? []).map((o: any): Hit => {
    const info = o.publication_info ?? {};
    // "A Vaswani, N Shazeer, N Parmar… - Advances in neural information…, 2017 - proceedings.neurips.cc"
    const parts = String(info.summary ?? '').split(' - ');
    const authors = (info.authors ?? []).map((a: any) => a.name).filter(Boolean);
    const summaryAuthors = parts.length > 1 ? parts[0].split(',').map((x: string) => x.replace(/…$/, '').trim()).filter(Boolean) : [];
    const venueYear = parts.length > 1 ? parts[1] : '';
    const ym = /(\d{4})\s*$/.exec(venueYear);
    const link = String(o.link ?? '');
    const arxiv = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/.exec(link)?.[1] ?? null;
    const doi = DOI_RE.exec(link)?.[1] ?? null;
    return {
      id: `scholar:${o.result_id}`, title: String(o.title ?? '').replace(/^\[[A-Z]+\]\s*/, ''), authors: authors.length ? authors : summaryAuthors,
      year: ym ? Number(ym[1]) : null, venue: venueYear.replace(/,?\s*\d{4}\s*$/, '').replace(/…$/, '').trim(), type: o.type ?? '',
      doi, arxiv, url: link || null, citations: o.inline_links?.cited_by?.total ?? null, sources: ['scholar'], scholarId: o.result_id,
    };
  });
}

/** Scholar's own BibTeX for a result (SerpApi's google_scholar_cite gives the link; Scholar serves the file). */
async function bibtexFromScholar(resultId: string): Promise<string | null> {
  try {
    const r = await fetchImpl(`https://serpapi.com/search.json?engine=google_scholar_cite&q=${encodeURIComponent(resultId)}&api_key=${encodeURIComponent(config.serpApiKey)}`);
    if (!r.ok) return null;
    const d: any = await r.json();
    const link = (d.links ?? []).find((l: any) => /bibtex/i.test(l.name))?.link;
    if (!link) return null;
    const b = await fetchImpl(link);
    if (!b.ok) return null;
    const t = (await b.text()).trim();
    return t.startsWith('@') ? t : null;
  } catch { return null; }
}

/** Search the open indexes (or look a DOI / arXiv id up); failures of one index are ignored. */
export async function searchLiterature(q: string, limit = 10): Promise<Hit[]> {
  const p = parseQuery(q);
  if (p.kind === 'doi') { const h = await hitFromDoi(p.doi); return h ? [h] : []; }
  if (p.kind === 'arxiv') { const h = await hitFromDoi(`10.48550/arXiv.${p.id}`); return h ? [h] : []; }
  if (!p.text) return [];
  // a Scholar-grade index first when a key is configured; the open ones fill in DOIs, DBLP keys, BibTeX
  const trusted = config.serpApiKey ? googleScholar(p.text, limit) : config.s2ApiKey ? semanticScholar(p.text, limit) : null;
  const settled = await Promise.allSettled([...(trusted ? [trusted] : []), openalex(p.text, limit, 'title'), openalex(p.text, limit), dblp(p.text, limit)]);
  const lists = settled.map(s => (s.status === 'fulfilled' ? s.value : []));
  if (settled.every(s => s.status === 'rejected')) throw new Error('Literature search is unavailable right now: ' + settled.map(s => (s as PromiseRejectedResult).reason?.message).join('; '));
  if (trusted && settled[0].status === 'rejected') console.warn('[bibsearch]', (settled[0] as PromiseRejectedResult).reason?.message);
  return mergeHits(lists, p.text, limit, { trusted: !!trusted && settled[0].status === 'fulfilled' });
}

async function hitFromDoi(doi: string): Promise<Hit | null> {
  const bib = await bibtexFromDoi(doi);
  if (!bib) return null;
  const e = parseBibtex(bib)[0];
  if (!e) return null;
  const arxiv = /^10\.48550\/arxiv\./i.test(doi) ? doi.replace(/^10\.48550\/arxiv\./i, '') : null;
  return { id: doi, title: cleanTex(e.title), authors: (e.fields.author ?? '').split(/\s+and\s+/i).map(a => cleanTex(a)).filter(Boolean), year: e.year ? Number(e.year) : null,
    venue: cleanTex(e.fields.journal ?? e.fields.booktitle ?? e.fields.publisher ?? ''), type: e.type, doi, arxiv, url: `https://doi.org/${doi}`, citations: null, sources: ['doi'] };
}

async function bibtexFromDoi(doi: string): Promise<string | null> {
  try {
    const r = await fetchImpl(`https://doi.org/${encodeURI(doi)}`, { headers: { accept: 'application/x-bibtex' }, redirect: 'follow' });
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    return t.startsWith('@') ? t : null;
  } catch { return null; }
}

async function bibtexFromDblp(key: string): Promise<string | null> {
  try {
    const r = await fetchImpl(`https://dblp.org/rec/${key}.bib`);
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    return t.startsWith('@') ? t : null;
  } catch { return null; }
}

/** BibTeX for a hit: DBLP's record, else what the index handed over, else Scholar's, else doi.org, else generated. */
export async function bibtexFor(h: Hit): Promise<string> {
  return (h.dblp && await bibtexFromDblp(h.dblp)) || h.bibtex || (h.scholarId && config.serpApiKey && await bibtexFromScholar(h.scholarId)) || (h.doi && await bibtexFromDoi(h.doi)) || (await bibtexFromTitle(h)) || generateBibtex(h);
}

/** Last resort before generating: find the paper's DOI by exact title (OpenAlex) and take doi.org's BibTeX. */
async function bibtexFromTitle(h: Hit): Promise<string | null> {
  if (!h.title) return null;
  try {
    const hits = await openalex(h.title, 3, 'title');
    const m = hits.find(x => normTitle(x.title) === normTitle(h.title) && x.doi && (!h.year || !x.year || Math.abs(x.year - h.year) <= 1));
    return m?.doi ? await bibtexFromDoi(m.doi) : null;
  } catch { return null; }
}

function generateBibtex(h: Hit): string {
  const type = /journal|article/i.test(h.type) ? 'article' : /proceedings|conference|paper/i.test(h.type) ? 'inproceedings' : h.arxiv ? 'misc' : 'misc';
  const f: [string, string][] = [['title', h.title], ['author', h.authors.join(' and ')]];
  if (h.year) f.push(['year', String(h.year)]);
  if (h.venue) f.push([type === 'article' ? 'journal' : type === 'inproceedings' ? 'booktitle' : 'howpublished', h.venue]);
  if (h.doi) f.push(['doi', h.doi]);
  if (h.arxiv) { f.push(['eprint', h.arxiv], ['archivePrefix', 'arXiv']); }
  if (h.url) f.push(['url', h.url]);
  return `@${type}{tmp,\n` + f.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${v}}`).join(',\n') + '\n}\n';
}

const STOP = new Set(['the', 'a', 'an', 'on', 'of', 'in', 'and', 'for', 'to', 'with', 'from', 'by', 'is', 'are', 'towards', 'toward', 'via', 'at', 'as', 'its', 'into', 'how', 'what', 'why', 'when', 'do', 'does', 'can']);
const ascii = (s: string) => cleanTex(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Google-Scholar-style key: first author's last name + year + first significant title word. */
export function scholarKey(e: BibEntry): string {
  const first = (e.fields.author ?? '').split(/\s+and\s+/i)[0] ?? '';
  const last = first.includes(',') ? first.split(',')[0] : first.trim().split(/\s+/).pop() ?? '';
  const word = cleanTex(e.title).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w && !STOP.has(w))[0] ?? '';
  const k = ascii(last) + (e.year ? e.year.replace(/\D/g, '').slice(0, 4) : '') + ascii(word);
  return k || 'ref' + Math.random().toString(36).slice(2, 8);
}

/** Rewrite the key of the (single) entry in a BibTeX text, dropping DBLP bookkeeping fields. */
export function rewriteEntry(bibtex: string, key: string): string {
  let t = bibtex.trim().replace(/^@(\w+)\s*\{\s*[^,]*,/, (_m, type) => `@${type}{${key},`);
  t = t.replace(/^\s*(timestamp|biburl|bibsource)\s*=\s*\{[^}]*\},?\s*$/gim, '').replace(/,\s*\n(\s*)\}\s*$/, '\n$1}').replace(/\n{2,}/g, '\n');
  return t + '\n';
}

export interface AddResult { key: string; file: string; existed: boolean; bibtex: string; entry: { key: string; author: string; year: string; title: string } }

/** All entries of the project's .bib files (small projects; large ones are searched by key below). */
function projectEntries(projectDir: string): { file: string; entry: BibEntry }[] {
  const out: { file: string; entry: BibEntry }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.') || d.name === '_build' || d.name === 'node_modules') continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, depth + 1);
      else if (d.isFile() && d.name.endsWith('.bib') && !d.name.endsWith('~') && fs.statSync(p).size < 8 * 1024 * 1024) {
        try { for (const e of parseBibtex(fs.readFileSync(p, 'utf8'))) out.push({ file: path.relative(projectDir, p), entry: e }); } catch { /* ignore */ }
      }
    }
  };
  walk(projectDir, 0);
  return out;
}

/**
 * Add one BibTeX entry to `<project>/cited.bib` (created on demand). Returns the existing key
 * instead when the project already has that paper (same DOI, or same title and year).
 */
export function addToCitedBib(projectDir: string, bibtex: string, opts: { file?: string; commit?: (rel: string) => void } = {}): AddResult {
  const parsed = parseBibtex(bibtex);
  if (parsed.length !== 1) throw new Error(parsed.length ? 'Paste one BibTeX entry at a time' : 'That is not a BibTeX entry (it should start with @article{…, @inproceedings{…, …)');
  const e = parsed[0];
  const existing = projectEntries(projectDir);
  const doi = (e.fields.doi ?? '').toLowerCase().replace(/^https?:\/\/doi\.org\//, '');
  const t = normTitle(e.title);
  const same = existing.find(x => (doi && (x.entry.fields.doi ?? '').toLowerCase().replace(/^https?:\/\/doi\.org\//, '') === doi) || (t && normTitle(x.entry.title) === t && (!e.year || !x.entry.year || e.year === x.entry.year)));
  if (same) return { key: same.entry.key, file: same.file, existed: true, bibtex: '', entry: item(same.entry) };
  const keys = new Set(existing.map(x => x.entry.key));
  let key = scholarKey(e);
  if (keys.has(key)) { let i = 0; while (keys.has(key + 'abcdefghijklmnopqrstuvwxyz'[i])) i++; key = key + 'abcdefghijklmnopqrstuvwxyz'[i]; }
  const text = rewriteEntry(bibtex, key);
  const rel = opts.file ?? 'cited.bib';
  const abs = path.join(projectDir, rel);
  if (!abs.startsWith(projectDir + path.sep) && abs !== projectDir) throw new Error('bad file name');
  const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const sep = prev && !prev.endsWith('\n') ? '\n\n' : prev ? '\n' : '';
  const tmp = abs + '.overlyx-tmp';
  fs.writeFileSync(tmp, prev + sep + text, 'utf8');
  fs.renameSync(tmp, abs);
  opts.commit?.(rel);
  const entry = parseBibtex(text)[0];
  return { key, file: rel, existed: false, bibtex: text, entry: item(entry) };
}

const item = (e: BibEntry) => ({ key: e.key, author: e.authorShort, year: e.year, title: cleanTex(e.title) });
