/**
 * Paper links in the citation search (packages/server/src/citelinks.ts) and the account's Zotero
 * library (zotero.ts), with the network stubbed: what a link or an identifier names, how each kind is
 * resolved (published version before the preprint), the embedded-metadata fallback for any page, the
 * SSRF guard on pasted pages, and Zotero items as hits carrying slimmed BibTeX.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// a data directory of its own before the server modules load (their database is never production's)
const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-citelinks-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
const bs = await import('../packages/server/src/bibsearch.ts');
const cl = await import('../packages/server/src/citelinks.ts');
const zo = await import('../packages/server/src/zotero.ts');
const ng = await import('../packages/server/src/netguard.ts');

const VASWANI_DBLP = `@inproceedings{DBLP:conf/nips/VaswaniSPUJGKP17,
  author = {Ashish Vaswani and Noam Shazeer},
  title = {Attention is All you Need},
  booktitle = {NeurIPS}, year = {2017}
}`;
const ATOM = (doi = '') => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>http://arxiv.org/abs/1706.03762v7</id><updated>2023-08-02T00:41:18Z</updated><published>2017-06-12T17:57:34Z</published>
  <title>Attention Is All
    You Need</title><author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author>
  ${doi ? `<arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">${doi}</arxiv:doi>` : ''}
  <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
</entry></feed>`;
const DOI_BIB: Record<string, string> = {
  '10.1038/nature14539': '@article{LeCun_2015, title={Deep learning}, volume={521}, DOI={10.1038/nature14539}, journal={Nature}, author={LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey}, year={2015}}',
  '10.1101/2020.03.22.002386': '@misc{Gordon_2020, title={A SARS-CoV-2-Human Protein-Protein Interaction Map}, DOI={10.1101/2020.03.22.002386}, publisher={Cold Spring Harbor Laboratory}, author={Gordon, David E.}, year={2020}}',
  '10.1038/s41586-020-2286-9': '@article{Gordon_2020b, title={A SARS-CoV-2 protein interaction map reveals targets for drug repurposing}, DOI={10.1038/s41586-020-2286-9}, journal={Nature}, author={Gordon, David E.}, year={2020}}',
  '10.1016/j.neuron.2020.01.001': '@article{X_2020, title={A neuron paper}, DOI={10.1016/j.neuron.2020.01.001}, journal={Neuron}, author={Doe, Jane}, year={2020}}',
};
const html = (head: string, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const PAGES: Record<string, string> = {
  'https://journal.example/article/42': html(`<meta name="citation_title" content="Deep learning"><meta name="citation_doi" content="doi:10.1038/nature14539">`),
  'https://proceedings.mlr.press/v139/radford21a.html': html(`<meta name="citation_title" content="Learning Transferable Visual Models From Natural Language Supervision"><meta name="citation_author" content="Radford, Alec">`,
    `<code class="citecode" id="bibtex">@InProceedings{pmlr-v139-radford21a,<br>  title = {Learning Transferable Visual Models From Natural Language Supervision},<br>  author = {Radford, Alec and Kim, Jong Wook},<br>  booktitle = {Proceedings of the 38th International Conference on Machine Learning},<br>  pages = {8748--8763},<br>  year = {2021}<br>}</code>`),
  'https://conf.example/paper/7': html(`<meta name="citation_title" content="A Conference Paper Without A Doi Anywhere"><meta name="citation_author" content="Roe, Richard"><meta name="citation_publication_date" content="2019/12/08"><meta name="citation_conference_title" content="Some Conference">`,
    `<a href="/paper/7-Bibtex.bib">Bibtex</a>`),
  'https://conf.example/paper/7-Bibtex.bib': '@inproceedings{roe2019conference, title = {A Conference Paper Without a DOI Anywhere}, author = {Roe, Richard}, booktitle = {Some Conference}, year = {2019}}',
  'https://blog.example/posts/scaling': html(`<title>Scaling laws, explained | A Blog</title><meta property="og:title" content="Scaling laws, explained"><meta property="og:site_name" content="A Blog"><meta property="article:published_time" content="2024-03-01T10:00:00Z">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"Scaling laws, explained","author":{"@type":"Person","name":"Ada Example"},"datePublished":"2024-03-01"}</script>`),
};

const calls: string[] = [];
bs.setFetch((async (input: any, init?: any) => {
  const url = String(input); calls.push(url);
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const text = (t: string, type = 'text/plain') => new Response(t, { status: 200, headers: { 'content-type': type } });
  const h = (init?.headers ?? {}) as Record<string, string>;
  if (url.startsWith('https://doi.org/')) { const doi = decodeURI(url.slice(16)); return DOI_BIB[doi] && h.accept === 'application/x-bibtex' ? text(DOI_BIB[doi]) : new Response('nope', { status: 404 }); }
  if (url.startsWith('https://export.arxiv.org/api/query?id_list=1706.03762')) return text(ATOM());
  if (url.startsWith('https://export.arxiv.org/api/query?id_list=2001.00001')) return text(ATOM('10.1038/nature14539'));
  if (url.startsWith('https://export.arxiv.org/api/query?id_list=2002.00002')) return text(ATOM().replace('Attention Is All\n    You Need', 'Deep Learning'));
  // DBLP's bot check (Anubis answers 202 with a page)
  if (url.startsWith('https://dblp.org/search/publ/api?q=Deep')) return new Response('<html><head><title>Making sure you&#39;re not a bot!</title></head></html>', { status: 202, headers: { 'content-type': 'text/html' } });
  if (url.startsWith('https://api.openalex.org/works?filter=title.search:Deep%20Learning')) return json({ results: [
    { id: 'W9', doi: 'https://doi.org/10.48550/arXiv.2002.00002', display_name: 'Deep Learning', publication_year: 2017, type: 'preprint', authorships: [{ author: { display_name: 'Ashish Vaswani' } }] },
    { id: 'W8', doi: 'https://doi.org/10.1038/nature14539', display_name: 'Deep learning', publication_year: 2015, type: 'article', authorships: [{ author: { display_name: 'Yann LeCun' } }] },
    { id: 'W7', doi: 'https://doi.org/10.1038/nature14539', display_name: 'Deep learning.', publication_year: 2018, type: 'article', authorships: [{ author: { display_name: 'A. Vaswani' } }] },
  ] });
  if (url.startsWith('https://api2.openreview.net/notes?id=blocked') || url.startsWith('https://api.openreview.net/notes?id=blocked')) return new Response(JSON.stringify({ name: 'ChallengeRequiredError', status: 403 }), { status: 403 });
  if (url === 'https://shielded.example/paper') return new Response('<!doctype html><html><head><title>Just a moment...</title></head></html>', { status: 403, headers: { 'content-type': 'text/html' } });
  if (url.startsWith('https://dblp.org/search/publ/api')) return json({ result: { hits: { hit: [
    { info: { key: 'journals/corr/VaswaniSPUJGKP17', title: 'Attention Is All You Need.', year: '2017', venue: 'CoRR', authors: { author: [{ text: 'Ashish Vaswani' }] } } },
    { info: { key: 'conf/nips/VaswaniSPUJGKP17', title: 'Attention is All you Need.', year: '2017', venue: 'NIPS', authors: { author: [{ text: 'Ashish Vaswani' }] } } },
  ] } } });
  if (url === 'https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17.bib') return text(VASWANI_DBLP);
  if (url.startsWith('https://api2.openreview.net/notes?id=v2paper')) return json({ notes: [{ id: 'v2paper', forum: 'v2paper', pdate: 1705000000000, content: {
    title: { value: 'A Paper at ICLR' }, authors: { value: ['Ann Author', 'Ben Author'] }, venue: { value: 'ICLR 2024 poster' },
    _bibtex: { value: '@inproceedings{\nauthor2024a,\ntitle={A Paper at {ICLR}},\nauthor={Ann Author and Ben Author},\nbooktitle={The Twelfth International Conference on Learning Representations},\nyear={2024},\nurl={https://openreview.net/forum?id=v2paper}\n}' } } }] });
  if (url.startsWith('https://api2.openreview.net/notes?id=v1paper')) return json({ notes: [] });
  if (url.startsWith('https://api.openreview.net/notes?id=v1paper')) return json({ notes: [{ id: 'v1paper', forum: 'v1paper', content: { title: 'An Older Paper', authors: ['Cy Author'], venue: 'ICLR 2021 Poster', _bibtex: '@inproceedings{author2021an,\ntitle={An Older Paper},\nauthor={Cy Author},\nbooktitle={International Conference on Learning Representations},\nyear={2021},\nurl={https://openreview.net/forum?id=v1paper}\n}' } }] });
  if (url === 'https://api.biorxiv.org/details/biorxiv/10.1101/2020.03.22.002386') return json({ collection: [{ doi: '10.1101/2020.03.22.002386', title: 'A SARS-CoV-2-Human Protein-Protein Interaction Map', published: '10.1038/s41586-020-2286-9', server: 'biorxiv' }] });
  if (url.startsWith('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=26017442')) return json({ result: { uids: ['26017442'], 26017442: { title: 'Deep learning.', articleids: [{ idtype: 'pubmed', value: '26017442' }, { idtype: 'doi', value: '10.1038/nature14539' }] } } });
  if (url.startsWith('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=11111111')) return json({ result: { 11111111: { title: 'An old paper without a DOI.', pubdate: '1987 Mar', fulljournalname: 'Journal of Examples', volume: '12', issue: '3', pages: '101-9', authors: [{ name: 'Smith JA', authtype: 'Author' }, { name: 'Doe J', authtype: 'Author' }], articleids: [{ idtype: 'pubmed', value: '11111111' }] } } });
  if (url.startsWith('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pmc&id=4302165')) return json({ result: { 4302165: { title: 'x', articleids: [{ idtype: 'pmid', value: '26017442' }, { idtype: 'doi', value: '10.1038/nature14539' }] } } });
  if (url === 'https://aclanthology.org/2020.acl-main.463.bib') return text('@inproceedings{bender-koller-2020-climbing,\n    title = "Climbing towards {NLU}: On Meaning, Form, and Understanding in the Age of Data",\n    author = "Bender, Emily M.  and Koller, Alexander",\n    booktitle = "Proceedings of the 58th Annual Meeting of the Association for Computational Linguistics",\n    year = "2020",\n    doi = "10.18653/v1/2020.acl-main.463",\n}');
  if (url.startsWith('https://api.crossref.org/works?filter=alternative-id:S0896627320300000')) return json({ message: { items: [{ DOI: '10.1016/j.neuron.2020.01.001' }] } });
  if (url.startsWith('https://openlibrary.org/api/books?bibkeys=ISBN:9780262033848')) return json({ 'ISBN:9780262033848': { title: 'Introduction to Algorithms', authors: [{ name: 'Thomas H. Cormen' }, { name: 'Charles E. Leiserson' }], publishers: [{ name: 'MIT Press' }], publish_date: '2009' } });
  if (url.startsWith('https://api.openalex.org/')) return json({ results: [] });
  if (PAGES[url]) return text(PAGES[url], url.endsWith('.bib') ? 'text/plain' : 'text/html; charset=utf-8');
  // Zotero
  if (url === 'https://api.zotero.org/keys/current') {
    if (h['Zotero-API-Key'] !== 'abcdefghijklmnopqrstuvwx') return new Response('Forbidden', { status: 403 });
    return json({ key: 'abcdefghijklmnopqrstuvwx', userID: 777, username: 'reader', access: { user: { library: true }, groups: { all: { library: true, write: false } } } });
  }
  if (url.startsWith('https://api.zotero.org/users/777/groups')) return json([{ id: 4242, data: { id: 4242, name: 'Lab papers' } }]);
  if (url.startsWith('https://api.zotero.org/users/777/items/top?')) return json([
    { key: 'AAAA1111', data: { key: 'AAAA1111', itemType: 'journalArticle', title: 'Deep learning', creators: [{ creatorType: 'author', firstName: 'Yann', lastName: 'LeCun' }, { creatorType: 'editor', name: 'Ed Itor' }], date: '2015-05-28', publicationTitle: 'Nature', DOI: '10.1038/nature14539' },
      bibtex: '\n@article{lecun_deep_2015,\n\ttitle = {Deep learning},\n\tvolume = {521},\n\tabstract = {Deep learning allows {computational} models, e.g. x = y,\n\t\tto learn},\n\tjournal = {Nature},\n\tauthor = {LeCun, Yann},\n\tmonth = may,\n\tyear = {2015},\n\tkeywords = {ml, nets},\n\tfile = {Full Text:/tmp/x.pdf:application/pdf},\n}\n' },
    { key: 'NOTE0001', data: { key: 'NOTE0001', itemType: 'note', note: '<p>hi</p>' } },
  ]);
  if (url.startsWith('https://api.zotero.org/groups/4242/items/top?')) return json([
    { key: 'BBBB2222', data: { key: 'BBBB2222', itemType: 'preprint', title: 'Attention Is All You Need', creators: [{ creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' }], date: '2017', repository: 'arXiv', extra: 'arXiv:1706.03762 [cs]' }, bibtex: '@misc{vaswani_attention_2017, title = {Attention {Is} {All} {You} {Need}}, author = {Vaswani, Ashish}, year = {2017}}' },
  ]);
  return new Response('unknown ' + url, { status: 500 });
}) as typeof fetch);

// pasted pages: public hosts resolve to a public address, the intranet to a private one
ng.setResolver(async host => (host === 'intranet.example' ? ['10.1.2.3'] : ['93.184.216.34']));

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('what a link or an identifier names', () => {
  const id = cl.identify;
  it('arXiv: ids old and new, prefixes, versions, PDFs and mirrors', () => {
    expect(id('1706.03762')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(id('arXiv:1706.03762v5')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(id('arXiv:math.GT/0309136')).toEqual({ kind: 'arxiv', id: 'math.GT/0309136' });
    expect(id('hep-th/9901001v2')).toEqual({ kind: 'arxiv', id: 'hep-th/9901001' });
    expect(id('https://arxiv.org/abs/1706.03762v5')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(id('arxiv.org/pdf/1706.03762v2.pdf')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(id('https://arxiv.org/abs/hep-th/9901001')).toEqual({ kind: 'arxiv', id: 'hep-th/9901001' });
    expect(id('https://ar5iv.labs.arxiv.org/html/1706.03762')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(id('https://www.alphaxiv.org/abs/2401.12345v2')).toEqual({ kind: 'arxiv', id: '2401.12345' });
    expect(id('https://huggingface.co/papers/2401.12345')).toEqual({ kind: 'arxiv', id: '2401.12345' });
    expect(id('https://doi.org/10.48550/arXiv.1706.03762')).toEqual({ kind: 'arxiv', id: '1706.03762' });
  });
  it('preprint servers, indexes and anthologies', () => {
    expect(id('https://openreview.net/forum?id=YicbFdNTTy&noteId=abc123')).toEqual({ kind: 'openreview', id: 'YicbFdNTTy' });
    expect(id('https://openreview.net/pdf?id=YicbFdNTTy')).toEqual({ kind: 'openreview', id: 'YicbFdNTTy' });
    expect(id('https://www.biorxiv.org/content/10.1101/2020.03.22.002386v3.full.pdf')).toEqual({ kind: 'rxiv', doi: '10.1101/2020.03.22.002386' });
    expect(id('10.1101/2020.03.22.002386')).toEqual({ kind: 'rxiv', doi: '10.1101/2020.03.22.002386' });
    expect(id('10.1101/gad.1234.5')).toEqual({ kind: 'doi', doi: '10.1101/gad.1234.5' });   // a Cold Spring Harbor journal, not bioRxiv
    expect(id('https://pubmed.ncbi.nlm.nih.gov/26017442/')).toEqual({ kind: 'pubmed', pmid: '26017442' });
    expect(id('PMID: 26017442')).toEqual({ kind: 'pubmed', pmid: '26017442' });
    expect(id('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4302165/')).toEqual({ kind: 'pmc', pmcid: '4302165' });
    expect(id('https://pmc.ncbi.nlm.nih.gov/articles/PMC4302165/')).toEqual({ kind: 'pmc', pmcid: '4302165' });
    expect(id('PMC4302165')).toEqual({ kind: 'pmc', pmcid: '4302165' });
    expect(id('https://europepmc.org/article/MED/26017442')).toEqual({ kind: 'pubmed', pmid: '26017442' });
    expect(id('https://aclanthology.org/2020.acl-main.463.pdf')).toEqual({ kind: 'acl', id: '2020.acl-main.463' });
    expect(id('https://www.aclweb.org/anthology/P19-1001/')).toEqual({ kind: 'acl', id: 'P19-1001' });
    expect(id('2020.acl-main.463')).toEqual({ kind: 'acl', id: '2020.acl-main.463' });
    expect(id('https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17.html')).toEqual({ kind: 'dblp', key: 'conf/nips/VaswaniSPUJGKP17' });
    expect(id('https://www.semanticscholar.org/paper/Attention-is-All-you-Need-Vaswani-Shazeer/204e3073870fae3d05bcbc2f6a8e263d9b72e776')).toEqual({ kind: 's2', id: '204e3073870fae3d05bcbc2f6a8e263d9b72e776' });
    expect(id('https://psyarxiv.com/abc12')).toEqual({ kind: 'doi', doi: '10.31234/osf.io/abc12' });
    expect(id('https://osf.io/preprints/socarxiv/xyz98')).toEqual({ kind: 'doi', doi: '10.31235/osf.io/xyz98' });
    expect(id('https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1234567')).toEqual({ kind: 'doi', doi: '10.2139/ssrn.1234567' });
    expect(id('https://zenodo.org/records/7654321')).toEqual({ kind: 'doi', doi: '10.5281/zenodo.7654321' });
    expect(id('https://hal.science/hal-01234567v2/document')).toEqual({ kind: 'bib', url: 'https://api.archives-ouvertes.fr/search/?q=halId_s:hal-01234567&wt=bibtex', page: 'https://hal.science/hal-01234567' });
    expect(id('https://jmlr.org/papers/volume21/20-074/20-074.pdf')).toEqual({ kind: 'bib', url: 'https://jmlr.org/papers/v21/20-074.bib', page: 'https://jmlr.org/papers/v21/20-074.html' });
  });
  it('publishers: a DOI anywhere in the link, article numbers, PIIs', () => {
    expect(id('https://www.nature.com/articles/s41586-021-03819-2')).toEqual({ kind: 'doi', doi: '10.1038/s41586-021-03819-2' });
    expect(id('https://dl.acm.org/doi/abs/10.1145/3292500.3330701')).toEqual({ kind: 'doi', doi: '10.1145/3292500.3330701' });
    expect(id('https://onlinelibrary.wiley.com/doi/epdf/10.1002/anie.202012345')).toEqual({ kind: 'doi', doi: '10.1002/anie.202012345' });
    expect(id('https://www.frontiersin.org/articles/10.3389/fnins.2020.00001/full')).toEqual({ kind: 'doi', doi: '10.3389/fnins.2020.00001' });
    expect(id('https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0185809')).toEqual({ kind: 'doi', doi: '10.1371/journal.pone.0185809' });
    expect(id('https://link.springer.com/content/pdf/10.1007/s00453-020-00700-1.pdf')).toEqual({ kind: 'doi', doi: '10.1007/s00453-020-00700-1' });
    expect(id('https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.116.061102')).toEqual({ kind: 'doi', doi: '10.1103/PhysRevLett.116.061102' });
    expect(id('https://elifesciences.org/articles/12345')).toEqual({ kind: 'doi', doi: '10.7554/eLife.12345' });
    expect(id('https://www.sciencedirect.com/science/article/pii/S0896627320300000')).toEqual({ kind: 'pii', pii: 'S0896627320300000' });
    expect(id('https://www.cell.com/neuron/fulltext/S0896-6273(20)30000-0')).toEqual({ kind: 'pii', pii: 'S0896627320300000' });
    expect(id('doi: 10.1038/nature14539.')).toEqual({ kind: 'doi', doi: '10.1038/nature14539' });
  });
  it('proceedings PDFs go to their pages; anything else is a page; words are a search', () => {
    expect(id('https://proceedings.mlr.press/v139/radford21a/radford21a.pdf')).toEqual({ kind: 'page', url: 'https://proceedings.mlr.press/v139/radford21a.html' });
    expect(id('https://proceedings.neurips.cc/paper_files/paper/2022/file/0123456789abcdef0123456789abcdef-Paper-Conference.pdf'))
      .toEqual({ kind: 'page', url: 'https://proceedings.neurips.cc/paper_files/paper/2022/hash/0123456789abcdef0123456789abcdef-Abstract-Conference.html' });
    expect(id('https://openaccess.thecvf.com/content/CVPR2022/papers/Doe_Thing_CVPR_2022_paper.pdf')).toEqual({ kind: 'page', url: 'https://openaccess.thecvf.com/content/CVPR2022/html/Doe_Thing_CVPR_2022_paper.html' });
    expect(id('https://blog.example/posts/scaling')).toEqual({ kind: 'page', url: 'https://blog.example/posts/scaling' });
    expect(id('ISBN 978-0-262-03384-8')).toEqual({ kind: 'isbn', isbn: '9780262033848' });
    expect(id('9780262033848')).toEqual({ kind: 'isbn', isbn: '9780262033848' });
    expect(id('attention is all you need')).toBeNull();
    expect(id('Smith 2020')).toBeNull();
    expect(id('1234567890')).toBeNull();
  });
});

describe('resolving a link', () => {
  it('arXiv: the published version (DBLP, not its CoRR copy) first, then the preprint with its first version\'s year', async () => {
    const { hits, warnings } = await bs.searchLiterature('https://arxiv.org/abs/1706.03762v7');
    expect(warnings).toEqual([]);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ note: 'Published version', dblp: 'conf/nips/VaswaniSPUJGKP17', arxiv: '1706.03762' });
    expect(await bs.bibtexFor(hits[0])).toContain('DBLP:conf/nips/VaswaniSPUJGKP17');
    expect(hits[1]).toMatchObject({ note: 'arXiv preprint', title: 'Attention Is All You Need', year: 2017, authors: ['Ashish Vaswani', 'Noam Shazeer'] });
    const pre = await bs.bibtexFor(hits[1]);
    expect(pre).toMatch(/^@misc\{tmp,/);
    expect(pre).toContain('eprint = {1706.03762}');
    expect(pre).toContain('archivePrefix = {arXiv}');
    expect(pre).toContain('primaryClass = {cs.CL}');
    expect(pre).toContain('year = {2017}');
  });
  it('arXiv: a journal DOI the authors gave arXiv is the published version', async () => {
    const { hits } = await cl.resolveLink({ kind: 'arxiv', id: '2001.00001' });
    expect(hits[0]).toMatchObject({ doi: '10.1038/nature14539', note: 'Published version', venue: 'Nature' });
  });
  it('arXiv: with DBLP behind a bot check, OpenAlex\'s non-preprint work of the same title and first author', async () => {
    const { hits } = await cl.resolveLink({ kind: 'arxiv', id: '2002.00002' });
    // not the preprint's own DOI, not LeCun's same-titled paper: the 2018 one by the same first author
    expect(hits.map(h => h.note)).toEqual(['Published version', 'arXiv preprint']);
    expect(hits[0].doi).toBe('10.1038/nature14539');
  });
  it('a bot check is said as such (OpenReview, Cloudflare), never taken for the paper', async () => {
    const or = await bs.searchLiterature('https://openreview.net/forum?id=blocked1');
    expect(or.hits).toEqual([]);
    expect(or.warnings[0]).toMatch(/OpenReview asks this server for a browser check.*type the paper’s title instead/);
    const page = await bs.searchLiterature('https://shielded.example/paper');
    expect(page.hits).toEqual([]);
    expect(page.warnings[0]).toMatch(/shielded\.example asks for a browser check/);
  });
  it('OpenReview: the note\'s own BibTeX and venue (API v2, else v1)', async () => {
    const v2 = (await cl.resolveLink(cl.identify('https://openreview.net/forum?id=v2paper')!)).hits[0];
    expect(v2).toMatchObject({ title: 'A Paper at ICLR', venue: 'ICLR 2024 poster', year: 2024, url: 'https://openreview.net/forum?id=v2paper', authors: ['Ann Author', 'Ben Author'] });
    expect(v2.bibtex).toContain('booktitle={The Twelfth International Conference on Learning Representations}');
    const v1 = (await cl.resolveLink(cl.identify('https://openreview.net/pdf?id=v1paper')!)).hits[0];
    expect(v1).toMatchObject({ title: 'An Older Paper', venue: 'ICLR 2021 Poster', year: 2021 });
  });
  it('bioRxiv: the journal version first, the preprint second', async () => {
    const { hits } = await cl.resolveLink(cl.identify('https://www.biorxiv.org/content/10.1101/2020.03.22.002386v3')!);
    expect(hits.map(h => [h.doi, h.note])).toEqual([['10.1038/s41586-020-2286-9', 'Published version'], ['10.1101/2020.03.22.002386', 'bioRxiv preprint']]);
  });
  it('PubMed and PMC: through the DOI; without one, an entry from PubMed\'s summary', async () => {
    expect((await cl.resolveLink({ kind: 'pubmed', pmid: '26017442' })).hits[0]).toMatchObject({ doi: '10.1038/nature14539', title: 'Deep learning' });
    expect((await cl.resolveLink({ kind: 'pmc', pmcid: '4302165' })).hits[0]).toMatchObject({ doi: '10.1038/nature14539' });
    const old = (await cl.resolveLink({ kind: 'pubmed', pmid: '11111111' })).hits[0];
    expect(old).toMatchObject({ title: 'An old paper without a DOI', year: 1987, venue: 'Journal of Examples', authors: ['Smith, J. A.', 'Doe, J.'] });
    expect(old.bibtex).toContain('pages = {101--9}');
    expect(old.bibtex).toContain('pmid = {11111111}');
  });
  it('ACL Anthology, Elsevier PIIs and books', async () => {
    expect((await cl.resolveLink(cl.identify('https://aclanthology.org/2020.acl-main.463/')!)).hits[0]).toMatchObject({ doi: '10.18653/v1/2020.acl-main.463', year: 2020, authors: ['Bender, Emily M.', 'Koller, Alexander'] });
    expect((await cl.resolveLink(cl.identify('https://www.sciencedirect.com/science/article/abs/pii/S0896627320300000')!)).hits[0]).toMatchObject({ doi: '10.1016/j.neuron.2020.01.001' });
    const book = (await cl.resolveLink(cl.identify('ISBN 978-0-262-03384-8')!)).hits[0];
    expect(book.bibtex).toContain('@book{tmp,');
    expect(book.bibtex).toContain('publisher = {MIT Press}');
  });
  it('a DOI nobody knows is a warning, not an error', async () => {
    const r = await bs.searchLiterature('10.9999/nothing.here');
    expect(r.hits).toEqual([]);
    expect(r.warnings[0]).toMatch(/doi:10\.9999\/nothing\.here could not be looked up/);
  });
});

describe('any page: its embedded metadata', () => {
  it('reads Highwire, Dublin Core, JSON-LD and Open Graph, in that order', () => {
    const m = cl.pageMetadata(html(`
      <meta name="citation_title" content="Spikes &amp; Waves"><meta name="citation_author" content="Gr&ouml;n, Ada"><meta name="citation_author" content="Roe, Bo">
      <meta name="citation_publication_date" content="2021/05/03"><meta name="citation_journal_title" content="J. Examples"><meta name="citation_volume" content="7">
      <meta name="citation_firstpage" content="10"><meta name="citation_lastpage" content="20"><meta name="DC.identifier" content="doi:10.5555/abc.123">
      <meta property="og:title" content="Not this one">`), 'https://x.example/a');
    expect(m).toMatchObject({ title: 'Spikes & Waves', authors: ['Grön, Ada', 'Roe, Bo'], year: 2021, journal: 'J. Examples', volume: '7', firstPage: '10', lastPage: '20', doi: '10.5555/abc.123', kind: 'article', scholarly: true });
    const ld = cl.pageMetadata(html(`<script type="application/ld+json">{"@graph":[{"@type":"WebSite","name":"Site"},{"@type":"ScholarlyArticle","headline":"A Linked Data Paper","author":[{"@type":"Person","givenName":"Al","familyName":"Bert"}],"datePublished":"2018-01-01","isPartOf":{"@type":"PublicationIssue","isPartOf":{"@type":"Periodical","name":"Data Journal"}},"identifier":{"propertyID":"doi","value":"https://doi.org/10.5555/ld.1"}}]}</script>`), 'https://x.example/b');
    expect(ld).toMatchObject({ title: 'A Linked Data Paper', authors: ['Al Bert'], year: 2018, journal: 'Data Journal', doi: '10.5555/ld.1', scholarly: true });
  });
  it('a DOI the page declares: doi.org\'s BibTeX', async () => {
    expect((await bs.searchLiterature('https://journal.example/article/42')).hits[0]).toMatchObject({ doi: '10.1038/nature14539', venue: 'Nature' });
  });
  it('the page\'s own BibTeX, inline (PMLR) or linked (NeurIPS, JMLR), when its title is the page\'s', async () => {
    const pmlr = (await bs.searchLiterature('https://proceedings.mlr.press/v139/radford21a/radford21a.pdf')).hits[0];
    expect(pmlr).toMatchObject({ title: 'Learning Transferable Visual Models From Natural Language Supervision', year: 2021, venue: 'Proceedings of the 38th International Conference on Machine Learning' });
    expect(pmlr.bibtex).toContain('pages = {8748--8763}');
    const linked = (await bs.searchLiterature('https://conf.example/paper/7')).hits[0];
    expect(linked.bibtex).toContain('@inproceedings{roe2019conference');
  });
  it('a web page becomes a @misc with its address and the day it was read', async () => {
    const { hits } = await bs.searchLiterature('https://blog.example/posts/scaling');
    expect(hits[0]).toMatchObject({ title: 'Scaling laws, explained', authors: ['Ada Example'], year: 2024, note: 'Web page' });
    expect(hits[0].bibtex).toMatch(/^@misc\{tmp,/);
    expect(hits[0].bibtex).toContain('howpublished = {A Blog}');
    expect(hits[0].bibtex).toContain('url = {https://blog.example/posts/scaling}');
    expect(hits[0].bibtex).toMatch(/urldate = \{\d{4}-\d\d-\d\d\}/);
  });
  it('never fetches a page on the local network', async () => {
    const before = calls.length;
    const r = await bs.searchLiterature('http://intranet.example/paper');
    expect(r.hits).toEqual([]);
    expect(r.warnings[0]).toMatch(/refused/);
    expect(calls.slice(before).some(u => u.includes('intranet.example'))).toBe(false);
  });
  it('escapes BibTeX specials outside addresses', () => {
    expect(cl.bibEntry('misc', [['title', 'R&D at 50% #1'], ['url', 'https://x.example/?a=1&b=50%']])).toBe('@misc{tmp,\n  title = {R\\&D at 50\\% \\#1},\n  url = {https://x.example/?a=1&b=50%}\n}\n');
  });
});

describe('Zotero', () => {
  it('a key is checked with Zotero; its library and readable groups are kept, the key never shown', async () => {
    await expect(zo.connectZotero(1, 'short')).rejects.toThrow(/24 letters/);
    await expect(zo.connectZotero(1, 'zzzzzzzzzzzzzzzzzzzzzzzz')).rejects.toThrow(/does not know this key/);
    const s = await zo.connectZotero(1, 'abcdefghijklmnopqrstuvwx');
    expect(s).toEqual({ connected: true, username: 'reader', libraries: ['My Library', 'Lab papers'] });
    expect(JSON.stringify(zo.zoteroStatus(1))).not.toContain('abcdefghijklmnopqrstuvwx');
  });
  it('searches the library and the groups: items as hits with slimmed BibTeX, notes left out', async () => {
    const r = await zo.searchZotero(1, 'deep');
    expect(r!.warnings).toEqual([]);
    expect(r!.hits.map(h => h.title)).toEqual(['Deep learning', 'Attention Is All You Need']);
    const [mine, group] = r!.hits;
    expect(mine).toMatchObject({ doi: '10.1038/nature14539', authors: ['Yann LeCun'], year: 2015, venue: 'Nature', sources: ['zotero'], note: 'Your Zotero library' });
    expect(mine.bibtex).toBe('@article{lecun_deep_2015,\n\ttitle = {Deep learning},\n\tvolume = {521},\n\tjournal = {Nature},\n\tauthor = {LeCun, Yann},\n\tmonth = may,\n\tyear = {2015}\n}');
    expect(group).toMatchObject({ arxiv: '1706.03762', note: 'Zotero · Lab papers', venue: 'arXiv' });
    expect(calls.some(u => u.startsWith('https://api.zotero.org/users/777/items/top?') && u.includes('include=data%2Cbibtex') && u.includes('qmode=titleCreatorYear'))).toBe(true);
    expect(await bs.bibtexFor(mine)).toContain('lecun_deep_2015');
  });
  it('disconnecting forgets the key', async () => {
    zo.disconnectZotero(1);
    expect(zo.zoteroStatus(1)).toEqual({ connected: false });
    expect(await zo.searchZotero(1, 'deep')).toBeNull();
  });
});
