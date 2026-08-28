/** Rewrite .lyx files through OverLyX's parser + writer (LyX's canonical form): npx tsx scripts/normalize-lyx.ts file.lyx … */
import fs from 'node:fs';
import { parseLyx, writeLyx } from '../packages/core/src/index.ts';
for (const f of process.argv.slice(2)) {
  const text = fs.readFileSync(f, 'utf8');
  const out = writeLyx(parseLyx(text));
  const again = writeLyx(parseLyx(out));
  if (again !== out) { console.error(`${f}: writer is not idempotent`); process.exit(1); }
  fs.writeFileSync(f, out);
  console.log(`${f}: ${text === out ? 'already canonical' : 'normalised'} (${out.length} bytes)`);
}
