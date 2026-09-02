import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import path from 'node:path';

/**
 * Builds the two webview pages (the OverLyX editor and the PDF panel) into dist/webview/ with
 * relative asset paths — the extension host rewrites them to webview URIs (webviewHtml.ts).
 */
export default defineConfig({
  plugins: [preact()],
  root: path.resolve(__dirname, 'src/webview'),
  base: './',
  resolve: {
    alias: {
      '@overlyx/core': path.resolve(__dirname, '../core/src/index.ts'),
      '@client': path.resolve(__dirname, '../client/src'),
    },
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
      },
    },
  },
});
