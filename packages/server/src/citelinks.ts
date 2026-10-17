/**
 * Paper links and identifiers in the citation dialog's search, resolved to the paper the way
 * Zotero's translators do (bibsearch.ts searchLiterature hands them here):
 *
 *   identifiers  a DOI, an arXiv id (new and old style), PMID / PMCID, ISBN — bare or with their
 *                `doi:` / `arXiv:` / `PMID:` / `ISBN` prefixes
 *   preprints    arXiv and its mirrors (ar5iv, alphaXiv, Hugging Face papers, Semantic Scholar's
 *                /arxiv/), bioRxiv / medRxiv, OpenReview, PsyArXiv / SocArXiv / EdArXiv / OSF,
 *                SSRN, Zenodo, HAL (its API's BibTeX). The published version comes first when
 *                arXiv, bioRxiv, DBLP, Semantic Scholar or OpenAlex knows it, the preprint second
 *   indexes      PubMed, PMC and Europe PMC (NCBI E-utilities → the DOI), DBLP records, Semantic
 *                Scholar papers, the ACL Anthology (its .bib)
 *   publishers   a DOI anywhere in the link (ACM, Springer, Wiley, PNAS, Science, APS, IOP,
 *                Frontiers, PLOS, Taylor & Francis, SAGE, …), Nature and eLife article numbers,
 *                Elsevier PIIs (ScienceDirect, Cell Press: Crossref knows their DOIs)
 *   any page     its embedded metadata, read as Zotero's "Embedded Metadata" translator reads it:
 *                Highwire `citation_*` tags (what Google Scholar indexes, so nearly every journal
 *                and proceedings site — PMLR, NeurIPS, CVF, JMLR, AAAI, IJCAI, OJS journals), Dublin
 *                Core, JSON-LD ScholarlyArticle, Open Graph. A DOI the page declares wins (doi.org's
 *                BibTeX); then the page's own BibTeX, shown inline (PMLR, CVF) or linked (NeurIPS,
 *                JMLR, IJCAI) when its title is the page's; then DBLP's record of the title;
 *                else an entry is written from the tags — a web page becomes a @misc with its address
 *
 * Fixed services (arXiv, OpenReview, NCBI, …) are asked directly; a page — any address someone
 * pastes — only through netguard.ts's guardedFetch (public hosts, every redirect checked), with a
 * size cap. Nothing about the user goes out but the identifier or the link. A site that answers a
 * server with a bot check (since 2026: DBLP, OpenReview, HAL's pages, IEEE Xplore from this box) is
 * reported as such — never taken for the paper — and the user is pointed to its DOI or BibTeX.
 */
import { parseBibtex, cleanTex } from '@overlyx/core';
import { config } from './config.ts';
import { guardedFetch } from './netguard.ts';
import { fetchImpl, hitFromDoi, normTitle, dblp, openalex, s2Hit, type Hit, type SearchResult } from './bibsearch.ts';

export type Link =
  | { kind: 'doi'; doi: string }
  | { kind: 'arxiv'; id: string }
  | { kind: 'openreview'; id: string }
  | { kind: 'rxiv'; doi: string }
  | { kind: 'pubmed'; pmid: string }
  | { kind: 'pmc'; pmcid: string }
  | { kind: 'acl'; id: string }
  | { kind: 'dblp'; key: string }
  | { kind: 's2'; id: string }
  | { kind: 'pii'; pii: string }
  | { kind: 'isbn'; isbn: string }
  /** a site's own BibTeX file for the paper at `page` (HAL, JMLR) */
  | { kind: 'bib'; url: string; page: string }
  | { kind: 'page'; url: string };

/* ------------------------------------------------------------------ recognising */

const OLD_ARCHIVES = 'acc-phys|adap-org|alg-geom|ao-sci|astro-ph|atom-ph|bayes-an|chao-dyn|chem-ph|cmp-lg|comp-gas|cond-mat|cs|dg-ga|funct-an|gr-qc|hep-ex|hep-lat|hep-ph|hep-th|math|math-ph|mtrl-th|nlin|nucl-ex|nucl-th|patt-sol|physics|plasm-ph|q-alg|q-bio|quant-ph|solv-int|supr-con';
/** an arXiv id inside a path: new style (1706.03762) or old (hep-th/9901001, math.GT/0309136) */
const ARXIV_IN = new RegExp(`(?:^|[/:=])(\\d{4}\\.\\d{4,5}|(?:${OLD_ARCHIVES})(?:\\.[A-Za-z]{2})?\\/\\d{7})(?:v\\d+)?(?:\\.pdf)?(?:$|[/?#])`, 'i');
const ARXIV_BARE = new RegExp(`^(?:arxiv\\s*:?\\s*)?(\\d{4}\\.\\d{4,5}|(?:${OLD_ARCHIVES})(?:\\.[A-Za-z]{2})?\\/\\d{7})(?:v\\d+)?$`, 'i');
const DOI_TEXT = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;
const DOI_URL = /\b(10\.\d{4,9}\/[^\s"'<>?#&]+)/i;
/** bioRxiv / medRxiv DOIs: 10.1101/123456 (until 2019) or 10.1101/2020.01.01.123456 (10.1101 is also Cold Spring Harbor's journals') */
const RXIV_DOI = /^10\.1101\/(?:\d{6}|\d{4}\.\d{2}\.\d{2}\.\d+)$/;
/** OSF preprint servers: their DOI prefixes */
const OSF_PREFIX: Record<string, string> = { psyarxiv: '10.31234', socarxiv: '10.31235', edarxiv: '10.35542', metaarxiv: '10.31222', osf: '10.31219' };

/** A DOI as found in a link or text: without trailing punctuation or a publisher's /full, /pdf, .pdf … */
export function cleanDoi(d: string): string {
  let s = d.trim().replace(/[.,;:)\]}'"]+$/, '');
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(/\/(?:full|abstract|abs|pdf|epdf|pdfdirect|pdfft|fulltext|full-text|meta|summary|references|figures|tables|html|epub|suppl|supplemental|citedby|metrics|reader|info|issue-?toc)$/i, '').replace(/\.pdf$/i, '').replace(/[.,;:)\]}'"]+$/, '');
  }
  return s;
}

/** A DOI as a link: arXiv's and bioRxiv's own DOIs go to their preprint servers (the published version is found there). */
function doiLink(doi: string): Link {
  const d = cleanDoi(doi);
  const ax = /^10\.48550\/arxiv\.(.+)$/i.exec(d);
  if (ax) return { kind: 'arxiv', id: ax[1].replace(/v\d+$/, '') };
  const rx = d.replace(/v\d+$/, '');
  if (RXIV_DOI.test(rx)) return { kind: 'rxiv', doi: rx };
  return { kind: 'doi', doi: d };
}

function validIsbn(s: string): boolean {
  if (/^\d{9}[\dX]$/.test(s)) return [...s].reduce((a, c, i) => a + (c === 'X' ? 10 : Number(c)) * (10 - i), 0) % 11 === 0;
  if (/^97[89]\d{10}$/.test(s)) return [...s].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0;
  return false;
}

/** What a search query is when it names one paper: an identifier or a link (null: words to search for). */
export function identify(q: string): Link | null {
  const t = q.trim();
  if (!t) return null;
  const url = asUrl(t);
  if (url) return fromUrl(url);
  let m: RegExpExecArray | null;
  if ((m = ARXIV_BARE.exec(t))) return { kind: 'arxiv', id: m[1] };
  if ((m = /^(?:pmid|pubmed)\s*:?\s*(\d{1,9})$/i.exec(t))) return { kind: 'pubmed', pmid: m[1] };
  if ((m = /^(?:pmcid\s*:?\s*)?PMC(\d{3,9})$/i.exec(t))) return { kind: 'pmc', pmcid: m[1] };
  if ((m = /^(isbn(?:-1[03])?\s*:?\s*)?((?:97[89][\s-]?)?\d[\d\s-]{7,}[\dXx])$/i.exec(t))) {
    const isbn = m[2].replace(/[\s-]/g, '').toUpperCase();
    if (validIsbn(isbn) && (m[1] || /[\s-]/.test(m[2]) || isbn.length === 13)) return { kind: 'isbn', isbn };
  }
  if ((m = /^(\d{4}\.[a-z][\w-]*\.\d+|[A-Z]\d{2}-\d{4})$/.exec(t))) return { kind: 'acl', id: m[1] };
  if ((m = /^(?:doi\s*:?\s*)?(10\.\d{4,9}\/\S+)$/i.exec(t))) return doiLink(m[1]);
  // a DOI with a few words around it (a copied reference line's tail)
  const d = DOI_TEXT.exec(t);
  if (d && t.length - d[1].length < 40) return doiLink(d[1]);
  return null;
}

function asUrl(t: string): URL | null {
  if (/\s/.test(t)) return null;
  const s = /^https?:\/\//i.test(t) ? t : /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S/i.test(t) ? 'https://' + t : null;
  if (!s) return null;
  try { return new URL(s); } catch { return null; }
}

function fromUrl(u: URL): Link {
  const host = u.hostname.toLowerCase().replace(/^(?:www\d?|m)\./, '');
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep it encoded */ }
  const param = (...names: string[]) => { for (const n of names) { const v = u.searchParams.get(n); if (v) return v; } return null; };
  const on = (...hosts: string[]) => hosts.some(h => host === h || host.endsWith('.' + h));
  let m: RegExpExecArray | null;

  // arXiv and the sites that show its papers
  if (on('arxiv.org', 'ar5iv.org', 'alphaxiv.org', 'scirate.com', 'arxiv-sanity-lite.com') || (on('huggingface.co') && path.startsWith('/papers/')) || (on('semanticscholar.org') && path.startsWith('/arxiv/'))) {
    if ((m = ARXIV_IN.exec(path)) || (m = ARXIV_IN.exec('/' + (param('id', 'arxiv_id') ?? '')))) return { kind: 'arxiv', id: m[1] };
  }
  if (on('openreview.net')) {
    const id = param('id', 'noteId');
    if (id && /^[\w-]{5,}$/.test(id)) return { kind: 'openreview', id };
  }
  if (on('biorxiv.org', 'medrxiv.org') && (m = /\/(10\.1101\/[\d.]+?)(?:v\d+)?(?:\.full|\.abstract|\.pdf|\.full\.pdf|\.full-text|\.supplementary-material)*\/?$/.exec(path))) return { kind: 'rxiv', doi: m[1] };
  // PubMed, PMC, Europe PMC
  if (on('pubmed.ncbi.nlm.nih.gov') && (m = /^\/(\d{1,9})\/?$/.exec(path))) return { kind: 'pubmed', pmid: m[1] };
  if (on('ncbi.nlm.nih.gov', 'europepmc.org')) {
    if ((m = /\/PMC(\d{3,9})(?:\/|$)/i.exec(path))) return { kind: 'pmc', pmcid: m[1] };
    if ((m = /\/(?:pubmed|MED)\/(\d{1,9})\/?$/i.exec(path))) return { kind: 'pubmed', pmid: m[1] };
  }
  if (on('aclanthology.org', 'aclweb.org') && (m = /\/(\d{4}\.[a-z][\w-]*\.\d+|[A-Z]\d{2}-\d{4})(?:\.pdf|\.bib|\.xml|v\d+\.pdf)?\/?$/.exec(path))) return { kind: 'acl', id: m[1] };
  if (on('dblp.org', 'dblp.uni-trier.de', 'dblp.dagstuhl.de') && (m = /\/rec\/(?:(?:bibtex|bib|html|xml)\d?\/)?((?:conf|journals|books|phd|series|reference|tr|persons|homepages)\/[\w-]+\/[\w-]+)(?:\.\w+)?$/.exec(path))) return { kind: 'dblp', key: m[1] };
  if (on('semanticscholar.org')) {
    if ((m = /\/paper\/(?:[^/]+\/)?([0-9a-f]{40})$/i.exec(path))) return { kind: 's2', id: m[1] };
    if ((m = /\/CorpusID:(\d+)/i.exec(path))) return { kind: 's2', id: `CorpusId:${m[1]}` };
  }
  // publishers whose article numbers are DOIs
  if (on('nature.com') && (m = /^\/articles\/([a-z][\w.-]*?)(?:\.pdf)?\/?$/i.exec(path))) return { kind: 'doi', doi: `10.1038/${m[1]}` };
  if (on('elifesciences.org') && (m = /^\/articles\/(\d+)/.exec(path))) return { kind: 'doi', doi: `10.7554/eLife.${m[1]}` };
  if (on('zenodo.org') && (m = /^\/records?\/(\d+)/.exec(path))) return { kind: 'doi', doi: `10.5281/zenodo.${m[1]}` };
  if (on('psyarxiv.com', 'socarxiv.org', 'edarxiv.org') && (m = /^\/([a-z0-9]{5})(?:\/|$)/i.exec(path))) return { kind: 'doi', doi: `${OSF_PREFIX[host.split('.')[0]]}/osf.io/${m[1]}` };
  if (on('osf.io') && (m = /^\/preprints\/(\w+)\/([a-z0-9]{5})(?:_v\d+)?(?:\/|$)/i.exec(path)) && OSF_PREFIX[m[1].toLowerCase()]) return { kind: 'doi', doi: `${OSF_PREFIX[m[1].toLowerCase()]}/osf.io/${m[2]}` };
  if (on('ssrn.com')) {
    const id = param('abstract_id', 'abstractid', 'abstractId') ?? /abstract=(\d+)/i.exec(u.href)?.[1];
    if (id && /^\d+$/.test(id)) return { kind: 'doi', doi: `10.2139/ssrn.${id}` };
  }
  if (on('hal.science', 'archives-ouvertes.fr', 'hal.inria.fr') && (m = /^\/([a-z]+(?:-[a-z]+)*-\d{8})(v\d+)?(?:\/|$)/.exec(path))) return { kind: 'bib', url: `https://api.archives-ouvertes.fr/search/?q=halId_s:${m[1]}&wt=bibtex`, page: `https://hal.science/${m[1]}` };
  if (on('jmlr.org') && (m = /^\/papers\/(?:v(\d+)\/([\w.-]+?)\.(?:html|bib)|volume(\d+)\/([\w.-]+)\/)/.exec(path))) {
    const v = m[1] ?? m[3], id = m[2] ?? m[4];
    return { kind: 'bib', url: `https://jmlr.org/papers/v${v}/${id}.bib`, page: `https://jmlr.org/papers/v${v}/${id}.html` };
  }
  // proceedings PDFs: their landing pages (metadata and BibTeX)
  if (on('proceedings.neurips.cc', 'papers.nips.cc', 'papers.neurips.cc') && (m = /^\/(paper_files\/paper|paper)\/(\d{4})\/(?:file|hash)\/([0-9a-f]{32})-(?:Paper|Abstract|Bibtex|Supplemental|Reviews|Metareview|AuthorFeedback)(-[A-Za-z_]+)?\.\w+$/.exec(path))) {
    return { kind: 'page', url: `https://proceedings.neurips.cc/paper_files/paper/${m[2]}/hash/${m[3]}-Abstract${m[4] ?? ''}.html` };
  }
  if (on('proceedings.mlr.press') && (m = /^\/v(\d+)\/([\w-]+?)(?:\.html|\.pdf|\/[\w-]+\.pdf)?\/?$/.exec(path))) return { kind: 'page', url: `https://proceedings.mlr.press/v${m[1]}/${m[2]}.html` };
  if (on('openaccess.thecvf.com') && (m = /^\/(content[\w/-]*?)\/papers\/(?:[\w-]+\/)?([\w-]+)\.pdf$/.exec(path))) return { kind: 'page', url: `https://openaccess.thecvf.com/${m[1]}/html/${m[2]}.html` };
  // Elsevier: the PII; Crossref has the DOI
  if (on('sciencedirect.com', 'linkinghub.elsevier.com') && (m = /\/pii\/(S?[\dX]{15,17})/i.exec(path))) return { kind: 'pii', pii: m[1] };
  if (on('cell.com', 'thelancet.com') && (m = /\/(?:fulltext|abstract|pdf|pdfExtended|full)\/(S[\dX()-]{15,25})/i.exec(path))) return { kind: 'pii', pii: m[1].replace(/[^\dSX]/gi, '') };
  // a DOI anywhere in the address (ACM, Springer, Wiley, PNAS, Science, APS, IOP, Frontiers, PLOS, T&F, SAGE, doi.org itself, …)
  const d = DOI_URL.exec(path) ?? DOI_URL.exec(decodeSafe(u.search));
  if (d) return doiLink(d[1]);
  return { kind: 'page', url: u.href };
}

const decodeSafe = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/* ------------------------------------------------------------------ resolving */

/** The paper(s) a link names: usually one; a preprint's published version first, the preprint second. */
export async function resolveLink(l: Link): Promise<SearchResult> {
  try {
    const hits = (await resolve(l)).filter((h): h is Hit => !!h && !!h.title);
    return { hits, warnings: hits.length ? [] : [`${describe(l)}: nothing found`] };
  } catch (e) {
    return { hits: [], warnings: [`${describe(l)} could not be looked up: ${(e as Error).message}`] };
  }
}

function describe(l: Link): string {
  switch (l.kind) {
    case 'doi': return `doi:${l.doi}`;
    case 'arxiv': return `arXiv:${l.id}`;
    case 'openreview': return 'The OpenReview paper';
    case 'rxiv': return `doi:${l.doi}`;
    case 'pubmed': return `PMID ${l.pmid}`;
    case 'pmc': return `PMC${l.pmcid}`;
    case 'acl': return `ACL Anthology ${l.id}`;
    case 'dblp': return `DBLP ${l.key}`;
    case 's2': return 'The Semantic Scholar paper';
    case 'pii': return `Elsevier article ${l.pii}`;
    case 'isbn': return `ISBN ${l.isbn}`;
    case 'bib': case 'page': return new URL(l.kind === 'bib' ? l.page : l.url).host;
  }
}

async function resolve(l: Link): Promise<(Hit | null)[]> {
  switch (l.kind) {
    case 'doi': {
      const h = await hitFromDoi(l.doi);
      if (!h) throw new Error('doi.org does not know it');
      return [h];
    }
    case 'arxiv': return arxiv(l.id);
    case 'openreview': return [await openreview(l.id)];
    case 'rxiv': return rxiv(l.doi);
    case 'pubmed': return [await pubmed(l.pmid)];
    case 'pmc': return [await pmc(l.pmcid)];
    case 'acl': return [hitFromBibtex(await text(`https://aclanthology.org/${l.id}.bib`), { id: `acl:${l.id}`, url: `https://aclanthology.org/${l.id}`, sources: ['acl'] })];
    case 'dblp': return [hitFromBibtex(await text(`https://dblp.org/rec/${l.key}.bib`), { id: `dblp:${l.key}`, dblp: l.key, sources: ['dblp'] })];
    case 's2': return [s2Hit(await json(`https://api.semanticscholar.org/graph/v1/paper/${l.id}?fields=title,authors,year,venue,externalIds,citationCount,publicationTypes,citationStyles`, config.s2ApiKey ? { headers: { 'x-api-key': config.s2ApiKey } } : undefined))];
    case 'pii': {
      const d = await json(`https://api.crossref.org/works?filter=alternative-id:${encodeURIComponent(l.pii)}&rows=1&select=DOI${config.contactEmail ? '&mailto=' + encodeURIComponent(config.contactEmail) : ''}`);
      const doi = d?.message?.items?.[0]?.DOI;
      return doi ? [await hitFromDoi(String(doi))] : [];
    }
    case 'isbn': return [await isbn(l.isbn)];
    case 'bib': {
      const bib = await text(l.url).catch(() => '');
      const h = bib ? hitFromBibtex(bib, { url: l.page, sources: [new URL(l.page).hostname.replace(/^www\./, '')] }) : null;
      return h ? [h] : fromPage(l.page);
    }
    case 'page': return fromPage(l.url);
  }
}

/**
 * A bot check in place of the answer: Cloudflare's "Just a moment…", Anubis' "Making sure you're not
 * a bot!" (DBLP since 2026), OpenReview's ChallengeRequiredError — a site that will not answer servers.
 */
const CHALLENGE = /<title>\s*(?:Just a moment|Making sure you(?:&#39;|'|’)re not a bot|Attention Required|Verifying you are human|Checking your browser|Please verify you are a human|Security check|Robot Check|Are you a robot|DDoS-Guard)|ChallengeRequiredError/i;
export class BotCheck extends Error {
  constructor(host: string) { super(`${host} asks for a browser check and does not answer servers right now`); }
}

async function answer(url: string, init?: RequestInit): Promise<string> {
  const r = await fetchImpl(url, init);
  const body = await r.text();
  if (r.status === 202 || CHALLENGE.test(body.slice(0, 4000))) throw new BotCheck(new URL(url).hostname);
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return body;
}
async function json(url: string, init?: RequestInit): Promise<any> { return JSON.parse(await answer(url, init)); }
const text = (url: string) => answer(url);

/** A hit from a BibTeX entry (the entry itself goes into cited.bib); null when it is none. */
export function hitFromBibtex(bib: string, extra: Partial<Hit> = {}): Hit | null {
  const e = parseBibtex(bib)[0];
  if (!e?.title) return null;
  const f = e.fields;
  const doi = (f.doi ?? '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') || null;
  const arxiv = /^arxiv$/i.test(f.archiveprefix ?? f.eprinttype ?? '') ? (f.eprint ?? null) : (/arxiv\.org\/abs\/([\w./-]+?)(?:v\d+)?$/.exec(f.url ?? '')?.[1] ?? null);
  return {
    id: doi ?? e.key, title: e.title, authors: splitAuthors(f.author ?? f.editor ?? ''), year: e.year ? Number(e.year) || null : null,
    venue: cleanTex(f.journal ?? f.booktitle ?? f.publisher ?? f.school ?? f.institution ?? ''), type: e.type, doi, arxiv,
    url: f.url ?? (doi ? `https://doi.org/${doi}` : null), citations: null, sources: [], bibtex: bib.trim(), ...extra,
  };
}

const splitAuthors = (s: string) => s.split(/\s+and\s+/i).map(a => cleanTex(a).trim()).filter(Boolean);

/** A BibTeX entry from fields (empty ones left out); &, % and # escaped outside addresses. */
export function bibEntry(type: string, fields: [string, string | number | null | undefined][]): string {
  const balanced = (v: string) => { let d = 0; for (const c of v) { if (c === '{') d++; else if (c === '}' && --d < 0) return false; } return d === 0; };
  const lines = fields.flatMap(([k, raw]) => {
    if (raw == null) return [];
    let v = String(raw).replace(/\s+/g, ' ').trim();
    if (!v) return [];
    if (!balanced(v)) v = v.replace(/[{}]/g, '');
    if (!/^(url|doi|eprint|isbn|urldate|pmid|pmcid)$/i.test(k)) v = v.replace(/(?<!\\)([&%#])/g, '\\$1');
    return [`  ${k} = {${v}}`];
  });
  return `@${type}{tmp,\n${lines.join(',\n')}\n}\n`;
}

/* ------------------------------------------------------------------ preprint servers */

interface ArxivMeta { id: string; title: string; authors: string[]; year: number | null; doi: string | null; category: string | null }

/** arXiv's own record (its API's Atom): title, authors, the first version's year, the published DOI if the authors gave one. */
async function arxivMeta(id: string): Promise<ArxivMeta | null> {
  const r = await fetchImpl(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`);
  if (!r.ok) return null;
  const xml = await r.text();
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry || /<id>[^<]*api\/errors/.test(entry)) return null;
  const tag = (name: string) => { const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(entry); return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : null; };
  const title = tag('title');
  if (!title) return null;
  const published = tag('published');
  return {
    id, title, authors: [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map(m => decodeEntities(m[1]).trim()).filter(Boolean),
    year: published ? Number(published.slice(0, 4)) || null : null, doi: tag('arxiv:doi'), category: /<arxiv:primary_category\b[^>]*term="([^"]+)"/.exec(entry)?.[1] ?? null,
  };
}

/**
 * arXiv: the published version and the preprint. The published version is the DOI the authors gave
 * arXiv, else DBLP's conference or journal record of the title, else Semantic Scholar's (with a key),
 * else a non-preprint OpenAlex work with the same title and first author.
 */
async function arxiv(id: string): Promise<(Hit | null)[]> {
  const meta = await arxivMeta(id).catch(() => null);
  if (!meta) {
    // arXiv's API is down or slow: DataCite has the preprint's DOI record
    const h = await hitFromDoi(`10.48550/arXiv.${id}`);
    if (!h) throw new Error('arXiv does not know it');
    return [{ ...h, arxiv: id, note: 'arXiv preprint' }];
  }
  const preprint: Hit = {
    id: `arxiv:${id}`, title: meta.title, authors: meta.authors, year: meta.year, venue: 'arXiv', type: 'misc', doi: `10.48550/arXiv.${id}`, arxiv: id,
    url: `https://arxiv.org/abs/${id}`, citations: null, sources: ['arxiv'], note: 'arXiv preprint',
    bibtex: bibEntry('misc', [['title', meta.title], ['author', meta.authors.join(' and ')], ['year', meta.year], ['eprint', id], ['archivePrefix', 'arXiv'], ['primaryClass', meta.category], ['url', `https://arxiv.org/abs/${id}`]]),
  };
  let published: Hit | null = null;
  if (meta.doi) published = await hitFromDoi(cleanDoi(meta.doi));
  if (!published) {
    const [d, s, o] = await Promise.all([dblpRecordOf(meta.title, meta.year), s2Published(id), openalexPublished(meta)]);
    published = d ?? s ?? o;
  }
  return published ? [{ ...published, arxiv: published.arxiv ?? id, note: 'Published version' }, preprint] : [preprint];
}

const PREPRINT_DOI = /^10\.(?:48550|1101|31234|31235|31219|2139|5281|6084|21203|20944|26434|36227|22541|31222|35542)\//;
const lastName = (a: string) => cleanTex(a.includes(',') ? a.split(',')[0] : a.trim().split(/\s+/).pop() ?? '').normalize('NFKD').replace(/[^\p{L}]/gu, '').toLowerCase();

/** Semantic Scholar's record of an arXiv paper (only with S2_API_KEY: without one it rarely answers): its DBLP key or published DOI. */
async function s2Published(id: string): Promise<Hit | null> {
  if (!config.s2ApiKey) return null;
  try {
    const p = await json(`https://api.semanticscholar.org/graph/v1/paper/arXiv:${id}?fields=title,authors,year,venue,externalIds,citationCount,publicationTypes,citationStyles`, { headers: { 'x-api-key': config.s2ApiKey } });
    const ids = p?.externalIds ?? {};
    const doi = ids.DOI && !PREPRINT_DOI.test(String(ids.DOI)) ? String(ids.DOI) : null;
    if (doi) return await hitFromDoi(doi);
    return ids.DBLP && !/^journals\/corr\//.test(ids.DBLP) && p.venue && !/arxiv/i.test(p.venue) ? s2Hit(p) : null;
  } catch { return null; }
}

/** OpenAlex's work with the preprint's title and first author that is no preprint (a journal article, a proceedings paper). */
async function openalexPublished(m: ArxivMeta): Promise<Hit | null> {
  if (normTitle(m.title).length < 12 || !m.authors.length) return null;
  try {
    const first = lastName(m.authors[0]);
    const h = (await openalex(m.title, 6, 'title')).find(x => x.doi && !PREPRINT_DOI.test(x.doi) && !/preprint|posted|dataset/i.test(x.type)
      && normTitle(x.title) === normTitle(m.title) && (!m.year || !x.year || (x.year >= m.year - 1 && x.year <= m.year + 3))
      && x.authors.some(a => lastName(a) === first));
    return h?.doi ? await hitFromDoi(h.doi) : null;
  } catch { return null; }
}

/** DBLP's record of a paper with exactly this title — its conference or journal version, not the CoRR copy of a preprint. */
async function dblpRecordOf(title: string, year: number | null): Promise<Hit | null> {
  if (normTitle(title).length < 12) return null;
  try {
    const t = normTitle(title);
    return (await dblp(title, 10)).find(h => normTitle(h.title) === t && h.venue !== 'CoRR' && !/^journals\/corr\//.test(h.dblp ?? '') && (!year || !h.year || h.year >= year - 1)) ?? null;
  } catch { return null; }
}

/** bioRxiv / medRxiv: the journal version their API knows, then the preprint (Crossref's record of its DOI). */
async function rxiv(doi: string): Promise<(Hit | null)[]> {
  let rec: any = null, server = 'bioRxiv';
  for (const s of ['biorxiv', 'medrxiv']) {
    try {
      const list = (await json(`https://api.biorxiv.org/details/${s}/${doi}`))?.collection ?? [];
      if (list.length) { rec = list[list.length - 1]; server = s === 'medrxiv' ? 'medRxiv' : 'bioRxiv'; break; }
    } catch { /* the other server, or Crossref alone */ }
  }
  const out: (Hit | null)[] = [];
  const published = rec?.published && rec.published !== 'NA' ? String(rec.published) : null;
  if (published) { const h = await hitFromDoi(published); if (h) out.push({ ...h, note: 'Published version' }); }
  const pre = await hitFromDoi(doi);
  if (pre) out.push({ ...pre, note: `${server} preprint` });
  else if (rec?.title) {
    const authors = String(rec.authors ?? '').split(/;\s*/).filter(Boolean);
    const year = Number(String(rec.date ?? '').slice(0, 4)) || null;
    out.push({ id: doi, title: rec.title, authors, year, venue: server, type: 'misc', doi, arxiv: null, url: `https://doi.org/${doi}`, citations: null, sources: [server.toLowerCase()], note: `${server} preprint`,
      bibtex: bibEntry('misc', [['title', rec.title], ['author', authors.join(' and ')], ['year', year], ['howpublished', server], ['doi', doi], ['url', `https://doi.org/${doi}`]]) });
  }
  if (!out.length) throw new Error(`${server} does not know it`);
  return out;
}

/** OpenReview: the note's own BibTeX (venue and year once accepted), from API v2, else v1 (venues before 2023). */
async function openreview(id: string, depth = 0): Promise<Hit | null> {
  let blocked = false;
  for (const base of ['https://api2.openreview.net', 'https://api.openreview.net']) {
    let n: any;
    try { n = (await json(`${base}/notes?id=${encodeURIComponent(id)}`))?.notes?.[0]; } catch (e) { blocked ||= e instanceof BotCheck; continue; }
    if (!n?.content) continue;
    // a review or comment: its paper
    if (n.forum && n.forum !== n.id && depth === 0) return openreview(n.forum, 1);
    const v = (x: any) => (x && typeof x === 'object' && !Array.isArray(x) && 'value' in x ? x.value : x);
    const c = n.content;
    const title = String(v(c.title) ?? '').trim();
    if (!title) continue;
    const venue = String(v(c.venue) ?? '').trim();
    const authors: string[] = Array.isArray(v(c.authors)) ? v(c.authors).map(String) : [];
    const url = `https://openreview.net/forum?id=${n.forum ?? id}`;
    const bib = v(c._bibtex);
    const fromBib = typeof bib === 'string' ? hitFromBibtex(bib) : null;
    const when = n.pdate ?? n.odate ?? n.cdate ?? n.tcdate;
    const year = fromBib?.year ?? (when ? new Date(when).getUTCFullYear() : null);
    return {
      ...(fromBib ?? { type: 'misc', doi: null, arxiv: null, citations: null, bibtex: bibEntry('misc', [['title', title], ['author', authors.join(' and ')], ['year', year], ['howpublished', venue || 'OpenReview'], ['url', url]]) }),
      id: `openreview:${n.forum ?? id}`, title, authors: fromBib?.authors.length ? fromBib.authors : authors, year, venue: venue || fromBib?.venue || 'OpenReview', url, citations: null, sources: ['openreview'],
    } as Hit;
  }
  // (since 2026 OpenReview's API asks unknown servers for a browser check)
  throw new Error(blocked
    ? 'OpenReview asks this server for a browser check and does not answer right now — type the paper’s title instead, or paste the BibTeX from its OpenReview page (“Show BibTeX”)'
    : 'OpenReview does not show it (private, or a mistyped id)');
}

/* ------------------------------------------------------------------ PubMed, books */

const eutils = (db: string, id: string) => `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=${db}&id=${id}&retmode=json&tool=overlyx${config.contactEmail ? '&email=' + encodeURIComponent(config.contactEmail) : ''}`;
const articleId = (doc: any, type: string): string | null => (doc?.articleids ?? []).find((a: any) => a.idtype === type)?.value || null;

/** PubMed: the DOI's BibTeX when the record has one, else an entry from PubMed's summary. */
async function pubmed(pmid: string): Promise<Hit | null> {
  const doc = (await json(eutils('pubmed', pmid)))?.result?.[pmid];
  if (!doc || doc.error) return null;
  const doi = articleId(doc, 'doi');
  if (doi) { const h = await hitFromDoi(doi); if (h) return { ...h, note: `PMID ${pmid}` }; }
  return summaryHit(doc, { pmid });
}

/** PMC: through its PMID or DOI (an article's PMC summary lists both). */
async function pmc(id: string): Promise<Hit | null> {
  const doc = (await json(eutils('pmc', id)))?.result?.[id];
  if (!doc || doc.error) return null;
  const doi = articleId(doc, 'doi'), pmid = articleId(doc, 'pmid');
  if (doi) { const h = await hitFromDoi(doi); if (h) return { ...h, note: `PMC${id}` }; }
  if (pmid && pmid !== '0') { const h = await pubmed(pmid); if (h) return h; }
  return summaryHit(doc, { pmcid: `PMC${id}` });
}

function summaryHit(doc: any, ids: { pmid?: string; pmcid?: string }): Hit | null {
  const title = String(doc.title ?? '').replace(/\.$/, '').trim();
  if (!title) return null;
  // "LeCun Y" → "LeCun, Y."
  const authors = (doc.authors ?? []).filter((a: any) => !a.authtype || a.authtype === 'Author').map((a: any) => String(a.name ?? '').replace(/^(.+?)\s+([A-Z]+)$/, (_m, last, ini) => `${last}, ${[...ini].join('. ')}.`)).filter(Boolean);
  const year = Number(/\d{4}/.exec(String(doc.pubdate ?? doc.epubdate ?? ''))?.[0]) || null;
  const journal = String(doc.fulljournalname || doc.source || '');
  const doi = articleId(doc, 'doi');
  const url = ids.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${ids.pmid}/` : `https://pmc.ncbi.nlm.nih.gov/articles/${ids.pmcid}/`;
  return {
    id: doi ?? `pubmed:${ids.pmid ?? ids.pmcid}`, title, authors, year, venue: journal, type: 'article', doi, arxiv: null, url, citations: null, sources: ['pubmed'],
    bibtex: bibEntry('article', [['title', title], ['author', authors.join(' and ')], ['journal', journal], ['year', year], ['volume', doc.volume], ['number', doc.issue], ['pages', String(doc.pages ?? '').replace(/-/g, '--')], ['doi', doi], ['pmid', ids.pmid], ['pmcid', ids.pmcid], ['url', url]]),
  };
}

/** A book by its ISBN (Open Library). */
async function isbn(isbn: string): Promise<Hit | null> {
  const b = (await json(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`))?.[`ISBN:${isbn}`];
  if (!b?.title) return null;
  const title = b.subtitle ? `${b.title}: ${b.subtitle}` : String(b.title);
  const authors = (b.authors ?? []).map((a: any) => String(a.name ?? '')).filter(Boolean);
  const publisher = String(b.publishers?.[0]?.name ?? '');
  const year = Number(/\d{4}/.exec(String(b.publish_date ?? ''))?.[0]) || null;
  return {
    id: `isbn:${isbn}`, title, authors, year, venue: publisher, type: 'book', doi: null, arxiv: null, url: b.url ?? null, citations: null, sources: ['openlibrary'],
    bibtex: bibEntry('book', [['title', title], ['author', authors.join(' and ')], ['publisher', publisher], ['year', year], ['isbn', isbn]]),
  };
}

/* ------------------------------------------------------------------ any page: its embedded metadata */

const PAGE_UA = 'Mozilla/5.0 (compatible; OverLyX/0.1; +https://overlyx.app) citation lookup';
const PAGE_MAX = 2_000_000;

/** A page the user pasted: public hosts only, every redirect checked, at most PAGE_MAX bytes. */
async function fetchPage(url: string, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'): Promise<{ body: string; type: string; url: string }> {
  const r = await guardedFetch(url, { headers: { 'user-agent': PAGE_UA, accept } }, fetchImpl);
  const host = new URL(url).hostname;
  const body = await readCapped(r, PAGE_MAX);
  if (r.status === 202 || CHALLENGE.test(body.slice(0, 4000))) throw new Error(`${new BotCheck(host).message} — paste the DOI or the BibTeX instead`);
  if (!r.ok) throw new Error(`${host} answered ${r.status}${[401, 403, 429, 503].includes(r.status) ? ' — the site does not let servers read its pages; paste the DOI or the BibTeX instead' : ''}`);
  return { body, type: (r.headers.get('content-type') ?? '').toLowerCase(), url: r.url || url };
}

async function readCapped(r: Response, max: number): Promise<string> {
  if (!r.body) return '';
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (n < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
  }
  try { await reader.cancel(); } catch { /* finished */ }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

async function fromPage(url: string): Promise<(Hit | null)[]> {
  const page = await fetchPage(url);
  if (page.type.includes('pdf') || page.body.startsWith('%PDF')) throw new Error('that is a PDF — paste the page it is on, its DOI or its arXiv id');
  // a .bib file itself
  if (page.body.trimStart().startsWith('@')) { const h = hitFromBibtex(page.body.trim(), { sources: [new URL(page.url).hostname.replace(/^www\./, '')] }); if (h) return [h]; }
  if (page.type && !/html|xml/.test(page.type)) throw new Error(`that is not a web page (${page.type.split(';')[0]})`);
  const meta = pageMetadata(page.body, page.url);
  // the DOI the page declares: doi.org's BibTeX (or the preprint server's, for theirs)
  if (meta.doi) {
    const l = doiLink(meta.doi);
    if (l.kind !== 'doi') return resolve(l);
    const h = await hitFromDoi(l.doi);
    if (h) return [h];
  }
  if (meta.arxiv) return arxiv(meta.arxiv);
  // the page's own BibTeX, inline or linked, when it is this paper's
  const inline = inlineBibtex(page.body, meta.title);
  if (inline) { const h = hitFromBibtex(inline, { url: page.url, sources: [new URL(page.url).hostname.replace(/^www\./, '')] }); if (h) return [h]; }
  if (meta.bibUrl) {
    try {
      const b = await fetchPage(meta.bibUrl, 'application/x-bibtex,text/plain;q=0.9,*/*;q=0.5');
      const t = b.body.trim();
      const e = t.startsWith('@') ? parseBibtex(t)[0] : null;
      if (e && (!meta.title || sameTitle(e.title, meta.title))) { const h = hitFromBibtex(t, { url: page.url, sources: [new URL(page.url).hostname.replace(/^www\./, '')] }); if (h) return [h]; }
    } catch { /* the tags then */ }
  }
  if (!meta.title) throw new Error('the page names no paper (no citation metadata) — paste its DOI or the BibTeX instead');
  // a paper's page without a DOI: DBLP's record of the title (computer science), else OpenAlex's DOI for it
  if (meta.scholarly) {
    const [d, o] = await Promise.all([dblpRecordOf(meta.title, meta.year), openalex(meta.title, 3, 'title').catch(() => [] as Hit[])]);
    if (d) return [d];
    const same = o.find(x => x.doi && sameTitle(x.title, meta.title) && (!meta.year || !x.year || Math.abs(x.year - meta.year) <= 1));
    if (same?.doi) { const h = await hitFromDoi(same.doi); if (h) return [h]; }
  }
  return [metaHit(meta, page.url)];
}

const sameTitle = (a: string, b: string) => { const x = normTitle(a), y = normTitle(b); return !!x && (x === y || (Math.min(x.length, y.length) >= 20 && (x.includes(y) || y.includes(x)))); };

export interface PageMeta {
  title: string; authors: string[]; year: number | null; date: string;
  journal: string; conference: string; bookTitle: string; publisher: string; institution: string;
  volume: string; issue: string; firstPage: string; lastPage: string;
  doi: string | null; arxiv: string | null; isbn: string;
  kind: 'article' | 'inproceedings' | 'incollection' | 'book' | 'phdthesis' | 'techreport' | 'misc';
  /** the page carries scholarly metadata (Highwire, PRISM, Dublin Core, a ScholarlyArticle) — not just a web page's title */
  scholarly: boolean;
  site: string;
  /** a BibTeX file the page links to (NeurIPS, JMLR, IJCAI, HAL) */
  bibUrl: string | null;
}

/**
 * The bibliographic metadata of a page, as Zotero's Embedded Metadata translator reads it: Highwire
 * Press `citation_*` tags first (and bepress'), then PRISM, Dublin Core, JSON-LD, Open Graph, `<title>`.
 */
export function pageMetadata(html: string, pageUrl: string): PageMeta {
  const metas = new Map<string, string[]>();
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(tag[0]);
    let name = (a.name ?? a.property ?? a.itemprop ?? '').toLowerCase().trim();
    if (!name || a.content == null) continue;
    name = name.replace(/^bepress_citation_/, 'citation_').replace(/^dcterms\./, 'dc.').replace(/^eprints\./, 'eprints_');
    const v = decodeEntities(a.content).replace(/\s+/g, ' ').trim();
    if (!v) continue;
    if (!metas.has(name)) metas.set(name, []);
    metas.get(name)!.push(v);
  }
  const one = (...names: string[]) => { for (const n of names) { const v = metas.get(n)?.[0]; if (v) return v; } return ''; };
  const all = (...names: string[]) => { for (const n of names) { const v = metas.get(n); if (v?.length) return v; } return [] as string[]; };
  const ld = jsonLd(html);
  const titleTag = decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();

  const scholarly = [...metas.keys()].some(k => /^(citation_|prism\.|dc\.|eprints_)/.test(k)) || ld?.scholarly === true;
  const title = one('citation_title', 'dc.title', 'eprints_title', 'prism.title') || ld?.title || one('og:title', 'twitter:title') || titleTag;
  let authors = all('citation_author', 'eprints_creators_name', 'dc.creator');
  if (!authors.length && one('citation_authors')) authors = one('citation_authors').split(/\s*;\s*/);
  if (!authors.length && ld?.authors.length) authors = ld.authors;
  if (!authors.length) authors = all('author', 'article:author', 'twitter:creator').filter(a => !/^https?:|^@/.test(a));
  const date = one('citation_publication_date', 'citation_date', 'citation_cover_date', 'citation_online_date', 'citation_year', 'prism.publicationdate', 'prism.coverdate', 'dc.date', 'dc.issued', 'eprints_date')
    || ld?.date || one('article:published_time', 'og:published_time', 'date', 'pubdate', 'publication_date');
  const year = Number(/\b(1[5-9]\d\d|20\d\d)\b/.exec(date)?.[1]) || null;
  const doiOf = (s: string) => { const m = /\b(10\.\d{4,9}\/[^\s"'<>]+)/.exec(decodeSafe(s)); return m ? cleanDoi(m[1]) : null; };
  const doi = [one('citation_doi'), one('prism.doi'), ...all('dc.identifier', 'dc.identifier.doi'), one('doi'), ld?.doi ?? ''].map(s => (s ? doiOf(s) : null)).find(Boolean) ?? null;
  const arxivTag = one('citation_arxiv_id');
  const arxiv = arxivTag ? (ARXIV_BARE.exec(arxivTag.replace(/^arxiv:/i, ''))?.[1] ?? null) : null;
  const journal = one('citation_journal_title', 'prism.publicationname', 'eprints_publication') || ld?.journal || '';
  const conference = one('citation_conference_title', 'citation_conference', 'eprints_event_title');
  const bookTitle = one('citation_inbook_title', 'citation_book_title');
  const institution = one('citation_dissertation_institution', 'citation_technical_report_institution');
  const publisher = one('citation_publisher', 'dc.publisher', 'eprints_publisher') || ld?.publisher || '';
  const kind: PageMeta['kind'] = one('citation_dissertation_institution') ? 'phdthesis' : one('citation_technical_report_institution', 'citation_technical_report_number') ? 'techreport'
    : conference ? 'inproceedings' : bookTitle ? 'incollection' : journal ? 'article' : one('citation_isbn') ? 'book' : 'misc';
  return {
    title, authors: authors.map(a => a.trim()).filter(Boolean), year, date, journal, conference, bookTitle, publisher, institution,
    volume: one('citation_volume', 'prism.volume'), issue: one('citation_issue', 'prism.number', 'prism.issueidentifier'),
    firstPage: one('citation_firstpage', 'prism.startingpage'), lastPage: one('citation_lastpage', 'prism.endingpage'),
    doi, arxiv, isbn: one('citation_isbn'), kind, scholarly, site: one('og:site_name'), bibUrl: bibLink(html, pageUrl),
  };
}

/** a tag's attributes (lower-case names) */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

/** The first schema.org ScholarlyArticle (or Article, Report, Thesis, Book, Chapter) in the page's JSON-LD. */
function jsonLd(html: string): { title: string; authors: string[]; date: string; journal: string; publisher: string; doi: string; scholarly: boolean } | null {
  const KINDS = /^(ScholarlyArticle|MedicalScholarlyArticle|Article|TechArticle|Report|Thesis|Book|Chapter|BlogPosting|NewsArticle|CreativeWork)$/;
  const name = (x: any): string => (typeof x === 'string' ? x : x && typeof x === 'object' ? String(x.name ?? [x.givenName, x.familyName].filter(Boolean).join(' ')) : '');
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let d: any;
    try { d = JSON.parse(m[1].trim()); } catch { continue; }
    const items: any[] = [];
    const walk = (x: any) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { items.push(x); if (x['@graph']) walk(x['@graph']); } };
    walk(d);
    const it = items.find(x => ([] as unknown[]).concat(x['@type'] ?? []).some(t => KINDS.test(String(t))));
    if (!it) continue;
    const types = ([] as unknown[]).concat(it['@type'] ?? []).map(String);
    const ids = ([] as unknown[]).concat(it.identifier ?? [], it.sameAs ?? [], it['@id'] ?? []).map(x => (typeof x === 'object' && x ? String((x as any).value ?? (x as any)['@id'] ?? '') : String(x)));
    return {
      title: decodeEntities(String(it.headline ?? it.name ?? '')).trim(),
      authors: ([] as unknown[]).concat(it.author ?? it.creator ?? []).map(name).map(s => decodeEntities(s).trim()).filter(Boolean),
      date: String(it.datePublished ?? it.dateCreated ?? ''),
      journal: name(it.isPartOf?.isPartOf?.isPartOf ?? it.isPartOf?.isPartOf ?? it.isPartOf),
      publisher: name(it.publisher),
      doi: ids.find(s => /10\.\d{4,9}\//.test(s)) ?? '',
      scholarly: types.some(t => /Scholarly|Thesis|Report|Chapter/.test(t)),
    };
  }
  return null;
}

/** A link to the page's BibTeX: an address ending in .bib, or a link labelled BibTeX, on the same site. */
function bibLink(html: string, pageUrl: string): string | null {
  const page = new URL(pageUrl);
  const site = (h: string) => h.split('.').slice(-2).join('.');
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,200}?)<\/a>/gi)) {
    const href = attrs(`<a ${m[1]}>`).href;
    if (!href || /^(?:javascript|mailto|data):/i.test(href)) continue;
    const label = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
    let u: URL;
    try { u = new URL(decodeEntities(href), page); } catch { continue; }
    if (site(u.hostname) !== site(page.hostname)) continue;
    if (/\.bib$/i.test(u.pathname) || /^(?:download\s+)?bib(?:tex)?(?:\s+citation)?$/i.test(label) || /\/bibtex(?:\/|$)/i.test(u.pathname)) return u.href;
  }
  return null;
}

/** A BibTeX entry shown in the page itself (PMLR, CVF): the one with the page's title (or the only one). */
export function inlineBibtex(html: string, title: string): string | null {
  const src = html.replace(/&#0*64;|&#x0*40;|&commat;/gi, '@');
  const found: { text: string; title: string }[] = [];
  for (const m of src.matchAll(/@(?:inproceedings|article|incollection|misc|book|inbook|techreport|phdthesis|mastersthesis|conference|unpublished|online|report|thesis)\s*\{/gi)) {
    if (found.length >= 8) break;
    let depth = 0, end = -1;
    for (let i = m.index! + m[0].length - 1; i < Math.min(src.length, m.index! + 12000); i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) continue;
    const text = decodeEntities(src.slice(m.index!, end).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n[ \t]*(?=\n)/g, '').trim();
    const e = parseBibtex(text)[0];
    if (e?.title) found.push({ text, title: e.title });
  }
  if (title) return found.find(f => sameTitle(f.title, title))?.text ?? null;
  return found.length === 1 ? found[0].text : null;
}

/** A hit (and its BibTeX) from a page's tags: a paper with its venue, or a web page with its address. */
function metaHit(m: PageMeta, url: string): Hit {
  const pages = m.firstPage && m.lastPage ? `${m.firstPage}--${m.lastPage}` : m.firstPage;
  const venue = m.journal || m.conference || m.bookTitle || m.publisher || m.institution;
  const today = new Date().toISOString().slice(0, 10);
  const fields: [string, string | number | null][] = [['title', m.title], ['author', m.authors.join(' and ')]];
  if (m.kind === 'article') fields.push(['journal', m.journal]);
  if (m.kind === 'inproceedings') fields.push(['booktitle', m.conference]);
  if (m.kind === 'incollection') fields.push(['booktitle', m.bookTitle]);
  if (m.kind === 'phdthesis') fields.push(['school', m.institution]);
  if (m.kind === 'techreport') fields.push(['institution', m.institution || m.publisher]);
  fields.push(['year', m.year], ['volume', m.volume], ['number', m.issue], ['pages', pages]);
  if (m.kind !== 'techreport') fields.push(['publisher', m.publisher]);
  if (m.kind === 'misc' && !m.scholarly) fields.push(['howpublished', m.site || new URL(url).hostname.replace(/^www\./, '')]);
  fields.push(['isbn', m.isbn], ['url', url]);
  if (m.kind === 'misc') fields.push(['urldate', today]);
  return {
    id: url, title: m.title, authors: m.authors, year: m.year, venue: venue || m.site, type: m.kind, doi: null, arxiv: null, url, citations: null,
    sources: [new URL(url).hostname.replace(/^www\./, '')], bibtex: bibEntry(m.kind, fields), note: m.scholarly ? undefined : 'Web page',
  };
}

/* ------------------------------------------------------------------ HTML entities */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  szlig: 'ß', aelig: 'æ', AElig: 'Æ', oelig: 'œ', OElig: 'Œ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', thorn: 'þ', copy: '©', reg: '®', middot: '·', times: '×',
};
/** combining marks of the accented letters' named entities (&eacute; = e + acute) */
const MARKS: Record<string, number> = { acute: 0x301, grave: 0x300, uml: 0x308, circ: 0x302, tilde: 0x303, cedil: 0x327, ring: 0x30a, caron: 0x30c };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const hex = e[1] === 'x' || e[1] === 'X';
      const n = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return n > 0 ? String.fromCodePoint(n) : all; } catch { return all; }
    }
    if (NAMED[e] !== undefined) return NAMED[e];
    const m = /^([a-zA-Z])(acute|grave|uml|circ|tilde|cedil|ring|caron)$/.exec(e);
    return m ? (m[1] + String.fromCharCode(MARKS[m[2]])).normalize('NFC') : all;
  });
}
