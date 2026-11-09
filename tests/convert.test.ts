import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LYX_LIB, lyxFilesIn } from './lyxlib.ts';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { writeLyx } from '../packages/core/src/lyx/writer.ts';
import { lyxToPmNode, pmToLyxBody } from '../packages/core/src/convert.ts';

const files = [...lyxFilesIn('/root/projects'), ...['doc', 'examples', 'templates'].flatMap(d => lyxFilesIn(join(LYX_LIB, d)))];

describe('LyX -> ProseMirror -> LyX', () => {
  for (const f of files) {
    it(f.replace('/root/', '').replace(LYX_LIB + '/', 'lyx/lib/'), () => {
      const src = readFileSync(f, 'utf8');
      const doc = parseLyx(src);
      const pm = lyxToPmNode(doc);          // validates against the schema
      const body = pmToLyxBody(pm);
      const out = writeLyx({ ...doc, body });
      const expected = writeLyx(doc);
      expect(out).toBe(expected);
    });
  }
});
