import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { writeLyx } from '../packages/core/src/lyx/writer.ts';
import { lyxToPmNode, pmToLyxBody } from '../packages/core/src/convert.ts';

function collect(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) collect(p, out); else if (f.endsWith('.lyx')) out.push(p);
  }
  return out;
}
const files = [...collect('/root/projects'), ...collect('/root/lyx/lib/doc'), ...collect('/root/lyx/lib/examples'), ...collect('/root/lyx/lib/templates')];

describe('LyX -> ProseMirror -> LyX', () => {
  for (const f of files) {
    it(f.replace('/root/', ''), () => {
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
