import type { ComponentChildren } from 'preact';
import type { SaveState, PresenceUser } from '../editor/editor';
import { AvatarContent, AgentBadge, initials } from './Avatar';
import { inkOn } from './contrast';
import { pdfStatus, useTicker, type PdfStatusInput } from './pdfstatus';
import { useEffect, useState } from 'preact/hooks';
import { styleLabel } from './stylenames';
import { formatPages } from './pagecount';
import { layoutZoom, layoutZoomStep, onLayoutZoom } from '../editor/layout/controller';
import { stepTextZoom } from './shellutil';
import { viewportZoom, onViewportZoom, resetViewportZoom } from './documentviewport';

export interface Status { connected: boolean; synced: boolean; users: PresenceUser[] }

/** Google-Docs-style save indicator: everything is saved automatically; this tells where the edits are. */
export function SaveIndicator({ save }: { save: SaveState }) {
  const when = save.savedAt ? new Date(save.savedAt).toLocaleTimeString() : '';
  switch (save.state) {
    case 'saved': return <span class="save-state saved" title={when ? `The .tex file on the server was last written at ${when}` : 'Everything is saved on the server'}>✓ All changes saved</span>;
    case 'saving': return <span class="save-state saving" title="Your edits are being written to the .tex file on the server">Saving…</span>;
    case 'connecting': return <span class="save-state connecting">connecting…</span>;
    case 'stale': return <span class="save-state offline" title="The document on the server has a different history than this copy; it is being reloaded.">⚠ document was re-created on the server — reloading…</span>;
    case 'offline': return (
      <span class="save-state offline" title={(save.unavailable ? 'This document has not been opened on this device yet, so there is no local copy to show. ' : 'You can keep editing: changes are stored in this browser and sync automatically when the connection is back. ') + (save.detail ? 'Reason: ' + save.detail + '.' : '')}>
        ⚡ Offline{save.unavailable ? ' — document not available offline' : save.localError ? ' — local save failed; keep this tab open' : save.localPending ? ' — saving changes on this device…' : save.pending ? ' — changes kept on this device, will sync when back online' : ' — working from the local copy'}
      </span>
    );
  }
}

/** Agents placed right after the person they work for (when that person is here too). */
function withAgentsByOwners(users: PresenceUser[]): PresenceUser[] {
  const people = users.filter(u => !u.agent), agents = users.filter(u => u.agent);
  const out: PresenceUser[] = [];
  people.forEach((p, i) => {
    out.push(p);
    // after the owner's last tab
    if (p.username && !people.slice(i + 1).some(q => q.username === p.username)) out.push(...agents.filter(a => a.owner?.username === p.username));
  });
  return [...out, ...agents.filter(a => !out.includes(a))];
}

/**
 * Presence avatars (top right of the menubar): one per connected client; click to jump to where that
 * user is editing. An agent wears the avatar of the account it works for, with a robot in the corner.
 */
export function UserAvatars({ users, onJump }: { users: PresenceUser[]; onJump?: (u: PresenceUser) => void }) {
  return (
    <span class="users" title={users.map(u => u.name).join(', ')}>
      {withAgentsByOwners(users).map(u => {
        const face = u.owner?.name ?? u.name;
        return (
          <button key={u.clientId} type="button" class={'avatar' + (u.self ? ' self' : '') + (u.hasCursor ? ' has-cursor' : '') + (u.agent ? ' agent' : '')} style={{ background: u.color, color: inkOn(u.color) }}
            title={u.self ? `${u.name} (you)` : `${u.name}${u.agent ? ' — an agent connected from elsewhere' + (u.owner ? `, working for ${u.owner.name}` : '') : ''}${u.hasCursor ? ' — click to jump to ' + (u.agent ? 'its' : 'their') + ' cursor' : ' — no cursor in this document yet'}`}
            data-client={u.clientId} data-username={u.username ?? ''} data-initials={u.avatar ? undefined : initials(face).length} onMouseDown={e => e.preventDefault()} onClick={() => onJump?.(u)}><AvatarContent name={face} src={u.avatar} />{u.agent && <AgentBadge />}</button>
        );
      })}
    </span>
  );
}

/** The separate viewport magnifier and its reset, displayed beside the text-size menu. */
export function ViewportZoomIndicator() {
  const [scale, setScale] = useState(viewportZoom);
  useEffect(() => { const read = () => setScale(viewportZoom()); const off = onViewportZoom(read); read(); return off; }, []);
  if (scale === null) return null;
  const pct = Math.round(scale * 100);
  return <span class="viewport-zoom-control"><button type="button" data-viewport-zoom-reset disabled={pct === 100}
    title="Viewport magnification (trackpad pinch). Click to reset to 100%. Text size and line breaks stay the same."
    aria-label={`Viewport zoom ${pct}%. Reset viewport zoom`} onClick={resetViewportZoom}>View {pct}%{pct !== 100 && ' ↺'}</button></span>;
}

/** Text size, plus the independent viewport level; layout canvases keep their own fit controls. */
export function ZoomControl({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
  // a layout document's canvas has its own zoom (pinch, Ctrl + wheel): "Fit" is the whole page
  const [canvas, setCanvas] = useState(layoutZoom());
  useEffect(() => onLayoutZoom(() => setCanvas(layoutZoom())), []);
  if (canvas) {
    const presets = [10, 25, 50, 75, 100, 150, 200, 300, 400];
    const cur = String(canvas.percent);
    return (
      <span class="zoom" title="Zoom the page (pinch or Ctrl + wheel, Ctrl+Plus / Ctrl+Minus; Fit shows the whole page, Fit width the page as wide as the window — a pinch stops at them)">
        <button type="button" class="zoom-btn" data-zoom-out onClick={() => layoutZoomStep(-1)}>−</button>
        <select class="zoom-select" data-zoom value={canvas.level ?? cur} onChange={e => { const v = (e.target as HTMLSelectElement).value; layoutZoomStep(v === 'fit' ? 0 : v === 'width' ? { level: 'width' } : { pct: Number(v) }); }}>
          <option value="fit">Fit{canvas.level === 'fit' ? ` (${canvas.percent}%)` : ''}</option>
          {canvas.width && <option value="width">Fit width{canvas.level === 'width' ? ` (${canvas.percent}%)` : ''}</option>}
          {(presets.includes(canvas.percent) || canvas.level ? presets : [...presets, canvas.percent].sort((a, b) => a - b)).map(p => <option key={p} value={String(p)}>{p}%</option>)}
        </select>
        <button type="button" class="zoom-btn" data-zoom-in onClick={() => layoutZoomStep(1)}>+</button>
      </span>
    );
  }
  const pct = Math.round(zoom * 100);
  const presets = [50, 75, 90, 100, 110, 125, 150, 175, 200, 250];
  return (
    <span class="zoom" title="Rendered text size (Ctrl+Plus / Ctrl+Minus; 100% resets). Exported font sizes stay the same.">
      <span class="zoom-label">Text</span>
      <button type="button" class="zoom-btn" data-zoom-out onClick={() => onZoom(stepTextZoom(zoom, -1))}>−</button>
      <select class="zoom-select" data-zoom value={String(pct)} onChange={e => onZoom(Number((e.target as HTMLSelectElement).value) / 100)}>
        {(presets.includes(pct) ? presets : [...presets, pct].sort((a, b) => a - b)).map(p => <option key={p} value={String(p)}>{p}%</option>)}
      </select>
      <button type="button" class="zoom-btn" data-zoom-in onClick={() => onZoom(stepTextZoom(zoom, 1))}>+</button>
      <ViewportZoomIndicator />
    </span>
  );
}

export interface DocStats { words: number; chars: number; sel: boolean; pages?: number }

/**
 * How old the PDF is, and whether the document has changed since (app/pdfstatus.ts) — in the
 * status bar, so it is there with the PDF pane closed too. A click shows the PDF, and builds it
 * when it is missing, outdated or from a failed build.
 */
export function PdfStatusChip({ pdf, savedAt, onClick }: { pdf: PdfStatusInput; savedAt: number; onClick: (rebuild: boolean) => void }) {
  const st = pdfStatus(pdf, savedAt, useTicker());
  if (st.kind === 'none' && !pdf.busy) return null;
  const rebuild = st.kind === 'outdated' || st.kind === 'error';
  return (
    <button type="button" class={'pdf-status ' + st.kind} data-pdf-status={st.kind} title={st.title + (rebuild ? ' Click to show and rebuild the PDF.' : ' Click to show the PDF.')} onClick={() => onClick(rebuild)}>
      {st.short}
    </button>
  );
}

function BuildVersion() {
  const version = import.meta.env.VITE_BUILD_VERSION;
  return <span class="build-version" title={`OverLyX build (UTC): ${version}`}>{version}</span>;
}

export function StatusBar({ layout, markdown, status, chord, message, save, tracking, trackingAs, change, docLabel, readOnly, quiet, updateReady, aiBusy, stats, pageInfo, zoom, onZoom, pdf, corner, sync }: {
  layout: string; /** a markdown document: headings are Heading 1 … */ markdown?: boolean; status: Status; chord: string | null; message: { text: string; kind: 'info' | 'error' } | null; save: SaveState;
  tracking: boolean; trackingAs?: string; change?: string | null; docLabel?: string | null; readOnly?: boolean;
  /** no document editor is open (start screen, text file): only messages and the build version */
  quiet?: boolean;
  /** a newer build of OverLyX is deployed than the one running in this tab */
  updateReady?: boolean;
  /** an autocomplete request is on its way (Tools ▸ AI assistance) */
  aiBusy?: boolean;
  /** word / character count of the selection (sel) or of the whole document */
  stats?: DocStats | null;
  /** the Pages view: the cursor's page in the last build, and the build's page count */
  pageInfo?: { page: number; pages: number; stale: boolean } | null;
  zoom?: number;
  onZoom?: (z: number) => void;
  /** the PDF's age / state (a document with a PDF pane) */
  pdf?: { state: PdfStatusInput; onClick: (rebuild: boolean) => void };
  /** the buttons of the panels folded away (the files): in the screen's bottom-left corner, never over the page */
  corner?: ComponentChildren;
  /** "⇄ In sync with VS Code" (SyncChip.tsx): the document is kept in step with a copy elsewhere */
  sync?: ComponentChildren;
}) {
  // (after them, `data-statusbar-slot`: an open slide deck's folded slides and notes, DeliverableEditor's portal)
  const start = <><span class="statusbar-corner">{corner}</span><span class="statusbar-slot" data-statusbar-slot /></>;
  if (quiet) return <div class="statusbar">{start}{message && <span class={'msg ' + message.kind}>{message.text}</span>}<span class="spacer" />{sync}<BuildVersion /></div>;
  return (
    <div class="statusbar">
      {start}
      <span><span class={'dot' + (status.connected ? ' on' : '')} />{status.connected ? (status.synced ? 'connected' : 'syncing…') : save.state === 'connecting' ? 'connecting…' : 'offline'}</span>
      {docLabel && <span class="doclabel" title="Document under the cursor">{docLabel}</span>}
      {document.documentElement.dataset.ui === 'modern' ? <span title="Paragraph style at the cursor">{styleLabel(layout, 'modern', markdown)}</span> : <span title="Current paragraph layout">{styleLabel(layout, 'classic', markdown)}</span>}
      {readOnly && <span class="readonly-badge" title="This project was shared with you for viewing: you can read and compile it, but not change it">👁 view only</span>}
      {aiBusy && <span class="ai-busy" title="Asking the model for a continuation…" data-ai-busy>✦ AI…</span>}
      {chord && <span class="chord">{chord} …</span>}
      {tracking && <span class="tracking" title="Change tracking is on (Ctrl+Shift+E): your edits are recorded under this name">● tracking changes{trackingAs ? ` as ${trackingAs}` : ''}</span>}
      {change && <span class="change-info" title="Tracked change under the cursor (right-click to accept / reject)">{change}</span>}
      {message && <span class={'msg ' + message.kind}>{message.text}</span>}
      <span class="spacer" />
      {updateReady && <button type="button" class="update-hint" title="A newer version of OverLyX is deployed. Reloading takes a second; your document is kept." onClick={() => location.reload()}>↻ new version — reload</button>}
      {stats && (
        <span class="stats" data-stats title={(stats.sel ? 'Words and characters in the selection' : 'Words and characters in the document')
          + (stats.pages !== undefined ? `, and the pages ${stats.sel ? 'it' : 'they'} would fill at 11pt — estimated for LaTeX's article class on A4 (43 lines of about 70 characters; headings, formulas, figures, tables and the references by the room they take). The PDF decides.` : '')}>
          {stats.sel ? 'selection: ' : ''}{stats.words.toLocaleString('en-US')} words, {stats.chars.toLocaleString('en-US')} characters
          {pageInfo ? <span class="stats-pages" data-stats-pages title={'In the last PDF build' + (pageInfo.stale ? ' — edited above since, so the page may have changed' : '')}>{' · '}page {pageInfo.page} of {pageInfo.pages}</span>
            : stats.pages !== undefined && <span class="stats-pages" data-stats-pages>{' · '}{formatPages(stats.pages)} at 11pt</span>}
        </span>
      )}
      <SaveIndicator save={save} />
      {sync}
      {pdf && <PdfStatusChip pdf={pdf.state} savedAt={save.savedAt} onClick={pdf.onClick} />}
      {zoom !== undefined && onZoom && <ZoomControl zoom={zoom} onZoom={onZoom} />}
      <BuildVersion />
    </div>
  );
}
