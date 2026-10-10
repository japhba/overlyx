/**
 * The runtime of HTML deliverables (src/deliverable/runtime/) as one classic script,
 * dist/_ol/runtime.js, and the MathJax it loads (TeX input, SVG output, the New Computer Modern
 * font's data) in dist/_ol/mathjax/. Built after the app (`npm run build`), into the same dist —
 * the server serves /_ol/ to the sandboxed frames that show deliverables, and to its renderer.
 */
import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import fs from 'node:fs';

const NM = path.resolve(__dirname, '../../node_modules');
const OUT = path.resolve(__dirname, process.env.OVERLYX_RUNTIME_OUT ?? 'dist/_ol');

function copyDir(from: string, to: string, filter: (f: string) => boolean = () => true): void {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, filter);
    else if (filter(a)) fs.copyFileSync(a, b);
  }
}

function mathjax(): Plugin {
  return {
    name: 'overlyx-runtime-mathjax',
    apply: 'build',
    closeBundle() {
      const mj = path.join(NM, '@mathjax/src/bundle');
      const out = path.join(OUT, 'mathjax');
      fs.mkdirSync(out, { recursive: true });
      fs.copyFileSync(path.join(mj, 'tex-svg.js'), path.join(out, 'tex-svg.js'));
      copyDir(path.join(mj, 'input/tex/extensions'), path.join(out, 'input/tex/extensions'), f => f.endsWith('.js'));
      // the font's per-block data, loaded when a formula needs it (fonts/mathjax-newcm-font/svg/dynamic/*.js)
      const font = path.join(NM, '@mathjax/mathjax-newcm-font');
      copyDir(path.join(font, 'svg'), path.join(out, 'fonts/mathjax-newcm-font/svg'), f => f.endsWith('.js'));
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [mathjax()],
  resolve: { alias: { '@overlyx/core': path.resolve(__dirname, '../core/src') } },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    lib: {
      entry: path.resolve(__dirname, 'src/deliverable/runtime/index.ts'),
      formats: ['iife'],
      name: 'OverLyXRuntime',
      fileName: () => 'runtime.js',
    },
  },
});
