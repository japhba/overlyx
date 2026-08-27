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

export default defineConfig({
  plugins: [preact(), serviceWorker()],
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
