import { useState } from 'preact/hooks';
import { api, encId } from '../api';

export interface PdfState { url: string | null; log: string; busy: boolean; ok: boolean | null; warnings: string[]; tex?: string }

export function PdfPanel({ docId, state, onBuild, onShowTex }: { docId: string; state: PdfState; onBuild: (engine: 'overlyx' | 'lyx') => void; onShowTex: () => void }) {
  const [showLog, setShowLog] = useState(false);
  return (
    <div class="pdf-panel">
      <div class="bar">
        <button class="small-btn" disabled={state.busy} onClick={() => onBuild('overlyx')} title="Export with the OverLyX LaTeX exporter and compile with latexmk (Ctrl+R)">{state.busy ? 'Building…' : 'View PDF'}</button>
        <button class="small-btn" disabled={state.busy} onClick={() => onBuild('lyx')} title="Compile with the native LyX binary (reference)">via LyX</button>
        <button class="small-btn" onClick={onShowTex} title="Show generated LaTeX source">LaTeX</button>
        <button class="small-btn" onClick={() => setShowLog(!showLog)}>{showLog ? 'Hide log' : 'Log'}</button>
        {state.url && <a class="small-btn" href={`/api/docs/${encId(docId)}/pdf?download=1`} target="_blank">Download</a>}
        <span style={{ color: state.ok === false ? '#b00' : '#3a3', fontSize: '11px' }}>{state.ok === null ? '' : state.ok ? '✓ built' : '✗ errors'}</span>
      </div>
      {state.url ? <iframe src={state.url} title="PDF preview" /> : <div style="flex:1;display:flex;align-items:center;justify-content:center;color:#888">No PDF yet — click “View PDF” (Ctrl+R).</div>}
      {(showLog || state.ok === false) && (
        <div class="log">{state.warnings.length ? 'Exporter warnings:\n' + state.warnings.join('\n') + '\n\n' : ''}{state.log || '(no log)'}</div>
      )}
    </div>
  );
}

export async function buildPdf(docId: string, engine: 'overlyx' | 'lyx'): Promise<PdfState> {
  try {
    const r = await api.export(docId, 'pdf', engine);
    return { url: r.pdf ?? null, log: r.log ?? '', busy: false, ok: r.ok, warnings: r.warnings ?? [], tex: r.tex };
  } catch (e) {
    return { url: null, log: String((e as Error).message), busy: false, ok: false, warnings: [] };
  }
}
