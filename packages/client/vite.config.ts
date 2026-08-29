import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

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
      const precache = files.filter(f => f === '/index.html' || f.startsWith('/assets/') || f === '/manifest.webmanifest' || f === '/icon.svg').sort();
      const version = crypto.createHash('sha1').update(precache.join('\n')).digest('hex').slice(0, 12);
      const src = fs.readFileSync(path.resolve(__dirname, 'src/sw.js'), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(precache));
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
  resolve: {
    alias: { '@overlyx/core': path.resolve(__dirname, '../core/src/index.ts') },
    dedupe: ['prosemirror-model', 'prosemirror-state', 'prosemirror-view', 'prosemirror-transform', 'yjs'],
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': `http://localhost:${process.env.OVERLYX_API_PORT ?? 3000}`,
      '/ws': { target: `ws://localhost:${process.env.OVERLYX_API_PORT ?? 3000}`, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 3000 },
});
