// @vitest-environment happy-dom
/**
 * Things that worked in Chromium only — findings of the e2e suite run in WebKit (Safari's engine) and
 * Firefox, and of probes of what a Safari / iPad user does (scratch/browsers/). One block per fix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The PDF viewer loads pdf.js's legacy build: the default one needs Map.getOrInsertComputed,
 * Math.sumPrecise and the Iterator global (Safari 26.2, Firefox 144, Chrome 147) and stopped the whole
 * app from starting in older Safari (`Iterator` is evaluated when pdf.js is imported).
 */
describe('pdf.js', () => {
  it('the web client and the VS Code PDF panel load the legacy build (and its worker), never the default one', () => {
    for (const f of ['packages/client/src/app/PdfViewer.tsx', 'packages/vscode/src/webview/pdfMain.tsx']) {
      const src = readFileSync(f, 'utf8');
      const imports = [...src.matchAll(/from '(pdfjs-dist[^']*)'|'(pdfjs-dist\/[^']*worker[^']*)'/g)].map(m => m[1] ?? m[2]);
      expect(imports.length, f).toBeGreaterThan(0);
      for (const i of imports) expect(i, f).toMatch(/^pdfjs-dist\/legacy\/build\//);
    }
  });
});
