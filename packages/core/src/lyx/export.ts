import type { LyxDocument } from './ast.ts';
import { walkInsets } from './ast.ts';
import { writeLyx } from './writer.ts';

/** A native LyX file, without the .tex source's leading lines or OverLyX-only settings. */
export function exportLyx(doc: LyxDocument, included?: (filename: string) => string | undefined): string {
  const copy: LyxDocument = structuredClone(doc);
  copy.preamble = ['#LyX 2.4 created this file. For more info see https://www.lyx.org/'];
  // The model's synthetic 2.5 header is also used for .tex documents. Emit the established
  // 2.4 vocabulary so stable desktop LyX can open a download without a newer converter.
  copy.format = 615;
  copy.trailer = [];
  let raw = false;
  copy.header.lines = copy.header.lines.filter(line => {
    if (/^\\begin_(?:preamble|local_layout)$/.test(line)) raw = true;
    const keep = raw || !/^\\(?:overlyx_|crossref_package\b)/.test(line);
    if (/^\\end_(?:preamble|local_layout)$/.test(line)) raw = false;
    return keep;
  });
  if (!copy.header.lines.some(l => l.startsWith('\\use_refstyle '))) {
    const refstyle = doc.header.lines.some(l => /^\\crossref_package refstyle$/.test(l));
    copy.header.lines.push(`\\use_refstyle ${refstyle ? 1 : 0}`);
  }
  if (included) for (const { inset } of walkInsets(copy.body)) {
    if (inset.type !== 'Leaf' || inset.name !== 'CommandInset' || inset.arg !== 'include') continue;
    inset.params = inset.params.map(line => {
      const m = /^filename "(.*)"$/.exec(line);
      const replacement = m && included(m[1]);
      return replacement ? `filename "${replacement}"` : line;
    });
  }
  return writeLyx(copy);
}
