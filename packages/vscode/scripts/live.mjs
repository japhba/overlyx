// One development server per host; systemd owns its lifetime, independently of VS Code windows.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let stopping = false;
const host = spawn(process.execPath, ['esbuild.mjs', '--watch'], { cwd: pkg, stdio: 'inherit' });
host.on('exit', code => { if (!stopping) process.exit(code || 1); });
const server = await createServer({
  configFile: path.join(pkg, 'webview.vite.config.ts'),
  publicDir: path.join(pkg, '../client/public'),
  optimizeDeps: { include: ['nspell'] },
  cacheDir: process.env.OVERLYX_VITE_CACHE,
  server: { host: '127.0.0.1', port: Number(process.env.OVERLYX_DEV_PORT || 18765), strictPort: true, cors: { origin: /^(vscode-webview:\/\/|https:\/\/[^/]+\.vscode-cdn\.net$|http:\/\/127\.0\.0\.1(?::\d+)?$)/ } },
});
// A full-page reload cannot preserve the in-memory undo manager. Unsupported HMR boundaries
// explicitly request a window reload instead of silently destroying the document session.
const send = server.ws.send.bind(server.ws);
server.ws.send = (...args) => {
  if (typeof args[0] === 'object' && args[0].type === 'full-reload') {
    send({ type: 'custom', event: 'overlyx:reload-required', data: {} });
  } else send(...args);
};
await server.listen();
server.printUrls();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { stopping = true; host.kill(signal); await server.close(); process.exit(0); });
