// Bundles the extension host (Node): src/extension.ts -> dist/extension.cjs.
// @overlyx/core is TypeScript with .ts import specifiers; esbuild compiles it into the bundle.
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});
if (watch) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
