/**
 * Editor webview bootstrap: wires the VS Code globals (API base, asset base, theme) before any
 * client module builds a URL, then waits for the host's `init` message and mounts the shell.
 */
import { G, vscode, applyTheme } from './globals';   // must come first: sets OVERLYX_API_BASE
import { render } from 'preact';
import { useHostTheme } from '@client/app/theme';
import { LYX_ICONS } from '@client/app/lyxicons';
import { editorContext } from '@client/editor/context';
import { isBenignBrowserError } from '@client/error-reporting';
import { EditorShell } from './EditorShell';
import { initUsage } from '@client/usage';
import { relayAppearance } from './appearance';
import type { HostToEditor } from '../shared/protocol';
import '@client/styles.css';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import 'prosemirror-tables/style/tables.css';

useHostTheme();
applyTheme(G.dark);
initUsage();
// the theme switch's choices made in another OverLyX webview (host/appearance.ts) — before the shell
// mounts too (the host sends them before `init`): the shell reads ol.theme when it starts
relayAppearance(t => {
  try { if (t === 'system') localStorage.removeItem('ol.theme'); else localStorage.setItem('ol.theme', t); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('ol:theme', { detail: t }));
});
// toolbar icons are absolute paths (/lyxicons/x.svg) in the web app: point them at our assets
for (const k of Object.keys(LYX_ICONS)) if (LYX_ICONS[k].startsWith('/')) LYX_ICONS[k] = G.assetBase + LYX_ICONS[k].slice(1);

// uncaught errors must not vanish (there is no server to report to here); ResizeObserver's
// scheduling notice is no error (the web app ignores it too, main.tsx)
window.addEventListener('error', e => { if (e.message && !isBenignBrowserError(e.message)) editorContext.notify?.('Something went wrong: ' + e.message.slice(0, 200), 'error'); });
window.addEventListener('unhandledrejection', e => { const r = (e as PromiseRejectionEvent).reason; editorContext.notify?.('Something went wrong: ' + String(r instanceof Error ? r.message : r).slice(0, 200), 'error'); });

const onInit = (ev: MessageEvent<HostToEditor>) => {
  const m = ev.data;
  if (m?.type !== 'init') return;
  window.removeEventListener('message', onInit);
  applyTheme(m.dark);
  render(<EditorShell init={m} />, document.getElementById('app')!);
};
window.addEventListener('message', onInit);
vscode.postMessage({ type: 'ready' });
