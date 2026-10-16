import { G, vscode } from './globals';
import { useEffect, useMemo, useState } from 'preact/hooks';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { api } from '@client/api';
import { PdfViewer, type PdfTarget } from '@client/app/PdfViewer';
import { stateFromBuild, type PdfState } from '@client/app/PdfPanel';
import { pdfStatus, useTicker } from '@client/app/pdfstatus';
import type { HostToPdf } from '../shared/protocol';
import { setHostDark } from './appearance';
import { InterfaceZoom } from './InterfaceZoom';
import { watchPdfBuild } from './pdfPolling';

// The webview page cannot start a cross-origin worker from the asset host: load the pdf.js
// worker's code and hand pdf.js a same-origin blob URL instead.
let workerReady: Promise<void> | undefined;
export function preparePdfWorker(): Promise<void> {
  return workerReady ??= fixPdfWorker();
}
async function fixPdfWorker(): Promise<void> {
  try {
    const src = pdfjs.GlobalWorkerOptions.workerSrc;
    if (!src) return;
    const code = await fetch(src, { signal: AbortSignal.timeout(10000) }).then(r => { if (!r.ok) throw new Error(`PDF worker: HTTP ${r.status}`); return r.text(); });
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  } catch (e) { console.warn('pdf.js worker fallback (main thread):', e); }
}

const PHASE: Record<string, string> = { queued: 'waiting for a free build slot', exporting: 'saving the document', compiling: 'running latexmk' };

/** The same built-PDF view in the editor switch and in a separate VS Code panel. */
export function BuiltPdf({ target: requestedTarget, onBuild, onInverse, onForward, onOpenBeside, onClose }: {
  target?: PdfTarget | null;
  onBuild?: () => void;
  onInverse?: (page: number, x: number, y: number) => void;
  onForward?: () => void;
  onOpenBeside?: () => void;
  onClose?: () => void;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => { let mounted = true; void preparePdfWorker().then(() => { if (mounted) setReady(true); }); return () => { mounted = false; }; }, []);
  const [pdf, setPdf] = useState<PdfState>({ url: null, log: '', busy: false, ok: null, warnings: [] });
  const [target, setTarget] = useState<PdfTarget | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [, tick] = useState(0);
  const watcher = useMemo(() => watchPdfBuild({
    fetch: () => api.build(G.docId),
    receive: r => setPdf(p => stateFromBuild(p, r)),
    failed: r => vscode.postMessage({ type: 'notify', text: r.job?.status === 'cancelled' ? 'PDF build cancelled' : 'PDF build failed — see the log in the PDF panel', kind: 'error' }),
  }), []);
  const poll = (announce: boolean) => watcher.poll(announce);

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
    const onMsg = (ev: MessageEvent<HostToPdf | { type: 'built' }>) => {
      const m = ev.data;
      if (m?.type === 'syncTarget') setTarget(m.target);
      else if (m?.type === 'theme') setHostDark(m.dark);
      else if (m?.type === 'built') poll(false);
    };
    window.addEventListener('message', onMsg);
    return () => { window.removeEventListener('message', onMsg); watcher.dispose(); };
  }, []);

  useEffect(() => { if (!pdf.busy) return; const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, [pdf.busy]);
  const job = pdf.job;
  const elapsed = job ? Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) : 0;
  // how old the PDF is (the file's time; the editor saves the file itself, so "outdated" is not known here)
  const st = pdfStatus(pdf, 0, useTicker(pdf.busy));
  // floats over the pages while a build runs (nothing moves)
  const progress = pdf.busy && job ? (
    <div class="build-progress" title={job.progress}>
      <i class="spinner" /> {PHASE[job.status] ?? job.status} · {elapsed} s{job.rerun ? ' · will build again with your latest changes' : ''}
      {job.progress && <i class="progress-line">{job.progress}</i>}
    </div>
  ) : null;

  return (
    <div class="pdf-panel" data-pdf-pane>
      <div class="bar">
        <button class="small-btn" disabled={pdf.busy} onClick={() => { if (onBuild) onBuild(); else void build(); }} title="Compile with latexmk (Ctrl+R in the editor)">{pdf.busy ? 'Building…' : 'Build PDF'}</button>
        {pdf.busy && <button class="small-btn" onClick={() => { void api.cancelBuild(G.docId).then(() => poll(true)); }}>Cancel</button>}
        <button class="small-btn" onClick={() => setShowLog(s => !s)}>{showLog ? 'Hide log' : 'Log'}</button>
        <span class={'pdf-age ' + st.kind} title={st.title}>{st.label}</span>
        {onForward && <button class="small-btn" onClick={onForward} title="Show the cursor in the PDF (Ctrl+Alt+J)">⇄ Sync</button>}
        {onOpenBeside && <button class="small-btn" onClick={onOpenBeside} title="Open the PDF in a separate VS Code panel">Open beside</button>}
        {!onOpenBeside && <InterfaceZoom />}
        {onClose && <button class="small-btn" onClick={onClose} title="Hide the PDF pane">✕</button>}
      </div>
      {pdf.url && ready
        ? <PdfViewer url={pdf.url} target={requestedTarget ?? target} onSync={onInverse ?? ((page, x, y) => vscode.postMessage({ type: 'inverse', page, x, y }))} hint="Double-click the PDF to jump to that place in the document" busy={pdf.busy} overlay={progress} />
        : <div class="pdf-empty">{progress}{pdf.url && !ready ? 'Loading the PDF viewer…' : pdf.busy ? 'Building the PDF in the background — you can keep editing.' : 'No PDF yet — click “Build PDF” (Ctrl+R in the editor).'}</div>}
      {(showLog || pdf.ok === false) && (
        <div class="log">{pdf.warnings.length ? 'Warnings:\n' + pdf.warnings.join('\n') + '\n\n' : ''}{pdf.log || '(no log)'}</div>
      )}
    </div>
  );
}

