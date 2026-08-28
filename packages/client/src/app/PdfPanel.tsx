import { useEffect, useState } from 'preact/hooks';
import { api, encId, type BuildJob, type BuildInfo } from '../api';

export interface PdfState {
  url: string | null; log: string; busy: boolean; ok: boolean | null; warnings: string[]; tex?: string;
  /** the running / queued job (builds run in the background on the server) */
  job?: BuildJob | null;
  /** when the shown PDF was built (server time) */
  builtAt?: number;
}

const PHASE: Record<string, string> = { queued: 'waiting for a free build slot', exporting: 'exporting LaTeX', compiling: 'running latexmk' };

export function PdfPanel({ docId, state, onBuild, onCancel, onShowTex }: { docId: string; state: PdfState; onBuild: () => void; onCancel: () => void; onShowTex: () => void }) {
  const [showLog, setShowLog] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { if (!state.busy) return; const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, [state.busy]);
  const job = state.job;
  const elapsed = job ? Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) : 0;
  return (
    <div class="pdf-panel">
      <div class="bar">
        <button class="small-btn" disabled={state.busy} onClick={() => onBuild()} title="Compile the document with latexmk in the background (Ctrl+R)">{state.busy ? 'Building…' : 'View PDF'}</button>
        {state.busy && <button class="small-btn" onClick={onCancel} title="Stop this build">Cancel</button>}
        <button class="small-btn" onClick={onShowTex} title="Show the LaTeX source as built">LaTeX</button>
        <button class="small-btn" onClick={() => setShowLog(!showLog)}>{showLog ? 'Hide log' : 'Log'}</button>
        {state.url && <a class="small-btn" href={`/api/docs/${encId(docId)}/pdf?download=1`} target="_blank">Download</a>}
        <span style={{ color: state.ok === false ? '#b00' : '#3a3', fontSize: '11px' }} title={state.builtAt ? 'built at ' + new Date(state.builtAt).toLocaleTimeString() : ''}>{state.ok === null ? '' : state.ok ? '✓ built' : '✗ errors'}</span>
      </div>
      {state.busy && job && (
        <div class="build-progress" title={job.progress}>
          <span class="spinner" /> {PHASE[job.status] ?? job.status} · {elapsed} s{job.rerun ? ' · will build again with your latest changes' : ''}
          {job.progress && <span class="progress-line">{job.progress}</span>}
        </div>
      )}
      {state.url ? <iframe src={state.url} title="PDF preview" /> : <div style="flex:1;display:flex;align-items:center;justify-content:center;color:#888">{state.busy ? 'Building the PDF in the background — you can keep editing.' : 'No PDF yet — click “View PDF” (Ctrl+R).'}</div>}
      {(showLog || state.ok === false) && (
        <div class="log">{state.warnings.length ? 'Exporter warnings:\n' + state.warnings.join('\n') + '\n\n' : ''}{state.log || '(no log)'}</div>
      )}
    </div>
  );
}

const ACTIVE = new Set(['queued', 'exporting', 'compiling']);
export const jobActive = (j: BuildJob | null | undefined): boolean => !!j && ACTIVE.has(j.status);

/** PdfState from the server's last build + job. */
export function stateFromBuild(prev: PdfState, r: { build: BuildInfo | null; job: BuildJob | null }): PdfState {
  const busy = jobActive(r.job);
  const b = r.build;
  // while a build runs, keep showing the previous PDF
  if (busy) return { ...prev, busy: true, job: r.job, url: prev.url ?? b?.pdf ?? null };
  if (r.job?.status === 'cancelled') return { ...prev, busy: false, job: r.job, ok: prev.ok, log: prev.log };
  if (!b) return { ...prev, busy: false, job: r.job ?? null };
  return { url: b.pdf, log: b.log, busy: false, ok: b.status === 'ok', warnings: b.warnings ?? [], tex: b.tex ?? (b.tex_path === prev.tex ? prev.tex : undefined), job: r.job ?? null, builtAt: b.updated_at };
}
