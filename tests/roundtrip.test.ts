import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { writeLyx } from '../packages/core/src/lyx/writer.ts';

function collect(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, out);
    else if (f.endsWith('.lyx')) out.push(p);
  }
  return out;
}

const userFiles = collect('/root/projects');
const lyxFiles = [...collect('/root/lyx/lib/doc'), ...collect('/root/lyx/lib/examples'), ...collect('/root/lyx/lib/templates')];

describe('LyX parse/write round trip', () => {
  for (const f of [...userFiles, ...lyxFiles]) {
    it(f.replace('/root/', ''), () => {
      const src = readFileSync(f, 'utf8');
      const doc = parseLyx(src);
      const out = writeLyx(doc);
      if (doc.format >= 620 && !f.endsWith('LFUNs.lyx')) {
        // LyX >= 2.4 wraps lines at sentence punctuation: we reproduce it byte-for-byte
        expect(out).toBe(src);
      } else {
        // older files are re-wrapped (as LyX itself does); require a stable semantic round trip
        const doc2 = parseLyx(out);
        expect(doc2.body).toEqual(doc.body);
        expect(writeLyx(doc2)).toBe(out);
      }
    });
  }
});
