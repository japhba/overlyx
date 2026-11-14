/**
 * Download ▸ Pictures… / Handouts and notes pages…: what a deck or a poster exports as besides its
 * PDF and its website. The server renders them (deckexport.ts) like the PDF; this dialog chooses
 * what and how large, shows the size in pixels before anything is rendered (core
 * html/exportsize.ts has the server's limits, so nothing is offered that it would refuse) and
 * saves the file when it has come.
 */
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { Dialog } from '../app/Dialogs';
import { Slider } from '../app/TextStyles';
import { maxPictureScale, pictureScale, pictureSize, pageMm, dpiScale, CSS_DPI, HANDOUT_PER_PAGE, type HandoutPaper, type HandoutPerPage } from '@overlyx/core/html/exportsize.ts';
import { handoutGrid } from '@overlyx/core/html/handout.ts';
import type { MenuItem } from '../editor/contextmenu';
import type { DownloadPlace } from './host';
import './exportdialog.css';

export type ExportWhat = 'pictures' | 'handouts';
export interface ExportContext extends DownloadPlace { project: string; path: string; kind: 'deck' | 'poster' }

/** the Download menu's entries for what the server renders of a deck or a poster */
export function exportMenuItems(ctx: ExportContext): MenuItem[] {
  return [
    { label: ctx.kind === 'poster' ? 'Picture (PNG)…' : 'Pictures (PNG)…', action: () => openDeckExport('pictures', ctx) },
    ...(ctx.kind === 'deck' ? [{ label: 'Handouts and notes pages (PDF)…', action: () => openDeckExport('handouts', ctx) }] : []),
  ];
}

let open: HTMLElement | null = null;

export function openDeckExport(what: ExportWhat, ctx: ExportContext): void {
  if (open) return;
  const host = document.createElement('div');
  document.body.append(host);
  open = host;
  const close = () => { render(null, host); host.remove(); open = null; };
  render(what === 'pictures' ? <PicturesDialog ctx={ctx} onClose={close} /> : <HandoutsDialog ctx={ctx} onClose={close} />, host);
}

const remembered = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* private window */ } };

/** fetch what the server renders and hand it to the browser as a download; the server's own words when it refuses */
async function download(ctx: ExportContext, params: Record<string, string | number>): Promise<void> {
  const q = new URLSearchParams({ path: ctx.path, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const res = await fetch(`/api/projects/${encodeURIComponent(ctx.project)}/deliverable-export?${q}`, { credentials: 'same-origin' });
  if (!res.ok) {
    let message = `The export failed (${res.status}).`;
    try { const j = await res.json() as { error?: string }; if (j.error) message = j.error; } catch { /* not JSON */ }
    throw new Error(message);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'export';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** the dialog's lower part: what went wrong, Cancel and the button that exports */
function useExport(onClose: () => void): { busy: boolean; error: string; run(f: () => Promise<void>): void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return {
    busy, error,
    run(f) {
      setBusy(true); setError('');
      f().then(onClose, e => { setBusy(false); setError((e as Error).message || 'The export failed.'); });
    },
  };
}

const px = (s: { width: number; height: number }) => `${s.width} × ${s.height} pixels`;

function PicturesDialog({ ctx, onClose }: { ctx: ExportContext; onClose: () => void }) {
  const poster = ctx.kind === 'poster';
  const page = { width: ctx.width, height: ctx.height };
  const count = ctx.exported.filter(Boolean).length;
  const [all, setAll] = useState(false);
  const most = maxPictureScale(page, all ? count : 1);
  const [want, setWant] = useState(() => Number(remembered(poster ? 'ol.exportDpi' : 'ol.exportScale')) || (poster ? 150 : 2));
  const ex = useExport(onClose);
  // a poster's size is chosen as a print resolution (CSS pixels are 1/96 in), a slide's as a factor of its size on screen
  const scale = pictureScale(poster ? dpiScale(want) : want, page, all ? count : 1);
  const size = pictureSize(page, scale);
  const mm = pageMm(page);
  const mostDpi = Math.floor(most * CSS_DPI);
  const rungs = poster
    ? [{ v: 72, label: '72' }, { v: 96, label: 'screen' }, { v: 150, label: '150' }, { v: 200, label: '200' }, { v: 300, label: '300 dpi' }].filter(r => r.v <= mostDpi)
    : [{ v: 1, label: 'as on screen' }, { v: 1.5, label: page.width === 1280 ? 'Full HD' : '1.5×' }, { v: 2, label: '2×' }, { v: 3, label: page.width === 1280 ? '4K' : '3×' }, { v: 4, label: '4×' }].filter(r => r.v <= most + 0.001);
  const shown = poster ? Math.min(want, mostDpi) : Math.min(want, Math.floor(most * 20) / 20);
  const go = () => ex.run(async () => {
    remember(poster ? 'ol.exportDpi' : 'ol.exportScale', String(want));
    await download(ctx, poster ? { what: 'png', scale } : all ? { what: 'pngs', scale } : { what: 'png', slide: ctx.slide, scale });
  });
  return (
    <Dialog title={poster ? 'Export the poster as a picture' : 'Export slides as pictures'} onClose={onClose}
      buttons={<>
        <button class="btn primary" disabled={ex.busy} data-export-go onClick={go}>{ex.busy ? 'Drawing…' : poster ? 'Export PNG' : all ? `Export ${count} PNGs (.zip)` : 'Export PNG'}</button>
      </>}>
      <div class="dx" data-export="pictures">
        {!poster && (
          <div class="dx-row" role="radiogroup" aria-label="Which slides">
            <label><input type="radio" name="dx-which" checked={!all} onChange={() => setAll(false)} /> This slide (slide {ctx.slide + 1})</label>
            <label><input type="radio" name="dx-which" checked={all} disabled={count < 1} onChange={() => setAll(true)} data-export-all /> All {count} slides, in a .zip</label>
          </div>
        )}
        <div class="dx-label">{poster ? 'Resolution in print' : 'Size'}</div>
        <Slider min={poster ? 36 : 0.5} max={poster ? Math.max(72, Math.min(300, mostDpi)) : Math.max(1, Math.min(4, Math.floor(most * 20) / 20))} step={poster ? 1 : 0.05} value={shown} rungs={rungs}
          format={v => poster ? `${Math.round(v)} dpi` : `${Math.round(v * 100)} %`} onChange={setWant} />
        <p class="dx-size" data-export-size>
          <b>{px(size)}</b>{poster ? ` — ${mm.width} × ${mm.height} mm at ${Math.round(scale * CSS_DPI)} dpi` : ''}
        </p>
        {poster && mostDpi < 300 && <p class="dx-note">A poster this size is drawn at up to {mostDpi} dpi here: a larger picture is more than this server holds. For the print shop the PDF is the better file — it stays sharp at any size.</p>}
        {!poster && all && most < 4 && <p class="dx-note">{count} slides together are drawn at up to {Math.round(most * 100)} % here.</p>}
        {!poster && all && ctx.exported.some(e => !e) && <p class="dx-note">Skipped slides are left out, as in the PDF.</p>}
        {ex.error && <p class="dx-error" role="alert">{ex.error}</p>}
      </div>
    </Dialog>
  );
}

/** a small page with its slides (and lines) set out as the handout will be */
function PerPageIcon({ per }: { per: HandoutPerPage }) {
  const g = handoutGrid(per);
  const cells = [];
  for (let i = 0; i < per; i++) { cells.push(<i class="s" />); if (g.lines) cells.push(<i class="l" />); }
  return <span class={'dx-page' + (g.lines ? ' lines' : '')} style={{ gridTemplateColumns: g.lines ? '1fr 1fr' : `repeat(${g.cols}, 1fr)`, gridTemplateRows: `repeat(${g.rows}, 1fr)` }} aria-hidden="true">{cells}</span>;
}

function HandoutsDialog({ ctx, onClose }: { ctx: ExportContext; onClose: () => void }) {
  const [layout, setLayout] = useState<'handout' | 'notes'>(() => remembered('ol.handoutLayout') === 'notes' ? 'notes' : 'handout');
  const [per, setPer] = useState<HandoutPerPage>(() => { const n = Number(remembered('ol.handoutPer')); return (HANDOUT_PER_PAGE as readonly number[]).includes(n) ? n as HandoutPerPage : 3; });
  // (Letter where it is the paper: the United States, Canada, Mexico and a few more)
  const [paper, setPaper] = useState<HandoutPaper>(() => { const p = remembered('ol.handoutPaper'); return p === 'a4' || p === 'letter' ? p : /-(US|CA|MX|PH|CL|CO)\b/i.test(navigator.language) ? 'letter' : 'a4'; });
  const ex = useExport(onClose);
  const count = ctx.exported.filter(Boolean).length;
  const pages = layout === 'notes' ? count : Math.ceil(count / per);
  const go = () => ex.run(async () => {
    remember('ol.handoutLayout', layout); remember('ol.handoutPer', String(per)); remember('ol.handoutPaper', paper);
    await download(ctx, layout === 'notes' ? { what: 'notes', paper } : { what: 'handout', per, paper });
  });
  return (
    <Dialog title="Handouts and notes pages" onClose={onClose}
      buttons={<>
        <button class="btn primary" disabled={ex.busy || count < 1} data-export-go onClick={go}>{ex.busy ? 'Making the PDF…' : 'Export PDF'}</button>
      </>}>
      <div class="dx" data-export="handouts">
        <div class="dx-row" role="radiogroup" aria-label="What to print">
          <label><input type="radio" name="dx-layout" checked={layout === 'handout'} onChange={() => setLayout('handout')} /> Handouts: several slides on a page</label>
          <label><input type="radio" name="dx-layout" checked={layout === 'notes'} onChange={() => setLayout('notes')} data-export-notes /> Notes pages: a slide with its speaker notes below</label>
        </div>
        {layout === 'handout' && <>
          <div class="dx-label">Slides on a page</div>
          <div class="dx-per" role="radiogroup" aria-label="Slides on a page">
            {HANDOUT_PER_PAGE.map(n => (
              <button key={n} type="button" role="radio" aria-checked={per === n} class={'dx-per-btn' + (per === n ? ' on' : '')} data-export-per={n}
                title={n === 3 ? '3 slides, with lines for notes beside each' : `${n} slide${n === 1 ? '' : 's'}`} onClick={() => setPer(n)}>
                <PerPageIcon per={n} /><span>{n}{n === 3 ? ' + lines' : ''}</span>
              </button>
            ))}
          </div>
        </>}
        <div class="dx-label">Paper</div>
        <div class="dx-row" role="radiogroup" aria-label="Paper">
          <label><input type="radio" name="dx-paper" checked={paper === 'a4'} onChange={() => setPaper('a4')} /> A4</label>
          <label><input type="radio" name="dx-paper" checked={paper === 'letter'} onChange={() => setPaper('letter')} data-export-letter /> Letter</label>
        </div>
        <p class="dx-size" data-export-size><b>{pages} page{pages === 1 ? '' : 's'}</b> for {count} slide{count === 1 ? '' : 's'}{ctx.exported.some(e => !e) ? ' (skipped slides are left out)' : ''}</p>
        <p class="dx-note">The slides are pictures in this PDF, sharp in print; their text cannot be selected there as it can in the deck’s own PDF.</p>
        {ex.error && <p class="dx-error" role="alert">{ex.error}</p>}
      </div>
    </Dialog>
  );
}
