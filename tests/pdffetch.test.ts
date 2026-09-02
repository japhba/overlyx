/**
 * PDF fetch on citation add (packages/server/src/pdffetch.ts) with the network stubbed:
 * file naming (authorYY_title.pdf), candidate URLs (arXiv > PDF-looking URL > OpenAlex open
 * access), the %PDF sanity check, and that the fetch is strictly additive — an existing file is
 * never replaced.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-pdffetch-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
const PROJECT = join(ROOT, 'projects', 'paper');
mkdirSync(PROJECT, { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
const bs = await import('../packages/server/src/bibsearch.ts');
const pf = await import('../packages/server/src/pdffetch.ts');
const { parseBibtex } = await import('../packages/core/src/bib.ts');

const PDF = '%PDF-1.5\nfake pdf bytes\n%%EOF';
const calls: string[] = [];
bs.setFetch((async (input: any) => {
  const url = String(input); calls.push(url);
  if (url === 'https://arxiv.org/pdf/1706.03762') return new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (url.startsWith('https://api.openalex.org/works/https://doi.org/10.1038/nature14539')) {
    return new Response(JSON.stringify({ best_oa_location: { pdf_url: 'https://oa.example/paywalled.html' }, locations: [{ pdf_url: null }, { pdf_url: 'https://oa.example/lecun.pdf' }], open_access: { oa_url: 'https://oa.example/landing' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url === 'https://oa.example/lecun.pdf') return new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (url === 'https://oa.example/paywalled.html' || url === 'https://oa.example/landing') return new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (url.startsWith('https://api.openalex.org/works/')) return new Response('not found', { status: 404 });
  return new Response('unknown ' + url, { status: 500 });
}) as typeof fetch);

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

const VASWANI = `@inproceedings{vaswani2017attention,
  title={Attention is all you need},
  author={Vaswani, Ashish and Shazeer, Noam},
  booktitle={NeurIPS},
  year={2017},
  eprint={1706.03762},
  archivePrefix={arXiv}
}`;
const LECUN = `@article{lecun2015deep, title={Deep learning}, author={LeCun, Yann and Bengio, Yoshua}, journal={Nature}, year={2015}, doi={10.1038/nature14539}}`;

describe('pdf file names', () => {
  it('are authorYY_title.pdf, ASCII-folded, cut at a word boundary', () => {
    expect(pf.pdfFileName(parseBibtex(VASWANI)[0])).toBe('vaswani17_attention_is_all_you_need.pdf');
    expect(pf.pdfFileName(parseBibtex('@misc{x, title={Über die spezielle Relativitätstheorie}, author={Kaiser, {\\L}ukasz}, year={1905}}')[0]))
      .toBe('kaiser05_uber_die_spezielle_relativitatstheorie.pdf');
    const long = pf.pdfFileName(parseBibtex('@misc{x, title={A very long title that keeps going on and on and on until it far exceeds the limit}, author={Short, A}, year={2020}}')[0]);
    expect(long.length).toBeLessThanOrEqual(70);
    expect(long.startsWith('short20_a_very_long_title')).toBe(true);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(pf.pdfFileName(parseBibtex('@misc{x, title={No author or year}}')[0])).toBe('anon_no_author_or_year.pdf');
  });
});

describe('candidate URLs', () => {
  it('arXiv id (eprint / DOI / URL / hit) first, then PDF-looking URLs, then OpenAlex by DOI', () => {
    expect(pf.pdfCandidates(parseBibtex(VASWANI)[0])).toEqual(['https://arxiv.org/pdf/1706.03762']);
    expect(pf.pdfCandidates(parseBibtex('@misc{x, title={T}, doi={10.48550/arXiv.1706.03762}}')[0])).toEqual(['https://arxiv.org/pdf/1706.03762']);
    expect(pf.pdfCandidates(parseBibtex('@misc{x, title={T}, url={https://arxiv.org/abs/1706.03762v5}}')[0])).toEqual(['https://arxiv.org/pdf/1706.03762']);
    expect(pf.pdfCandidates(parseBibtex(LECUN)[0])).toEqual(['oa:10.1038/nature14539']);
    expect(pf.pdfCandidates(parseBibtex('@misc{x, title={T}, url={https://example.org/p.pdf}, doi={10.1/x}}')[0])).toEqual(['https://example.org/p.pdf', 'oa:10.1/x']);
    const hit = { arxiv: '1706.03762', doi: null, url: null } as any;
    expect(pf.pdfCandidates(parseBibtex('@misc{x, title={T}}')[0], hit)).toEqual(['https://arxiv.org/pdf/1706.03762']);
  });
});

describe('fetching', () => {
  it('downloads an arXiv PDF into pdf/', async () => {
    const r = await pf.fetchPdfForEntry(PROJECT, VASWANI);
    expect(r).toEqual({ file: 'pdf/vaswani17_attention_is_all_you_need.pdf', existed: false });
    expect(readFileSync(join(PROJECT, r!.file), 'latin1')).toBe(PDF);
  });

  it('is additive: a second fetch (and a name clash) never replaces the existing file', async () => {
    const abs = join(PROJECT, 'pdf', 'vaswani17_attention_is_all_you_need.pdf');
    writeFileSync(abs, 'my own annotated copy');
    const before = calls.length;
    const r = await pf.fetchPdfForEntry(PROJECT, VASWANI);
    expect(r).toEqual({ file: 'pdf/vaswani17_attention_is_all_you_need.pdf', existed: true });
    expect(calls.length).toBe(before);   // no network traffic either
    expect(readFileSync(abs, 'utf8')).toBe('my own annotated copy');
  });

  it('falls back to an OpenAlex open-access URL for a DOI, skipping answers that are not PDFs', async () => {
    const r = await pf.fetchPdfForEntry(PROJECT, LECUN);
    expect(r).toEqual({ file: 'pdf/lecun15_deep_learning.pdf', existed: false });
    expect(readFileSync(join(PROJECT, r!.file), 'latin1')).toBe(PDF);
    expect(calls).toContain('https://oa.example/paywalled.html');   // tried, rejected by the %PDF check
  });

  it('gives up quietly when the entry has no DOI, arXiv id or PDF URL', async () => {
    const before = calls.length;
    const r = await pf.fetchPdfForEntry(PROJECT, '@book{knuth1984texbook, title={The TeXbook}, author={Knuth, Donald E.}, year={1984}}');
    expect(r).toBeNull();
    expect(calls.length).toBe(before);
    expect(existsSync(join(PROJECT, 'pdf', 'knuth84_the_texbook.pdf'))).toBe(false);
  });
});
