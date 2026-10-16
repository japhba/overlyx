/** Runtime configuration injected by the extension host (webviewHtml.ts). */
export interface VsCodeGlobals {
  page: 'editor' | 'pdf' | 'deliverable';
  docId: string;
  /** A standalone PDF file, exposed through VS Code's local/remote resource loader. */
  pdfUrl?: string;
  /** the local HTTP bridge: http://127.0.0.1:<port>/t/<token> */
  base: string;
  /** webview URI of dist/webview/ (static assets: LyX icons) */
  assetBase: string;
  canvasBase?: string;
  dark: boolean;
  usageStats?: boolean;
}
export const G: VsCodeGlobals = (window as unknown as { __OVERLYX_VSCODE__: VsCodeGlobals }).__OVERLYX_VSCODE__;

// The client's api.ts reads this before building any URL.
(globalThis as unknown as { OVERLYX_API_BASE?: string }).OVERLYX_API_BASE = G.base;
(globalThis as unknown as { OVERLYX_CANVAS_BASE?: string }).OVERLYX_CANVAS_BASE = G.canvasBase;
(globalThis as { OVERLYX_USAGE_ENABLED?: boolean }).OVERLYX_USAGE_ENABLED = G.usageStats === true;
(globalThis as { OVERLYX_VIEW_KIND?: string }).OVERLYX_VIEW_KIND = G.page;
window.addEventListener('message', ev => {
  if (ev.data?.type !== 'usageStats' || typeof ev.data.enabled !== 'boolean') return;
  (globalThis as { OVERLYX_USAGE_ENABLED?: boolean }).OVERLYX_USAGE_ENABLED = ev.data.enabled;
  window.dispatchEvent(new Event('ol:usage-policy'));
});

export interface VsCodeApi { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;
// the host's boot script acquires the (one-shot) API first — reuse it
export const vscode: VsCodeApi = (window as unknown as { __OVERLYX_VSCAPI?: VsCodeApi }).__OVERLYX_VSCAPI ?? acquireVsCodeApi();

if (import.meta.hot) {
  import.meta.hot.on('overlyx:reload-required', () => vscode.postMessage({ type: 'notify', text: 'This source change requires Developer: Reload Window. Save your document first.', kind: 'info' }));
}

/** Apply the VS Code theme to the OverLyX theme attribute. */
export function applyTheme(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
