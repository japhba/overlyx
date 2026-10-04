import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildVersion } from '../build-version';

/**
 * Each MathJax font's files (its per-block data, its woff2) in assets/mathjax/<font>/: the service
 * worker precaches only the default font (New Computer Modern); the others are fetched when chosen.
 */
const mathjaxFont = (id: string | null | undefined) => /@mathjax\/mathjax-([a-z0-9]+)-font(?:-extension)?\//.exec(id ?? '')?.[1];
export const MATHJAX_ASSETS = {
  chunkFileNames: (c: { facadeModuleId: string | null }) => { const f = mathjaxFont(c.facadeModuleId); return f ? `assets/mathjax/${f}/[name]-[hash].js` : 'assets/[name]-[hash].js'; },
  assetFileNames: (a: { originalFileNames?: readonly string[] }) => { const f = mathjaxFont(a.originalFileNames?.[0]); return f ? `assets/mathjax/${f}/[name]-[hash][extname]` : 'assets/[name]-[hash][extname]'; },
  // MathJax itself in a chunk of its own: it changes only with MathJax, so a browser keeps it across deployments
  manualChunks: (id: string) => (id.includes('/node_modules/@mathjax/src/') ? 'mathjax' : undefined),
};

/** MathJax and its fonts (packages/client/package.json) */
const MATHJAX_PACKAGES = Object.keys(JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).dependencies).filter(d => d.startsWith('@mathjax/'));

/**
 * Emits dist/sw.js from src/sw.js with the list of built files to precache (offline app shell)
 * and a version derived from their names (content-hashed), so every deployment gets a new cache.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'overlyx-service-worker',
    apply: 'build',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) walk(abs);
          else if (!/\.map$|^sw\.js$/.test(e.name)) files.push('/' + path.relative(outDir, abs).split(path.sep).join('/'));
        }
      };
      walk(outDir);
      // MathJax's other fonts (assets/mathjax/<font>/, see MATHJAX_ASSETS) are cached once used, not with the shell
      const precache = files.filter(f => f === '/index.html' || (f.startsWith('/assets/') && (!f.startsWith('/assets/mathjax/') || f.startsWith('/assets/mathjax/newcm/'))) || f === '/manifest.webmanifest' || f === '/icon.svg').sort();
      // … and all of a font's files once it is chosen (the page tells the worker, src/sw.js 'math-font')
      const fonts: Record<string, string[]> = {};
      for (const f of files) { const m = /^\/assets\/mathjax\/([a-z0-9]+)\//.exec(f); if (m && m[1] !== 'newcm') (fonts[m[1]] ??= []).push(f); }
      const version = crypto.createHash('sha1').update(precache.join('\n')).digest('hex').slice(0, 12);
      const src = fs.readFileSync(path.resolve(__dirname, 'src/sw.js'), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(precache))
        .replace('__FONTS__', JSON.stringify(fonts));
      fs.writeFileSync(path.join(outDir, 'sw.js'), src);
      this.info?.(`sw.js: precaching ${precache.length} files (version ${version})`);
    },
  };
}

/**
 * Hunspell dictionaries for the spell checker (editor/spell/worker.ts) from the dictionary-*
 * packages, at /dict/<lang>.aff|.dic: a middleware in dev, emitted files at build (not part of
 * the offline precache — the worker fetches the one language it needs).
 */
const DICTIONARIES: Record<string, string> = { en: 'dictionary-en', 'en-gb': 'dictionary-en-gb', de: 'dictionary-de', fr: 'dictionary-fr' };
function dictionaries(): Plugin {
  const source = (lang: string, ext: string) => path.resolve(__dirname, '../../node_modules', DICTIONARIES[lang] ?? '', 'index.' + ext);
  return {
    name: 'overlyx-dictionaries',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/dict\/([a-z-]+)\.(aff|dic)(?:\?.*)?$/.exec(req.url ?? '');
        if (!m || !DICTIONARIES[m[1]]) { next(); return; }
        const f = source(m[1], m[2]);
        if (!fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('cache-control', 'public, max-age=86400');
        fs.createReadStream(f).pipe(res);
      });
    },
    generateBundle() {
      for (const lang of Object.keys(DICTIONARIES)) for (const ext of ['aff', 'dic']) {
        const f = source(lang, ext);
        if (fs.existsSync(f)) this.emitFile({ type: 'asset', fileName: `dict/${lang}.${ext}`, source: fs.readFileSync(f) });
      }
    },
  };
}

export default defineConfig({
  plugins: [preact(), serviceWorker(), dictionaries()],
  define: { 'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(buildVersion) },
  // MathJax's fonts load their per-block data from the package itself: pre-bundling MathJax for the
  // dev server would give those modules a second copy of MathJax's classes (editor/lyxmath/mathfonts.ts)
  optimizeDeps: { exclude: MATHJAX_PACKAGES },
  resolve: {
    // `@overlyx/core` is its index; `@overlyx/core/md/index.ts` and the like are its modules (loaded on demand)
    alias: [
      { find: /^@overlyx\/core$/, replacement: path.resolve(__dirname, '../core/src/index.ts') },
      { find: /^@overlyx\/core\/(.*)$/, replacement: path.resolve(__dirname, '../core/src') + '/$1' },
    ],
    dedupe: ['prosemirror-model', 'prosemirror-state', 'prosemirror-view', 'prosemirror-transform', 'yjs'],
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': `http://localhost:${process.env.OVERLYX_API_PORT ?? 3000}`,
      '/pdf': `http://localhost:${process.env.OVERLYX_API_PORT ?? 3000}`,
      '/ws': { target: `ws://localhost:${process.env.OVERLYX_API_PORT ?? 3000}`, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 3500, rollupOptions: { output: MATHJAX_ASSETS } },
});
