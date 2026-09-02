/**
 * Webview HTML from the vite-built pages (dist/webview/editor.html, pdf.html): asset paths are
 * rewritten to webview URIs, a CSP and the runtime globals (bridge base URL, docId) injected.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, page: 'editor' | 'pdf', globals: Record<string, unknown>): string {
  const dist = vscode.Uri.joinPath(extensionUri, 'dist/webview');
  const file = path.join(dist.fsPath, page + '.html');
  if (!fs.existsSync(file)) {
    return `<!doctype html><html><body><p style="font-family:sans-serif;padding:2em">OverLyX webview bundle not built — run <code>npm run build -w packages/vscode</code>.</p></body></html>`;
  }
  const base = webview.asWebviewUri(dist).toString();
  const nonce = crypto.randomBytes(16).toString('base64');
  let html = fs.readFileSync(file, 'utf8');
  // ./assets/... → webview URI
  html = html.replace(/(src|href)="\.\//g, (_m, attr) => `${attr}="${base}/`);
  html = html.replace(/<script /g, `<script nonce="${nonce}" `);
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob: http://127.0.0.1:*`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    `connect-src http://127.0.0.1:* ${webview.cspSource}`,
    "worker-src blob: data:",
  ].join('; ');
  const inject = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
    `<script nonce="${nonce}">window.__OVERLYX_VSCODE__ = ${JSON.stringify({ ...globals, assetBase: base + '/' })};</script>`;
  return html.replace('<head>', '<head>\n' + inject);
}
