import * as vscode from 'vscode';

/** Connect the client-side webview to the server on the (possibly remote) extension host. */
export async function connectWebviewBridge(hostBase: string): Promise<string> {
  // Keep the entire URI: browser clients may receive HTTPS and a forwarding path prefix.
  const uri = await vscode.env.asExternalUri(vscode.Uri.parse(hostBase));
  return uri.toString().replace(/\/$/, '');
}
