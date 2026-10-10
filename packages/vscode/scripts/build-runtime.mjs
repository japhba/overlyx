// The runtime of HTML deliverables (client src/deliverable/runtime, its MathJax) into dist/ol/ —
// what the extension's local server (src/host/deliverables.ts) puts into the pages it serves.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.join(here, '../../client');
const out = path.join(here, '../dist/ol');
const vite = path.join(here, '../../../node_modules/vite/bin/vite.js');
execFileSync(process.execPath, [vite, 'build', '-c', 'runtime.vite.config.ts'], { cwd: client, stdio: 'inherit', env: { ...process.env, OVERLYX_RUNTIME_OUT: out } });
console.log('runtime built:', out);
