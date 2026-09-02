/**
 * The PDF panel webview: pdf.js viewer with build status and SyncTeX (a slim variant of the web
 * client's PdfPanel — build/cancel/status through the local bridge, inverse search through the
 * extension host).
 */
import { G, vscode, applyTheme } from './globals';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as pdfjs from 'pdfjs-dist';
import { api } from '@client/api';
import { PdfViewer, type PdfTarget } from '@client/app/PdfViewer';
import { stateFromBuild, jobActive, type PdfState } from '@client/app/PdfPanel';
import type { HostToPdf } from '../shared/protocol';
import '@client/styles.css';

applyTheme(G.dark);

// The webview page cannot start a cross-origin worker from the asset host: load the pdf.js
// worker's code and hand pdf.js a same-origin blob URL instead.
async function fixPdfWorker(): Promise<void> {
  try {
    const src = pdfjs.GlobalWorkerOptions.workerSrc;
    if (!src) return;
    const code = await fetch(src).then(r => r.text());
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  } catch (e) { console.warn('pdf.js worker fallback (main thread):', e); }
}

const PHASE: Record<string, string> = { queued: 'waiting for a free build slot', exporting: 'saving the document', compiling: 'running latexmk' };

function PdfApp() {
  const [pdf, setPdf] = useState<PdfState>({ url: null, log: '', busy: false, ok: null, warnings: [] });
  const [target, setTarget] = useState<PdfTarget | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [, tick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = (announce: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    const step = async () => {
      let r: Awaited<ReturnType<typeof api.build>>;
      try { r = await api.build(G.docId); } catch { timer.current = setTimeout(step, 3000); return; }
      setPdf(p => stateFromBuild(p, r));
      if (jobActive(r.job)) { timer.current = setTimeout(step, 1000); return; }
      if (announce && r.job && r.job.status !== 'ok') vscode.postMessage({ type: 'notify', text: r.job.status === 'cancelled' ? 'PDF build cancelled' : 'PDF build failed — see the log in the PDF panel', kind: 'error' });
    };
    void step();
  };

  const build = async () => {
    setPdf(p => ({ ...p, busy: true }));
    try {
      const r = await api.export(G.docId, 'pdf');
      setPdf(p => ({ ...p, busy: true, job: r.job ?? p.job }));
      poll(true);
    } catch (e) {
      setPdf(p => ({ ...p, busy: false, ok: false, log: String((e as Error).message) }));
    }
  };

  useEffect(() => {
    poll(false);
    const onMsg = (ev: MessageEvent<HostToPdf>) => {
      const m = ev.data;
      if (m?.type === 'syncTarget') setTarget(m.target);
      else if (m?.type === 'theme') applyTheme(m.dark);
    };
    window.addEventListener('message', onMsg);
    return () => { window.removeEventListener('message', onMsg); if (timer.current) clearTimeout(timer.current); };
  }, []);

  useEffect(() => { if (!pdf.busy) return; const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, [pdf.busy]);
  const job = pdf.job;
  const elapsed = job ? Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) : 0;

  return (
    <div class="pdf-panel" style="height:100vh">
      <div class="bar">
        <button class="small-btn" disabled={pdf.busy} onClick={() => void build()} title="Compile with latexmk (Ctrl+R in the editor)">{pdf.busy ? 'Building…' : 'Build PDF'}</button>
        {pdf.busy && <button class="small-btn" onClick={() => { void api.cancelBuild(G.docId).then(() => poll(true)); }}>Cancel</button>}
        <button class="small-btn" onClick={() => setShowLog(s => !s)}>{showLog ? 'Hide log' : 'Log'}</button>
        <span style={{ color: pdf.ok === false ? '#b00' : '#3a3', fontSize: '11px' }} title={pdf.builtAt ? 'built at ' + new Date(pdf.builtAt).toLocaleTimeString() : ''}>{pdf.ok === null ? '' : pdf.ok ? '✓ built' : '✗ errors'}</span>
      </div>
      {pdf.busy && job && (
        <div class="build-progress" title={job.progress}>
          <span class="spinner" /> {PHASE[job.status] ?? job.status} · {elapsed} s{job.rerun ? ' · will build again with your latest changes' : ''}
          {job.progress && <span class="progress-line">{job.progress}</span>}
        </div>
      )}
      {pdf.url
        ? <PdfViewer url={pdf.url} target={target} onSync={(page, x, y) => vscode.postMessage({ type: 'inverse', page, x, y })} hint="Double-click the PDF to jump to that place in the document" />
        : <div style="flex:1;display:flex;align-items:center;justify-content:center;color:#888">{pdf.busy ? 'Building the PDF in the background — you can keep editing.' : 'No PDF yet — click “Build PDF” (Ctrl+R in the editor).'}</div>}
      {(showLog || pdf.ok === false) && (
        <div class="log">{pdf.warnings.length ? 'Warnings:\n' + pdf.warnings.join('\n') + '\n\n' : ''}{pdf.log || '(no log)'}</div>
      )}
    </div>
  );
}

void fixPdfWorker().then(() => {
  render(<PdfApp />, document.getElementById('app')!);
  vscode.postMessage({ type: 'ready' });
});
