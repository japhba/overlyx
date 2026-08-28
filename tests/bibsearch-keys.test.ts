/**
 * The Scholar-grade backends of the literature search (bibsearch.ts), stubbed: with a Semantic
 * Scholar key its ranking leads and its BibTeX is used; with a SerpApi key Google Scholar leads and
 * Scholar's own BibTeX is fetched through the cite endpoint. The open indexes only fill in.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-bibsearch-keys-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.S2_API_KEY = 's2-key';
process.env.SERPAPI_KEY = 'serp-key';
const bs = await import('../packages/server/src/bibsearch.ts');
const { config } = await import('../packages/server/src/config.ts');

const seen: string[] = [];
bs.setFetch((async (input: any, init?: any) => {
  const url = String(input); seen.push(url);
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://serpapi.com/search.json?engine=google_scholar&') && url.includes('FAIL')) return new Response('{"error":"Your account has run out of searches."}', { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://serpapi.com/search.json?engine=google_scholar&')) return json({ organic_results: [
    { result_id: 'abc123', title: 'Chaos in random neural networks', link: 'https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.61.259', publication_info: { summary: 'H Sompolinsky, A Crisanti, HJ SommersPhysical review letters, 1988•APS', authors: [{ name: 'H Sompolinsky' }, { name: 'A Crisanti' }] }, inline_links: { cited_by: { total: 1600 } } },
    { result_id: 'def456', title: '[PDF] On bifurcations and chaos in random neural networks', link: 'https://arxiv.org/abs/1234.56789', publication_info: { summary: 'B Doyon, B Cessac…Acta Biotheoretica, 1994•Springer' }, inline_links: {} },
  ] });
  if (url.startsWith('https://serpapi.com/search.json?engine=google_scholar_cite&')) return json({ links: [{ name: 'BibTeX', link: 'https://scholar.googleusercontent.com/scholar.bib?q=info:abc123' }, { name: 'EndNote', link: 'https://x' }] });
  if (url.startsWith('https://scholar.googleusercontent.com/scholar.bib')) return new Response('@article{sompolinsky1988chaos,\n  title={Chaos in random neural networks},\n  author={Sompolinsky, Haim and Crisanti, Andrea and Sommers, Hans-Jurgen},\n  journal={Physical review letters},\n  volume={61},\n  number={3},\n  pages={259},\n  year={1988},\n  publisher={APS}\n}');
  if (url.startsWith('https://api.semanticscholar.org/graph/v1/paper/search')) {
    expect(init?.headers?.['x-api-key']).toBe('s2-key');
    return json({ data: [
      { paperId: 'p1', title: 'Chaos in Random Neural Networks', year: 1988, venue: 'Physical Review Letters', citationCount: 1500, authors: [{ name: 'H. Sompolinsky' }, { name: 'A. Crisanti' }], externalIds: { DOI: '10.1103/PhysRevLett.61.259' }, publicationTypes: ['JournalArticle'], citationStyles: { bibtex: '@Article{Sompolinsky1988ChaosIR,\n author = {H. Sompolinsky and A. Crisanti and H. Sommers},\n journal = {Physical Review Letters},\n title = {Chaos in Random Neural Networks},\n year = {1988}\n}' } },
      { paperId: 'p2', title: 'Transition to chaos in random neuronal networks', year: 2015, venue: 'Physical Review X', citationCount: 300, authors: [{ name: 'J. Kadmon' }], externalIds: { DOI: '10.1103/PhysRevX.5.041030', ArXiv: '1508.06486' }, publicationTypes: ['JournalArticle'], citationStyles: { bibtex: '@Article{Kadmon2015,\n title = {Transition to chaos in random neuronal networks},\n author = {J. Kadmon and H. Sompolinsky},\n year = {2015}\n}' } },
    ] });
  }
  if (url.startsWith('https://api.openalex.org/works?filter=title.search:')) return json({ results: [] });
  if (url.startsWith('https://api.openalex.org/works?filter=title_and_abstract.search:')) return json({ results: [
    { id: 'https://openalex.org/W9', doi: 'https://doi.org/10.9999/famous', display_name: 'A very famous unrelated paper about chaos', publication_year: 2001, cited_by_count: 90000, type: 'article', authorships: [], primary_location: null },
    { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1103/PhysRevLett.61.259', display_name: 'Chaos in Random Neural Networks', publication_year: 1988, cited_by_count: 1115, type: 'article', authorships: [{ author: { display_name: 'Haim Sompolinsky' } }], primary_location: { source: { display_name: 'Physical Review Letters' } } },
  ] });
  if (url.startsWith('https://dblp.org/')) return json({ result: { hits: { hit: [] } } });
  return new Response('unknown ' + url, { status: 500 });
}) as typeof fetch);
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('Scholar-grade backends', () => {
  it('parses Scholar summaries as SerpApi delivers them', () => {
    expect(bs.parseScholarSummary('H Sompolinsky, A Crisanti, HJ SommersPhysical review letters, 1988•APS')).toEqual({ authors: ['H Sompolinsky', 'A Crisanti', 'HJ Sommers'], venue: 'Physical review letters', year: 1988 });
    expect(bs.parseScholarSummary('A Vaswani, N Shazeer, N Parmar…Advances in neural information…, 2017•proceedings.neurips.cc')).toEqual({ authors: ['A Vaswani', 'N Shazeer', 'N Parmar'], venue: 'Advances in neural information…', year: 2017 });
    expect(bs.parseScholarSummary('Y Terada, T ToyoizumiProceedings of the National Academy of Sciences, 2024•pnas.org')).toEqual({ authors: ['Y Terada', 'T Toyoizumi'], venue: 'Proceedings of the National Academy of Sciences', year: 2024 });
    expect(bs.parseScholarSummary('DT Mirikitani, N Nikolaev… Transactions on Neural Networks, 2009•ieeexplore.ieee.org').year).toBe(2009);
    expect(bs.parseScholarSummary('', ['X Y'])).toEqual({ authors: ['X Y'], venue: '', year: null });
    // the dashed shape
    expect(bs.parseScholarSummary('A Vaswani, N Shazeer, N Parmar… - Advances in neural information…, 2017 - proceedings.neurips.cc')).toEqual({ authors: ['A Vaswani', 'N Shazeer', 'N Parmar'], venue: 'Advances in neural information…', year: 2017 });
    expect(bs.parseScholarSummary('SO Goedeke - 2025 - bonndoc.ulb.uni-bonn.de')).toEqual({ authors: ['SO Goedeke'], venue: '', year: 2025 });
    expect(bs.parseScholarSummary('P Mineault - From Human Attention to Computational Attention, 2025 - Springer')).toEqual({ authors: ['P Mineault'], venue: 'From Human Attention to Computational Attention', year: 2025 });
  });

  it('sources are listed best first', () => {
    expect(bs.sourcesAvailable()).toEqual(['Google Scholar', 'Semantic Scholar', 'OpenAlex', 'DBLP', 'doi.org']);
  });

  it('with a SerpApi key Google Scholar leads: its order is kept, the open indexes only add DOIs and citation counts', async () => {
    const hits = (await bs.searchLiterature('chaos in random neural networks')).hits;
    expect(hits[0]).toMatchObject({ title: 'Chaos in random neural networks', year: 1988, venue: 'Physical review letters', citations: 1600, scholarId: 'abc123', doi: '10.1103/PhysRevLett.61.259' });
    expect(hits[0].sources).toEqual(['scholar', 'openalex']);
    expect(hits[0].authors).toEqual(['H Sompolinsky', 'A Crisanti', 'HJ Sommers']);
    expect(hits[1]).toMatchObject({ title: 'On bifurcations and chaos in random neural networks', year: 1994, arxiv: '1234.56789', venue: 'Acta Biotheoretica' });
    expect(hits[1].authors).toEqual(['B Doyon', 'B Cessac']);
    // the famous unrelated OpenAlex paper is below everything Scholar listed
    expect(hits.findIndex(h => h.title.startsWith('A very famous'))).toBe(2);
  });

  it('when Google Scholar does not answer, the open indexes answer and a warning says so', async () => {
    const r = await bs.searchLiterature('chaos FAIL neural networks');
    expect(r.warnings).toEqual(['Google Scholar did not respond (Google Scholar (SerpApi): Your account has run out of searches.) — showing OpenAlex / DBLP results instead']);
    expect(r.hits.map(h => h.sources.join())).not.toContain('scholar');
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("Scholar's own BibTeX is fetched through the cite endpoint", async () => {
    const hits = (await bs.searchLiterature('chaos in random neural networks')).hits;
    const bib = await bs.bibtexFor(hits[0]);
    expect(bib).toContain('@article{sompolinsky1988chaos');
    expect(seen.some(u => u.includes('engine=google_scholar_cite') && u.includes('abc123'))).toBe(true);
  });

  it('with only a Semantic Scholar key its results lead and its BibTeX is used', async () => {
    const serp = config.serpApiKey; (config as any).serpApiKey = '';
    try {
      expect(bs.sourcesAvailable()).toEqual(['Semantic Scholar', 'OpenAlex', 'DBLP', 'doi.org']);
      const hits = (await bs.searchLiterature('chaos in random neural networks')).hits;
      expect(hits[0]).toMatchObject({ title: 'Chaos in Random Neural Networks', citations: 1500, doi: '10.1103/PhysRevLett.61.259' });
      expect(hits[0].sources).toEqual(['semanticscholar', 'openalex']);
      expect(hits[1]).toMatchObject({ title: 'Transition to chaos in random neuronal networks', arxiv: '1508.06486' });
      expect(await bs.bibtexFor(hits[1])).toContain('@Article{Kadmon2015');
    } finally { (config as any).serpApiKey = serp; }
  });
});
