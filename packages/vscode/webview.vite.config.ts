import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import path from 'node:path';
import fs from 'node:fs';
import { buildVersion } from '../build-version';

/** MathJax and its fonts (the client's dependencies) */
const MATHJAX_PACKAGES = Object.keys(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../client/package.json'), 'utf8')).dependencies).filter(d => d.startsWith('@mathjax/'));

/**
 * Builds the two webview pages (the OverLyX editor and the PDF panel) into dist/webview/ with
 * relative asset paths — the extension host rewrites them to webview URIs (webviewHtml.ts).
 */
export default defineConfig({
  plugins: [preact()],
  define: { 'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(buildVersion) },
  root: path.resolve(__dirname, 'src/webview'),
  base: './',
  // MathJax's fonts load their per-block data from the package itself: pre-bundling MathJax for the
  // dev server would give those modules a second copy of MathJax's classes (client editor/lyxmath/mathfonts.ts)
  optimizeDeps: { exclude: MATHJAX_PACKAGES },
  resolve: {
    // `@overlyx/core` is its index; `@overlyx/core/md/index.ts` and the like are its modules
    alias: [
      { find: /^@overlyx\/core$/, replacement: path.resolve(__dirname, '../core/src/index.ts') },
      { find: /^@overlyx\/core\/(.*)$/, replacement: path.resolve(__dirname, '../core/src') + '/$1' },
      { find: '@client', replacement: path.resolve(__dirname, '../client/src') },
    ],
    dedupe: ['preact', 'prosemirror-model', 'prosemirror-state', 'prosemirror-view', 'prosemirror-transform', 'yjs'],
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        editor: path.resolve(__dirname, 'src/webview/editor.html'),
        pdf: path.resolve(__dirname, 'src/webview/pdf.html'),
        deliverable: path.resolve(__dirname, 'src/webview/deliverable.html'),
      },
    },
  },
});
