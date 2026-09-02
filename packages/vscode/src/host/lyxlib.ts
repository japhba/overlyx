/**
 * Where the LyX data files live. The core parser/writer take a `layoutDir` and read the rest of
 * the LyX lib/ (languages, unicodesymbols, symbols, latexfonts) from its parent directory, so a
 * complete copy is bundled with the extension under dist/lyxlib/.
 */
import fs from 'node:fs';
import path from 'node:path';

export function resolveLayoutDir(configured: string | undefined, extensionPath: string): string {
  const candidates = [
    configured?.trim() || undefined,
    process.env.LYX_LAYOUT_DIR,
    path.join(extensionPath, 'dist/lyxlib/layouts'),
    '/root/lyx/lib/layouts',
    path.join(extensionPath, '../../lyx/lib/layouts'),   // running from the source tree
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'article.layout'))) return c;
  }
  throw new Error('LyX layout files not found — set overlyx.layoutDir to a LyX lib/layouts directory');
}
