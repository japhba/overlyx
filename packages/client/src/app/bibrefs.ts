/**
 * References in an agent reply that can go straight into the project's cited.bib: pasted BibTeX
 * entries (balanced-brace scan), bare DOIs, and arXiv ids (whose registered DOI lets doi.org
 * serve the BibTeX). The agent panel renders one "+ …" button per reference (api.bibAdd),
 * labelled "Author et al. year" when the entry says so (`nice`) — bare DOI / arXiv ids are
 * resolved to such a label by the panel — with the raw identifier as a small chip after it.
 */
export interface BibRef { label: string; kind: 'bibtex' | 'doi' | 'arxiv'; bibtex?: string; doi?: string; nice?: string }

/** "Smith et al. 2020" from a BibTeX entry's author/year fields, when they are usable. */
export function bibtexNice(entry: string): string | undefined {
  const a = /(?:^|[\s,{])author\s*=\s*[{"]([^{}"\n]+)/i.exec(entry)?.[1];
  if (!a) return undefined;
  const first = a.split(/\s+and\s+/i)[0].trim();
  const surname = (first.includes(',') ? first.split(',')[0] : first.split(/\s+/).pop() ?? '').replace(/[\\{}~]/g, '').trim();
  if (!surname || /[=@]/.test(surname)) return undefined;
  const year = /(?:^|[\s,{])year\s*=\s*["{]?(\d{4})/i.exec(entry)?.[1];
  return surname + (/\s+and\s+/i.test(a) ? ' et al.' : '') + (year ? ` ${year}` : '');
}

export function bibRefs(text: string): BibRef[] {
  const out: BibRef[] = [];
  const seen = new Set<string>();
  const push = (r: BibRef) => { const k = (r.bibtex ?? r.doi ?? '').toLowerCase(); if (!k || seen.has(k)) return; seen.add(k); out.push(r); };
  // pasted BibTeX entries, fenced or inline
  const covered: [number, number][] = [];
  const re = /@([a-zA-Z]{3,20})\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const open = re.lastIndex - 1;
    let depth = 0, i = open;
    for (; i < text.length && i < open + 20000; i++) { const c = text[i]; if (c === '{') depth++; else if (c === '}' && --depth === 0) break; }
    if (depth !== 0) continue;
    const entry = text.slice(m.index, i + 1);
    const key = /^@[a-zA-Z]+\s*\{\s*([^,\s]+)\s*,/.exec(entry)?.[1];
    if (!key) continue;
    covered.push([m.index, i + 1]);
    push({ label: key, kind: 'bibtex', bibtex: entry, nice: bibtexNice(entry) });
    re.lastIndex = i + 1;
  }
  const inCovered = (at: number) => covered.some(([a, b]) => at >= a && at < b);
  // bare DOIs
  const doiRe = /\b10\.\d{4,9}\/[^\s{}"'`,;()[\]]+/g;
  while ((m = doiRe.exec(text))) { if (inCovered(m.index)) continue; const doi = m[0].replace(/[.>]+$/, ''); push({ label: 'doi:' + doi.slice(0, 40), kind: 'doi', doi }); }
  // arXiv ids
  const arxRe = /\barXiv[:\s]+(\d{4}\.\d{4,5})(v\d+)?/gi;
  while ((m = arxRe.exec(text))) { if (inCovered(m.index)) continue; push({ label: 'arXiv:' + m[1], kind: 'arxiv', doi: '10.48550/arXiv.' + m[1] }); }
  return out.slice(0, 8);
}
