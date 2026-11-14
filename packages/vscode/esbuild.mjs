// Bundles the extension host (Node): src/extension.ts -> dist/extension.cjs, and the local tool
// server AI agents start (src/agents/entry.ts -> dist/agents.cjs; no VS Code API in it).
// @overlyx/core is TypeScript with .ts import specifiers; esbuild compiles it into the bundle.
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, logLevel: 'info' };
/**
 * The new decks' and posters' fonts (core html/scientific-fonts.ts, 2.5 MB of base64 — half of each
 * bundle) are needed only to create one: they go into dist/template-fonts.cjs, required on first use,
 * so that starting the extension does not read and compile them.
 */
const lazyTemplateFonts = {
  name: 'lazy-template-fonts',
  setup(build) {
    build.onResolve({ filter: /[\\/]scientific-fonts\.ts$/ }, () => ({ path: 'template-fonts', namespace: 'lazy-template-fonts' }));
    build.onResolve({ filter: /^\.\/template-fonts\.cjs$/ }, args => ({ path: args.path, external: true }));
    build.onLoad({ filter: /.*/, namespace: 'lazy-template-fonts' }, () => ({
      loader: 'js', resolveDir: '.',
      contents: "let fonts; const load = () => fonts ??= require('./template-fonts.cjs');\n" +
        'module.exports = { get TEMPLATE_FONTS() { return load().TEMPLATE_FONTS; }, get TEMPLATE_FONT_LICENSE() { return load().TEMPLATE_FONT_LICENSE; } };',
    }));
  },
};
const contexts = await Promise.all([
  // the sync engine is the CLI's (packages/cli/bin/overlyx.js): bundled as a library, its command line off
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', external: ['vscode'], define: { 'process.env.OVERLYX_CLI_LIBRARY': '"1"' }, plugins: [lazyTemplateFonts] }),
  esbuild.context({ ...common, entryPoints: ['src/agents/entry.ts'], outfile: 'dist/agents.cjs', plugins: [lazyTemplateFonts] }),
  esbuild.context({ ...common, sourcemap: false, entryPoints: ['../core/src/html/scientific-fonts.ts'], outfile: 'dist/template-fonts.cjs' }),
]);
if (watch) await Promise.all(contexts.map(c => c.watch()));
else for (const c of contexts) { await c.rebuild(); await c.dispose(); }
