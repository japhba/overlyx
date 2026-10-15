/** Simulate asExternalUri's remote tunnel while keeping the rest of the VS Code API real. */
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');

exports.startForwarding = async function (vscode, extension) {
  let target, bridgeRoute, canvasRoute;
  const targets = new Map();
  let enabled = true;
  let resolved = 0;
  const requests = [];
  const proxy = http.createServer((req, res) => {
    const route = /^\/forwarded\/(\d+)(\/.*)$/.exec(req.url || '');
    const upstreamTarget = route && targets.get(route[1]);
    if (!enabled || !upstreamTarget) {
      res.statusCode = 503; res.end(); return;
    }
    requests.push(req.url);
    const upstream = http.request({ hostname: upstreamTarget.hostname, port: upstreamTarget.port,
      path: route[2], method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  // A different hostname, port and prefix catch hardcoded localhost URLs and CSP restrictions.
  const origin = `http://localhost:${proxy.address().port}`;
  const forwardedEnv = Object.create(vscode.env);
  Object.defineProperty(forwardedEnv, 'asExternalUri', { value: async uri => {
    const resolvedTarget = new URL(uri.toString());
    if (!Number(resolvedTarget.port)) throw new Error('server must start before resolving its external URI');
    const bridge = resolvedTarget.pathname.startsWith('/t/');
    const response = await fetch(bridge ? `${resolvedTarget}/api/projects` : `${resolvedTarget.origin}/_ol/svg-frame.html`);
    if (!response.ok) throw new Error('server must be ready before a webview can connect');
    let id = [...targets].find(([, value]) => value.origin === resolvedTarget.origin)?.[0];
    if (!id) { id = String(targets.size + 1); targets.set(id, new URL(resolvedTarget.origin)); }
    if (bridge) { target = resolvedTarget; bridgeRoute = id; } else canvasRoute = id;
    resolved++;
    return vscode.Uri.parse(`${origin}/forwarded/${id}${resolvedTarget.pathname}`);
  } });
  const forwardedVscode = Object.create(vscode);
  Object.defineProperty(forwardedVscode, 'env', { value: forwardedEnv, enumerable: true });
  return {
    origin, requests,
    get resolved() { return resolved; },
    get base() { return `${origin}/forwarded/${bridgeRoute}${target.pathname}`; },
    get canvasBase() { return canvasRoute ? `${origin}/forwarded/${canvasRoute}/_ol/` : undefined; },
    setEnabled(value) { enabled = value; },
    async activate() {
      const originalLoad = Module._load;
      Module._load = function (request, parent, isMain) {
        if (request === 'vscode' && parent?.filename === path.join(extension.extensionPath, 'dist/extension.cjs')) return forwardedVscode;
        return originalLoad.call(this, request, parent, isMain);
      };
      try { return await extension.activate(); }
      finally { Module._load = originalLoad; }
    },
    dispose() { proxy.closeAllConnections(); proxy.close(); },
  };
};
