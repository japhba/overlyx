/**
 * The theme switch's choices, shared by every OverLyX webview of the window — the editors, the PDF
 * panels, the slide editors (webview/appearance.ts): the theme (Default = VS Code's, Light, Dark),
 * smart invert of the pages and their figures, the dark theme's text tone (client app/darkpages.ts).
 * Each webview keeps its own browser storage, so a choice made in one is passed here, kept in the
 * extension's global state and sent to the others; a webview that becomes ready is told what is kept.
 */
import * as vscode from 'vscode';
import type { Appearance } from '../shared/protocol.ts';

const KEY = 'overlyx.appearance';
let store: vscode.Memento | undefined;
const views = new Set<vscode.Webview>();

export function initAppearance(context: vscode.ExtensionContext): void { store = context.globalState; }

export const appearance = (): Appearance => store?.get<Appearance>(KEY) ?? {};

/** a webview that shows pages hears the changes the others make; dispose when it closes */
export function watchAppearance(webview: vscode.Webview): vscode.Disposable {
  views.add(webview);
  const messages = webview.onDidReceiveMessage((m: { type?: string; action?: string }) => {
    if (m?.type !== 'interfaceZoom') return;
    const commands: Record<string, string> = { in: 'workbench.action.zoomIn', out: 'workbench.action.zoomOut', reset: 'workbench.action.zoomReset' };
    const command = commands[m.action ?? ''];
    if (command) void vscode.commands.executeCommand(command).then(undefined, e => vscode.window.showErrorMessage('OverLyX could not change interface zoom: ' + String(e)));
  });
  return new vscode.Disposable(() => { messages.dispose(); views.delete(webview); });
}

/** what is kept, to a webview that just became ready */
export function sendAppearance(webview: vscode.Webview): void {
  const a = appearance();
  if (Object.keys(a).length) void webview.postMessage({ type: 'appearance', appearance: a });
}

/** a webview changed something: kept, and passed to the others */
export function changeAppearance(from: vscode.Webview, change: Appearance): void {
  void store?.update(KEY, { ...appearance(), ...change });
  for (const w of views) if (w !== from) void w.postMessage({ type: 'appearance', appearance: change });
}
