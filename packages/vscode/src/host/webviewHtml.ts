/**
 * Webview HTML from the vite-built pages (dist/webview/editor.html, pdf.html): asset paths are
 * rewritten to webview URIs, a CSP and the runtime globals (bridge base URL, docId) injected.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, page: 'editor' | 'pdf', globals: Record<string, unknown>): Promise<string> {
  const config = vscode.workspace.getConfiguration('overlyx');
  const live = !!config.get<string>('developmentPath');
  const localDev = config.get<string>('developmentServer')!;
  // Re-resolve on every new webview: Remote-SSH may allocate a different forwarded URI.
  const dev = live ? (await vscode.env.asExternalUri(vscode.Uri.parse(localDev))).toString().replace(/\/$/, '') : '';
  const dist = vscode.Uri.joinPath(extensionUri, 'dist/webview');
  const file = path.join(dist.fsPath, page + '.html');
  if (!live && !fs.existsSync(file)) {
    return `<!doctype html><html><body><p style="font-family:sans-serif;padding:2em">OverLyX webview bundle not built — run <code>npm run build -w packages/vscode</code>.</p></body></html>`;
  }
  const base = webview.asWebviewUri(dist).toString();
  const nonce = crypto.randomBytes(16).toString('base64');
  const response = live ? await fetch(`${localDev}/${page}.html`) : null;
  if (response && !response.ok) throw new Error(`OverLyX development server: HTTP ${response.status}`);
  let html = response ? await response.text() : fs.readFileSync(file, 'utf8');
  // ./assets/... → webview URI
  html = live
    ? html.replace(/(src|href)="\.?\//g, (_m, attr) => `${attr}="${dev}/`)
    : html.replace(/(src|href)="\.\//g, (_m, attr) => `${attr}="${base}/`);
  html = html.replace(/<script /g, `<script nonce="${nonce}" `);
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob: http://127.0.0.1:* ${dev}`,
    `style-src ${webview.cspSource} 'unsafe-inline' ${dev}`,
    `font-src ${webview.cspSource} data: ${dev}`,
    `script-src 'nonce-${nonce}' ${webview.cspSource} ${dev}`,
    `connect-src http://127.0.0.1:* ${webview.cspSource} ${dev} ${dev.replace(/^http/, 'ws')}`,
    "worker-src blob: data:",
  ].join('; ');
  const inject = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
    // boot instrumentation: grab the one-shot VS Code API here (globals.ts reuses it) and forward
    // uncaught webview errors to the extension host — a webview that fails to boot is silent otherwise
    `<script nonce="${nonce}">
      window.__OVERLYX_VSCAPI = acquireVsCodeApi();
      window.__OVERLYX_VSCODE__ = ${JSON.stringify({ ...globals, assetBase: base + '/' })};
      window.addEventListener('error', e => { if (!e.message) return; try { window.__OVERLYX_VSCAPI.postMessage({ type: 'notify', kind: 'error', text: 'webview: ' + e.message + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0) }); } catch {} }, true);
      window.addEventListener('unhandledrejection', e => { try { window.__OVERLYX_VSCAPI.postMessage({ type: 'notify', kind: 'error', text: 'webview promise: ' + String(e.reason).slice(0, 300) }); } catch {} });
    </script>`;
  return html.replace('<head>', '<head>\n' + inject);
}
