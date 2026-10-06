// Bundles the extension host (Node): src/extension.ts -> dist/extension.cjs, and the local tool
// server AI agents start (src/agents/entry.ts -> dist/agents.cjs; no VS Code API in it).
// @overlyx/core is TypeScript with .ts import specifiers; esbuild compiles it into the bundle.
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, logLevel: 'info' };
const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', external: ['vscode'] }),
  esbuild.context({ ...common, entryPoints: ['src/agents/entry.ts'], outfile: 'dist/agents.cjs' }),
]);
if (watch) await Promise.all(contexts.map(c => c.watch()));
else for (const c of contexts) { await c.rebuild(); await c.dispose(); }
