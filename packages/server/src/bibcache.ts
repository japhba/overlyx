/**
 * Parsed BibTeX files, shared by the documents' bibliography routes (index.ts) and the HTML
 * deliverables (deliverables.ts: the entries a deck cites, given to its runtime).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseBibtex } from '@overlyx/core';
import { config } from './config.ts';

/**
 * Parsed BibTeX files, cached in memory and on disk (data/cache/bib-*.json) by path + mtime + size:
 * bibliographies are often several MB and parsing one takes over a second, which used to make the
 * first open of a document after a server restart slow.
 */
const bibCache = new Map<string, { key: string; entries: ReturnType<typeof parseBibtex> }>();
export function cachedBib(abs: string): ReturnType<typeof parseBibtex> {
  try {
    const st = fs.statSync(abs);
    const key = `${st.mtimeMs}:${st.size}:v2`;   // v2: entries carry the (short) author list
    const hit = bibCache.get(abs);
    if (hit && hit.key === key) return hit.entries;
    const diskFile = path.join(config.dataDir, 'cache', 'bib-' + crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16) + '.json');
    let entries: ReturnType<typeof parseBibtex> | null = null;
    try {
      const cached = JSON.parse(fs.readFileSync(diskFile, 'utf8')) as { key: string; entries: ReturnType<typeof parseBibtex> };
      if (cached.key === key && Array.isArray(cached.entries)) entries = cached.entries;
    } catch { /* no disk cache */ }
    if (!entries) {
      // `author`: the "A and B" / "A et al." form shown in the editor and the citation dialog
      entries = parseBibtex(fs.readFileSync(abs, 'utf8')).map(e => ({ ...e, key: String(e.key ?? ''), author: String(e.authorShort || e.fields?.author || ''), year: String(e.year ?? ''), title: String(e.title ?? '') }));
      try { fs.writeFileSync(diskFile, JSON.stringify({ key, entries })); } catch { /* cache dir not writable: ignore */ }
    }
    bibCache.set(abs, { key, entries });
    return entries;
  } catch { return []; }
}
