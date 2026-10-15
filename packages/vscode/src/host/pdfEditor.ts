/** Workspace PDFs use the web client's viewer, served through VS Code for remote files too. */
import * as vscode from 'vscode';
import { watchAppearance, sendAppearance, changeAppearance } from './appearance.ts';
import { webviewHtml } from './webviewHtml.ts';
import type { HostToPdf, PdfToHost } from '../shared/protocol.ts';

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private extensionUri: vscode.Uri,
    private bridgeBase: () => Promise<string>,
    private reportError: (error: unknown, area: string) => void,
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const uri = document.uri;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(uri, '..')],
    };
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'assets/overlyx.svg');
    let revision = 0;
    let disposed = false;
    const fileUrl = () => {
      const url = new URL(panel.webview.asWebviewUri(uri).toString());
      url.searchParams.set('v', String(revision));
      return url.toString();
    };
    const refresh = () => {
      revision++;
      void panel.webview.postMessage({ type: 'pdfFile', url: fileUrl() } satisfies HostToPdf);
    };
    const report = (error: unknown) => {
      this.reportError(error, 'pdf.file');
      void vscode.window.showErrorMessage('OverLyX PDF: ' + String(error));
    };
    // Watch this file only, including replacement by an atomic save or a PDF build.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), '*'));
    const changed = (file: vscode.Uri) => { if (file.toString() === uri.toString()) refresh(); };
    const subscriptions = [
      watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
      watchAppearance(panel.webview),
      vscode.window.onDidChangeActiveColorTheme(theme => {
        void panel.webview.postMessage({ type: 'theme', dark: isDark(theme) } satisfies HostToPdf);
      }),
      panel.webview.onDidReceiveMessage((msg: PdfToHost) => {
        if (msg.type === 'ready') {
          sendAppearance(panel.webview);
          void panel.webview.postMessage({ type: 'pdfFile', url: fileUrl() } satisfies HostToPdf);
        }
        else if (msg.type === 'appearance') changeAppearance(panel.webview, msg.appearance);
        else if (msg.type === 'refreshPdf') refresh();
        else if (msg.type === 'savePdfCopy') {
          void vscode.window.showSaveDialog({ defaultUri: uri, filters: { PDF: ['pdf'] }, saveLabel: 'Save PDF copy' }).then(async target => {
            if (target && target.toString() !== uri.toString()) await vscode.workspace.fs.copy(uri, target, { overwrite: true });
          }).then(undefined, report);
        } else if (msg.type === 'notify') {
          if (msg.kind === 'error') {
            const error = new Error(msg.text);
            if (msg.stack) error.stack = msg.stack;
            report(error);
          } else void vscode.window.showInformationMessage(msg.text);
        }
      }),
    ];
    panel.onDidDispose(() => { disposed = true; for (const subscription of subscriptions) subscription.dispose(); });
    const base = await this.bridgeBase();
    if (disposed) return;
    const html = await webviewHtml(panel.webview, this.extensionUri, 'pdf', {
      page: 'pdf', docId: '', base, dark: isDark(vscode.window.activeColorTheme), pdfUrl: fileUrl(),
    });
    if (!disposed) panel.webview.html = html;
  }
}

const isDark = (theme: vscode.ColorTheme): boolean =>
  [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(theme.kind);
