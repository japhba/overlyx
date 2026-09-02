/** Runtime configuration injected by the extension host (webviewHtml.ts). */
export interface VsCodeGlobals {
  page: 'editor' | 'pdf';
  docId: string;
  /** the local HTTP bridge: http://127.0.0.1:<port>/t/<token> */
  base: string;
  /** webview URI of dist/webview/ (static assets: LyX icons) */
  assetBase: string;
  dark: boolean;
}
export const G: VsCodeGlobals = (window as unknown as { __OVERLYX_VSCODE__: VsCodeGlobals }).__OVERLYX_VSCODE__;

// The client's api.ts reads this before building any URL.
(globalThis as unknown as { OVERLYX_API_BASE?: string }).OVERLYX_API_BASE = G.base;

export interface VsCodeApi { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;
export const vscode: VsCodeApi = acquireVsCodeApi();

/** Apply the VS Code theme to the OverLyX theme attribute. */
export function applyTheme(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
