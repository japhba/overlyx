import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LYX_LIB, lyxFilesIn } from './lyxlib.ts';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { writeLyx } from '../packages/core/src/lyx/writer.ts';

const userFiles = lyxFilesIn('/root/projects');
const lyxFiles = ['doc', 'examples', 'templates'].flatMap(d => lyxFilesIn(join(LYX_LIB, d)));

describe('LyX parse/write round trip', () => {
  for (const f of [...userFiles, ...lyxFiles]) {
    it(f.replace('/root/', '').replace(LYX_LIB + '/', 'lyx/lib/'), () => {
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
