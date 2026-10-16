/**
 * The PDF panel webview: pdf.js viewer with build status and SyncTeX (a slim variant of the web
 * client's PdfPanel — build/cancel/status through the local bridge, inverse search through the
 * extension host).
 */
import { G, vscode } from './globals';
import { initUsage } from '@client/usage';
import { render } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { PdfViewer } from '@client/app/PdfViewer';
import type { HostToPdf } from '../shared/protocol';
import { useHostTheme } from '@client/app/theme';
import { relayAppearance, setHostDark } from './appearance';
import { InterfaceZoom } from './InterfaceZoom';
import { BuiltPdf, preparePdfWorker } from './BuiltPdf';
import '@client/styles.css';

// the theme switch's choices from the editors (smart invert, the text tone, the theme — host/appearance.ts)
useHostTheme();
initUsage();
relayAppearance();
setHostDark(G.dark);

function PdfFileApp() {
  const [url, setUrl] = useState(G.pdfUrl!);
  useLayoutEffect(() => {
    const onMsg = (ev: MessageEvent<HostToPdf>) => {
      const m = ev.data;
      if (m?.type === 'pdfFile') setUrl(m.url);
      else if (m?.type === 'theme') setHostDark(m.dark);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  // VS Code's resource loader serves with wildcard CORS; these URLs need no cookies.
  return <div class="pdf-tab" style="height:100vh"><PdfViewer url={url} withCredentials={false} toolbar={<>
    <button class="small-btn" onClick={() => vscode.postMessage({ type: 'refreshPdf' })}>Refresh</button>
    <button class="small-btn" onClick={() => vscode.postMessage({ type: 'savePdfCopy' })}>Save a copy…</button>
    <InterfaceZoom />
  </>} /></div>;
}

void preparePdfWorker().then(() => {
  render(G.pdfUrl ? <PdfFileApp /> : <BuiltPdf />, document.getElementById('app')!);
  vscode.postMessage({ type: 'ready' });
});
