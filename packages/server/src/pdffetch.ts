/**
 * When a citation is added, its PDF is fetched into the project's `pdf/` directory as
 * `authorYY_title.pdf` (first author's last name, two-digit year, slugged title). Only open copies
 * are tried — arXiv when the entry has an arXiv id, else whatever open-access PDF OpenAlex knows
 * for the DOI, else a URL in the entry that already points at a PDF. Strictly additive: a file
 * that exists is never touched, and a failed fetch leaves nothing behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseBibtex, cleanTex, type BibEntry } from '@overlyx/core';
import { fetchImpl, type Hit } from './bibsearch.ts';

const MAX_PDF_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 60000;

const ascii = (s: string) => cleanTex(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** `vaswani17_attention_is_all_you_need.pdf` — the title slug is cut at a word boundary. */
export function pdfFileName(e: BibEntry): string {
  const first = (e.fields.author ?? '').split(/\s+and\s+/i)[0] ?? '';
  const last = first.includes(',') ? first.split(',')[0] : first.trim().split(/\s+/).pop() ?? '';
  const yy = e.year.replace(/\D/g, '').slice(0, 4).slice(-2);
  let title = cleanTex(e.title).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (title.length > 60) title = title.slice(0, 60).replace(/_[^_]*$/, '');
  return `${ascii(last) || 'anon'}${yy}_${title || 'untitled'}.pdf`;
}

const ARXIV_ID = /\b(\d{4}\.\d{4,5})(?:v\d+)?\b/;

/** Every arXiv id / DOI / PDF-looking URL the entry (and the search hit it came from) carries. */
export function pdfCandidates(e: BibEntry, hit?: Hit): string[] {
  const urls: string[] = [];
  const doi = (hit?.doi ?? e.fields.doi ?? '').replace(/^https?:\/\/doi\.org\//i, '').trim();
  let arxiv = hit?.arxiv ?? null;
  if (!arxiv && /arxiv/i.test(e.fields.archiveprefix ?? '') && e.fields.eprint) arxiv = ARXIV_ID.exec(e.fields.eprint)?.[1] ?? null;
  if (!arxiv && /^10\.48550\/arxiv\./i.test(doi)) arxiv = doi.replace(/^10\.48550\/arxiv\./i, '');
  for (const u of [e.fields.url, hit?.url]) {
    if (!arxiv && u && /arxiv\.org\/(?:abs|pdf)\//i.test(u)) arxiv = ARXIV_ID.exec(u)?.[1] ?? null;
  }
  if (arxiv) urls.push(`https://arxiv.org/pdf/${arxiv}`);
  for (const u of [e.fields.url, hit?.url]) if (u && /\.pdf(?:$|[?#])/i.test(u)) urls.push(u);
  if (doi && !/^10\.48550\//i.test(doi)) urls.push(`oa:${doi}`); // resolved via OpenAlex below
  return [...new Set(urls)];
}

/** Open-access PDF URLs OpenAlex knows for a DOI, best first. */
async function openAccessUrls(doi: string): Promise<string[]> {
  const r = await fetchImpl(`https://api.openalex.org/works/https://doi.org/${encodeURI(doi)}?select=best_oa_location,locations,open_access`);
  if (!r.ok) return [];
  const d: any = await r.json();
  const urls = [d.best_oa_location?.pdf_url, ...(d.locations ?? []).map((l: any) => l.pdf_url), d.open_access?.oa_url];
  return [...new Set(urls.filter((u: unknown): u is string => typeof u === 'string' && !!u))];
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT), redirect: 'follow' } as RequestInit);
  if (!r.ok) return null;
  const len = Number(r.headers.get('content-length') ?? 0);
  if (len > MAX_PDF_BYTES) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES || !buf.subarray(0, 5).toString('latin1').startsWith('%PDF-')) return null;
  return buf;
}

export interface PdfResult { file: string; existed: boolean }

/**
 * Fetch the PDF for one BibTeX entry into `<project>/pdf/`. Returns null when no open copy could
 * be found; never overwrites or removes anything already there.
 */
export async function fetchPdfForEntry(projectDir: string, bibtex: string, hit?: Hit): Promise<PdfResult | null> {
  const e = parseBibtex(bibtex)[0];
  if (!e) return null;
  const rel = path.join('pdf', pdfFileName(e));
  const abs = path.join(projectDir, rel);
  if (fs.existsSync(abs)) return { file: rel, existed: true };
  for (const candidate of pdfCandidates(e, hit)) {
    const urls = candidate.startsWith('oa:') ? await openAccessUrls(candidate.slice(3)).catch(() => []) : [candidate];
    for (const url of urls) {
      let buf: Buffer | null = null;
      try { buf = await downloadPdf(url); } catch { /* next candidate */ }
      if (!buf) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.overlyx-tmp';
      fs.writeFileSync(tmp, buf);
      try { fs.linkSync(tmp, abs); } // fails if the file appeared meanwhile — additive, never replace
      catch { fs.rmSync(tmp, { force: true }); return { file: rel, existed: true }; }
      fs.rmSync(tmp, { force: true });
      return { file: rel, existed: false };
    }
  }
  return null;
}
