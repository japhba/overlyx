/**
 * The PDF pane: the last build of the document in the pdf.js viewer, the build button (Ctrl+R)
 * with the auto-build settings under its ▾, how old the PDF is (and whether the document has
 * changed since), the log, the LaTeX as built, download and the public link. Builds are background
 * jobs on the server; while one runs the previous PDF stays in view, a thin line runs along the
 * top and a small note floats over the pages — nothing moves, and the new PDF takes the old one's
 * place at the same page (PdfViewer). The log opens by itself only after a build you asked for.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { encId, type BuildJob, type BuildInfo } from '../api';
import { PdfViewer, type PdfTarget } from './PdfViewer';
import { pdfStatus, useTicker, AUTO_BUILD_CHOICES, AUTO_BUILD_DELAYS } from './pdfstatus';
import { getPrefs, setPref, subscribePrefs, type Prefs } from '../prefs';

export interface PdfState {
  url: string | null; log: string; busy: boolean; ok: boolean | null; warnings: string[]; tex?: string;
  /** the running / queued job (builds run in the background on the server) */
  job?: BuildJob | null;
  /** when the last build finished (server time) */
  builtAt?: number;
  /** when the PDF file shown was written (server time; a failed build can leave the previous PDF) */
  pdfAt?: number | null;
  /** server clock − browser clock (ms), from the build status */
  skew?: number;
  /** the running / last build was started by the auto-build setting, not by the user */
  auto?: boolean;
  /** the build status of this document has been fetched at least once (auto-build waits for it) */
  known?: boolean;
}

export const EMPTY_PDF: PdfState = { url: null, log: '', busy: false, ok: null, warnings: [] };

const PHASE: Record<string, string> = { queued: 'waiting for a free build slot', exporting: 'exporting LaTeX', compiling: 'running latexmk' };


export function PdfPanel({ docId, state, savedAt, onBuild, onCancel, onShowTex, syncTarget, onForward, onInverse, onPublicLink, onClose }: {
  docId: string; state: PdfState;
  /** when the document's .tex file was last written (server time): a later save makes the PDF outdated */
  savedAt: number;
  onBuild: () => void; onCancel: () => void; onShowTex: () => void;
  /** SyncTeX: the place to show (forward search), and the double-clicked place (inverse search) */
  syncTarget?: PdfTarget | null; onForward?: () => void; onInverse?: (page: number, x: number, y: number) => void;
  /** the owner: a public address for this PDF (opens the Share dialog) */
  onPublicLink?: () => void;
  /** hide the pane */
  onClose?: () => void;
}) {
  const [showLog, setShowLog] = useState(false);
  const [menu, setMenu] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(getPrefs);
  useEffect(() => subscribePrefs(setPrefs), []);
  const menuRef = useRef<HTMLDivElement>(null);
  const job = state.job;
  const st = pdfStatus(state, savedAt, useTicker(state.busy || (state.pdfAt ? Date.now() + (state.skew ?? 0) - state.pdfAt < 60000 : false)));
  const elapsed = job ? Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) : 0;

  // a build you asked for that failed opens the log; the next good build closes it again (an automatic one never opens it)
  const openedByError = useRef(false);
  useEffect(() => {
    if (state.busy) return;
    if (state.ok === false && !state.auto) { setShowLog(true); openedByError.current = true; }
    else if (state.ok === true && openedByError.current) { setShowLog(false); openedByError.current = false; }
  }, [state.ok, state.builtAt, state.busy]);

  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); };
  }, [menu]);

  const progress = state.busy ? (
    <div class="build-progress" title={job?.progress}>
      <i class="spinner" /> {job ? `${PHASE[job.status] ?? job.status} · ${elapsed} s${job.rerun ? ' · then again with your latest changes' : ''}` : 'starting the build…'}
      {job?.progress && <i class="progress-line">{job.progress}</i>}
    </div>
  ) : null;
  const autoLabel = AUTO_BUILD_CHOICES.find(c => c[0] === prefs.autoBuild)?.[1] ?? 'Off';

  return (
    <div class="pdf-panel" data-pdf-pane>
      <div class="bar">
        <div class="pdf-build-split" ref={menuRef}>
          <button class="small-btn primary" data-pdf-build disabled={state.busy} onClick={() => onBuild()} title="Build the PDF with latexmk in the background (Ctrl+R)">{state.busy ? 'Building…' : 'View PDF'}</button>
          <button class={'small-btn caret' + (prefs.autoBuild !== 'off' ? ' auto-on' : '')} data-pdf-build-menu aria-haspopup="menu" aria-expanded={menu} title={`Automatic builds: ${autoLabel}`} onClick={() => setMenu(m => !m)}>▾</button>
          {menu && (
            <div class="pdf-build-menu" role="menu">
              <div class="head">Build automatically</div>
              {AUTO_BUILD_CHOICES.map(([v, label, hint]) => (
                <label key={v} class="choice" data-auto-build={v}>
                  <input type="radio" name="ol-autobuild" checked={prefs.autoBuild === v} onChange={() => setPref('autoBuild', v)} />
                  <div>{label}<div class="sub">{hint}</div></div>
                </label>
              ))}
              <label class="delay">Start
                <select data-auto-build-delay value={String(prefs.autoBuildDelay)} disabled={prefs.autoBuild === 'off'} onChange={e => setPref('autoBuildDelay', Number((e.target as HTMLSelectElement).value))}>
                  {AUTO_BUILD_DELAYS.map(d => <option key={d} value={String(d)}>{d === 0 ? 'right' : `${d} s`}</option>)}
                </select>
                after the document is saved
              </label>
              <div class="sub foot">The document is saved 1.5 s after you stop typing. Builds run on the server in the background; the PDF keeps its page and zoom.</div>
            </div>
          )}
        </div>
        {state.busy && <button class="small-btn" onClick={onCancel} title="Stop this build">Cancel</button>}
        <span class={'pdf-age ' + st.kind} data-pdf-age={st.kind} title={st.title}>{st.label}</span>
        <div class="pdf-bar-fill" />
        <button class={'small-btn' + (showLog ? ' active' : '') + (state.ok === false ? ' warn' : '')} onClick={() => { setShowLog(!showLog); openedByError.current = false; }} title="The build log">{showLog ? 'Hide log' : 'Log'}</button>
        <button class="small-btn" onClick={onShowTex} title="Show the LaTeX source as built">LaTeX</button>
        {state.url && <a class="small-btn" href={`/api/docs/${encId(docId)}/pdf?download=1`} target="_blank" title="Download the PDF">⤓</a>}
        {onPublicLink && <button class="small-btn" data-pdf-public-link onClick={onPublicLink} title="A stable public address for this PDF — link it from your web page (Share dialog ▸ Public PDF link)">🔗</button>}
        {onClose && <button class="small-btn close" onClick={onClose} title="Hide the PDF pane">✕</button>}
      </div>
      {state.url ? <PdfViewer url={state.url} target={syncTarget} onSync={onInverse} hint="Double-click the PDF to jump to that place in the document" busy={state.busy} overlay={progress}
        toolbar={onForward && <button class="small-btn" onClick={onForward} title="Show the cursor's place in the PDF (SyncTeX forward search, Ctrl+Alt+J)" data-pdf-sync>⇄ Sync</button>} />
        : <div class="pdf-empty">{progress}{state.busy ? 'Building the PDF in the background — you can keep editing.' : state.ok === false ? 'The build failed — see the log.' : 'No PDF yet — click “View PDF” (Ctrl+R).'}</div>}
      {showLog && (
        <div class="log">{state.warnings.length ? 'Exporter warnings:\n' + state.warnings.join('\n') + '\n\n' : ''}{state.log || '(no log)'}</div>
      )}
    </div>
  );
}

const ACTIVE = new Set(['queued', 'exporting', 'compiling']);
export const jobActive = (j: BuildJob | null | undefined): boolean => !!j && ACTIVE.has(j.status);

/** PdfState from the server's last build + job (`now`: the server's clock when it answered). */
export function stateFromBuild(prev: PdfState, r: { build: BuildInfo | null; job: BuildJob | null; now?: number }): PdfState {
  const busy = jobActive(r.job);
  const b = r.build;
  const skew = typeof r.now === 'number' ? r.now - Date.now() : prev.skew;
  // while a build runs, keep showing the previous PDF
  if (busy) return { ...prev, busy: true, job: r.job, skew, url: prev.url ?? b?.pdf ?? null, pdfAt: prev.url ? prev.pdfAt : b?.pdf_at ?? prev.pdfAt };
  if (r.job?.status === 'cancelled') return { ...prev, busy: false, job: r.job, skew, ok: prev.ok, log: prev.log };
  if (!b) return { ...prev, busy: false, job: r.job ?? null, skew };
  // a build without a PDF (the first run failed) keeps whatever is in view
  return {
    url: b.pdf ?? prev.url, pdfAt: b.pdf ? b.pdf_at ?? b.updated_at : prev.pdfAt, log: b.log, busy: false, ok: b.status === 'ok', warnings: b.warnings ?? [],
    tex: b.tex ?? (b.tex_path === prev.tex ? prev.tex : undefined), job: r.job ?? null, builtAt: b.updated_at, skew, auto: prev.auto, known: prev.known,
  };
}
