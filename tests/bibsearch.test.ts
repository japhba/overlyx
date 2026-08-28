/**
 * Literature search + cited.bib (packages/server/src/bibsearch.ts) with the network stubbed:
 * query classification (DOI / arXiv / text), merging of OpenAlex + DBLP hits, Scholar-style keys,
 * rewriting fetched BibTeX, de-duplication against the project's .bib files, appending to cited.bib.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-bibsearch-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
mkdirSync(join(ROOT, 'projects', 'paper'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
const bs = await import('../packages/server/src/bibsearch.ts');
const { parseBibtex } = await import('../packages/core/src/bib.ts');

const DBLP_BIB = `@inproceedings{DBLP:conf/nips/VaswaniSPUJGKP17,
  author       = {Ashish Vaswani and
                  Noam Shazeer and
                  Niki Parmar},
  title        = {Attention is All you Need},
  booktitle    = {NeurIPS},
  pages        = {5998--6008},
  year         = {2017},
  timestamp    = {Thu, 21 Jan 2021 15:15:21 +0100},
  biburl       = {https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17.bib},
  bibsource    = {dblp computer science bibliography, https://dblp.org}
}`;
const CROSSREF_BIB = ` @article{LeCun_2015, title={Deep learning}, volume={521}, DOI={10.1038/nature14539}, journal={Nature}, author={LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey}, year={2015}, pages={436–444} }`;

// a fake network: OpenAlex, DBLP search, DBLP .bib, doi.org
const calls: string[] = [];
bs.setFetch((async (input: any, init?: any) => {
  const url = String(input); calls.push(url);
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const text = (t: string) => new Response(t, { status: 200 });
  if (url.startsWith('https://api.openalex.org/works?filter=title.search:')) return json({ results: [] });
  if (url.startsWith('https://api.openalex.org/works?filter=title_and_abstract.search:')) return json({ results: [
    { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.5555/3295222.3295349', display_name: 'Attention Is All You Need', publication_year: 2017, cited_by_count: 90000, type: 'article', authorships: [{ author: { display_name: 'Ashish Vaswani' } }, { author: { display_name: 'Noam Shazeer' } }], primary_location: { source: { display_name: 'NeurIPS' } } },
    { id: 'https://openalex.org/W2', doi: 'https://doi.org/10.48550/arXiv.1706.03762', display_name: 'Attention Is All You Need', publication_year: 2017, cited_by_count: 50, type: 'preprint', authorships: [{ author: { display_name: 'Ashish Vaswani' } }], primary_location: { source: null } },
    { id: 'https://openalex.org/W3', doi: null, display_name: 'Attention in speech separation', publication_year: 2021, cited_by_count: 10, type: 'article', authorships: [], primary_location: { landing_page_url: 'https://x.example/3' } },
  ] });
  if (url.startsWith('https://dblp.org/search/publ/api')) return json({ result: { hits: { hit: [
    { info: { key: 'conf/nips/VaswaniSPUJGKP17', title: 'Attention is All you Need.', year: '2017', venue: 'NeurIPS', doi: '10.5555/3295222.3295349', type: 'Conference and Workshop Papers', authors: { author: [{ text: 'Ashish Vaswani' }, { text: 'Noam Shazeer' }] }, ee: 'https://proceedings.neurips.cc/...' } },
    { info: { key: 'journals/x/Other21', title: 'Something &amp; else', year: '2021', venue: 'CoRR', authors: { author: { text: 'Only One' } } } },
  ] } } });
  if (url === 'https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17.bib') return text(DBLP_BIB);
  if (url.startsWith('https://doi.org/')) { if (init?.headers?.accept === 'application/x-bibtex' && url.includes('10.1038')) return text(CROSSREF_BIB); return new Response('nope', { status: 404 }); }
  return new Response('unknown ' + url, { status: 500 });
}) as typeof fetch);

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('literature search', () => {
  it('classifies queries: DOI (also as URL), arXiv id / URL, free text', () => {
    expect(bs.parseQuery('10.1038/nature14539')).toEqual({ kind: 'doi', doi: '10.1038/nature14539' });
    expect(bs.parseQuery('https://doi.org/10.1038/nature14539.')).toEqual({ kind: 'doi', doi: '10.1038/nature14539' });
    expect(bs.parseQuery('arXiv:1706.03762v5')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(bs.parseQuery('https://arxiv.org/abs/1706.03762')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(bs.parseQuery('1706.03762')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(bs.parseQuery('attention is all you need')).toEqual({ kind: 'text', text: 'attention is all you need' });
  });

  it('merges OpenAlex and DBLP hits (same DOI → one hit with DBLP key and citation count), ranks title matches first, preprint after the paper', async () => {
    const hits = await bs.searchLiterature('attention is all you need');
    expect(hits[0].title).toBe('Attention Is All You Need');
    expect(hits[0].dblp).toBe('conf/nips/VaswaniSPUJGKP17');
    expect(hits[0].citations).toBe(90000);
    expect(hits[0].sources.sort()).toEqual(['dblp', 'openalex']);
    expect(hits[0].doi).toBe('10.5555/3295222.3295349');
    // the arXiv preprint (same title, other DOI) is folded into the published paper, which keeps the arXiv id
    expect(hits[0].arxiv).toBe('1706.03762');
    expect(hits.filter(h => h.title === 'Attention Is All You Need')).toHaveLength(1);
    expect(hits.map(h => h.title)).toContain('Something & else');   // DBLP HTML entities decoded
    expect(hits.find(h => h.title === 'Something & else')!.authors).toEqual(['Only One']);
  });

  it('a DOI query is looked up at doi.org and answered from its BibTeX', async () => {
    const hits = await bs.searchLiterature('10.1038/nature14539');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ doi: '10.1038/nature14539', title: 'Deep learning', year: 2015, venue: 'Nature', sources: ['doi'] });
    expect(hits[0].authors).toEqual(['LeCun, Yann', 'Bengio, Yoshua', 'Hinton, Geoffrey']);
  });

  it('BibTeX comes from DBLP when it knows the paper, else doi.org, else it is generated', async () => {
    const hits = await bs.searchLiterature('attention is all you need');
    expect(await bs.bibtexFor(hits[0])).toContain('DBLP:conf/nips/VaswaniSPUJGKP17');
    const gen = await bs.bibtexFor(hits.find(h => h.title === 'Attention in speech separation')!);
    expect(gen).toMatch(/^@article\{tmp,\n  title = \{Attention in speech separation\}/);
    expect(gen).toContain('year = {2021}');
  });

  it('Scholar-style keys: lastname + year + first significant title word, ASCII only', () => {
    const e = parseBibtex(DBLP_BIB)[0];
    expect(bs.scholarKey(e)).toBe('vaswani2017attention');
    expect(bs.scholarKey(parseBibtex(CROSSREF_BIB)[0])).toBe('lecun2015deep');
    expect(bs.scholarKey(parseBibtex('@article{x, author={Müller, Jörg and Others}, title={The Über-Method: Towards a Theory}, year={2020}}')[0])).toBe('muller2020uber');
  });

  it('rewriteEntry replaces the key and drops DBLP bookkeeping fields', () => {
    const t = bs.rewriteEntry(DBLP_BIB, 'vaswani2017attention');
    expect(t.startsWith('@inproceedings{vaswani2017attention,')).toBe(true);
    expect(t).not.toMatch(/timestamp|biburl|bibsource/);
    expect(t.trimEnd().endsWith('}')).toBe(true);
    expect(parseBibtex(t)).toHaveLength(1);
    expect(parseBibtex(t)[0].fields.pages).toBe('5998--6008');
  });

  it('addToCitedBib appends to cited.bib, avoids duplicates by DOI or title, and keeps keys unique', () => {
    const dir = join(ROOT, 'projects', 'paper');
    writeFileSync(join(dir, 'refs.bib'), '@article{lecun2015deep, title={Deep learning}, author={LeCun, Yann}, year={2015}, doi={10.1038/nature14539}}\n');
    const r1 = bs.addToCitedBib(dir, DBLP_BIB);
    expect(r1).toMatchObject({ key: 'vaswani2017attention', file: 'cited.bib', existed: false });
    expect(r1.entry).toEqual({ key: 'vaswani2017attention', author: 'Vaswani et al.', year: '2017', title: 'Attention is All you Need' });
    expect(readFileSync(join(dir, 'cited.bib'), 'utf8')).toMatch(/^@inproceedings\{vaswani2017attention,/);
    // the same paper again (from another source, other key) → the existing key, nothing appended
    const r2 = bs.addToCitedBib(dir, '@misc{anything, title={Attention is all you need}, author={Vaswani, Ashish}, year={2017}}');
    expect(r2).toMatchObject({ key: 'vaswani2017attention', existed: true });
    // a paper that is in another .bib of the project (by DOI) → that key
    const r3 = bs.addToCitedBib(dir, CROSSREF_BIB);
    expect(r3).toMatchObject({ key: 'lecun2015deep', file: 'refs.bib', existed: true });
    // a different paper whose generated key collides → suffix
    const r4 = bs.addToCitedBib(dir, '@article{k, title={Attention mechanisms revisited}, author={Vaswani, Ashish}, year={2017}}');
    expect(r4.key).toBe('vaswani2017attentiona');
    const cited = readFileSync(join(dir, 'cited.bib'), 'utf8');
    expect(parseBibtex(cited).map(e => e.key)).toEqual(['vaswani2017attention', 'vaswani2017attentiona']);
    expect(() => bs.addToCitedBib(dir, 'not bibtex at all')).toThrow(/not a BibTeX entry/);
    expect(() => bs.addToCitedBib(dir, DBLP_BIB + '\n' + CROSSREF_BIB)).toThrow(/one BibTeX entry/);
    expect(existsSync(join(dir, 'cited.bib.overlyx-tmp'))).toBe(false);
  });
});
