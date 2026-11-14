import * as vscode from 'vscode';

/**
 * The address under which the webview reaches a server of the extension host's: the same, in a local
 * desktop window (VS Code's own "no-op if the extension is running on the client machine" — without
 * the round trip to the window, which is busy restoring its editors while VS Code starts); else what
 * VS Code forwards (Remote-SSH, WSL, containers, the browser: possibly HTTPS and a path prefix).
 */
export async function externalAddress(local: string): Promise<string> {
  if (!vscode.env.remoteName && vscode.env.uiKind === vscode.UIKind.Desktop) return local.replace(/\/$/, '');
  return (await vscode.env.asExternalUri(vscode.Uri.parse(local))).toString().replace(/\/$/, '');
}

/** Connect the client-side webview to the server on the (possibly remote) extension host. */
export async function connectWebviewBridge(hostBase: string): Promise<string> {
  return externalAddress(hostBase);
}
