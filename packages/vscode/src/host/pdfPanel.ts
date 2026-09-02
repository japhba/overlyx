/**
 * The PDF preview panel (a webview tab beside the editor, LaTeX-Workshop style): pdf.js viewer
 * with build status, log and SyncTeX. One panel per document, revived on demand.
 */
import * as vscode from 'vscode';
import { webviewHtml } from './webviewHtml.ts';
import type { HostToPdf, PdfToHost } from '../shared/protocol.ts';

export class PdfPanels {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private extensionUri: vscode.Uri,
    private bridgeBase: () => string,
    private onInverse: (docId: string, page: number, x: number, y: number) => void,
  ) {}

  /** Show (or open) the PDF panel of a document. */
  show(docId: string, focus = false): vscode.WebviewPanel {
    let panel = this.panels.get(docId);
    if (panel) { panel.reveal(vscode.ViewColumn.Beside, !focus); return panel; }
    panel = vscode.window.createWebviewPanel('overlyx.pdf', `PDF — ${docId.split('/').pop()}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !focus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] });
    this.panels.set(docId, panel);
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'assets/overlyx.svg');
    const dark = [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(vscode.window.activeColorTheme.kind);
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, 'pdf', { page: 'pdf', docId, base: this.bridgeBase(), dark });
    panel.webview.onDidReceiveMessage((msg: PdfToHost) => {
      if (msg.type === 'inverse') this.onInverse(docId, msg.page, msg.x, msg.y);
      else if (msg.type === 'notify') void (msg.kind === 'error' ? vscode.window.showErrorMessage(msg.text) : vscode.window.showInformationMessage(msg.text));
    });
    panel.onDidDispose(() => { if (this.panels.get(docId) === panel) this.panels.delete(docId); });
    return panel;
  }

  post(docId: string, msg: HostToPdf): void {
    const p = this.panels.get(docId);
    if (p) void p.webview.postMessage(msg);
  }

  has(docId: string): boolean { return this.panels.has(docId); }

  postTheme(dark: boolean): void {
    for (const p of this.panels.values()) void p.webview.postMessage({ type: 'theme', dark } satisfies HostToPdf);
  }
}
