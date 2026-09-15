/** Simulate asExternalUri's remote tunnel while keeping the rest of the VS Code API real. */
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');

exports.startForwarding = async function (vscode, extension) {
  let target;
  let enabled = true;
  let resolved = 0;
  const requests = [];
  const proxy = http.createServer((req, res) => {
    if (!enabled || !target || !req.url.startsWith('/forwarded/')) {
      res.statusCode = 503; res.end(); return;
    }
    requests.push(req.url);
    const upstream = http.request({ hostname: target.hostname, port: target.port,
      path: req.url.slice('/forwarded'.length), method: req.method, headers: req.headers }, response => {
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
    target = new URL(uri.toString());
    if (!Number(target.port)) throw new Error('bridge must start before resolving its external URI');
    const response = await fetch(`${target}/api/projects`);
    if (!response.ok) throw new Error('bridge must be ready before a webview can connect');
    resolved++;
    return vscode.Uri.parse(`${origin}/forwarded${target.pathname}`);
  } });
  const forwardedVscode = Object.create(vscode);
  Object.defineProperty(forwardedVscode, 'env', { value: forwardedEnv, enumerable: true });
  return {
    origin, requests,
    get resolved() { return resolved; },
    get base() { return `${origin}/forwarded${target.pathname}`; },
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
