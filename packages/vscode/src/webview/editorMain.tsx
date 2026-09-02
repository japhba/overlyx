/**
 * Editor webview bootstrap: wires the VS Code globals (API base, asset base, theme) before any
 * client module builds a URL, then waits for the host's `init` message and mounts the shell.
 */
import { G, vscode, applyTheme } from './globals';   // must come first: sets OVERLYX_API_BASE
import { render } from 'preact';
import { LYX_ICONS } from '@client/app/lyxicons';
import { editorContext } from '@client/editor/context';
import { EditorShell } from './EditorShell';
import type { HostToEditor } from '../shared/protocol';
import '@client/styles.css';
import 'katex/dist/katex.min.css';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import 'prosemirror-tables/style/tables.css';

applyTheme(G.dark);
// toolbar icons are absolute paths (/lyxicons/x.svg) in the web app: point them at our assets
for (const k of Object.keys(LYX_ICONS)) if (LYX_ICONS[k].startsWith('/')) LYX_ICONS[k] = G.assetBase + LYX_ICONS[k].slice(1);

// uncaught errors must not vanish (there is no server to report to here)
window.addEventListener('error', e => { if (e.message) editorContext.notify?.('Something went wrong: ' + e.message.slice(0, 200), 'error'); });
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
