import type { SaveState, PresenceUser } from '../editor/editor';
import { AvatarContent, initials } from './Avatar';

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
        ⚡ Offline{save.unavailable ? ' — document not available offline' : save.pending ? ' — changes kept on this device, will sync when back online' : ' — working from the local copy'}
      </span>
    );
  }
}

/** Presence avatars (top right of the menubar): one per connected client; click to jump to where that user is editing. */
export function UserAvatars({ users, onJump }: { users: PresenceUser[]; onJump?: (u: PresenceUser) => void }) {
  return (
    <span class="users" title={users.map(u => u.name).join(', ')}>
      {users.map(u => (
        <button key={u.clientId} type="button" class={'avatar' + (u.self ? ' self' : '') + (u.hasCursor ? ' has-cursor' : '')} style={{ background: u.color }}
          title={u.self ? `${u.name} (you)` : u.hasCursor ? `${u.name} — click to jump to their cursor` : `${u.name} — no cursor in this document yet`}
          data-client={u.clientId} data-username={u.username ?? ''} data-initials={u.avatar ? undefined : initials(u.name).length} onMouseDown={e => e.preventDefault()} onClick={() => onJump?.(u)}><AvatarContent name={u.name} src={u.avatar} /></button>
      ))}
    </span>
  );
}

/** LyX-style zoom control (bottom right): −, a percentage menu, + (Ctrl+Plus / Ctrl+Minus / Ctrl+0 do the same). */
export function ZoomControl({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
  const pct = Math.round(zoom * 100);
  const presets = [50, 75, 90, 100, 110, 125, 150, 175, 200, 250];
  return (
    <span class="zoom" title="Zoom the document text (Ctrl+Plus / Ctrl+Minus; Ctrl+0 resets)">
      <button type="button" class="zoom-btn" data-zoom-out onClick={() => onZoom(Math.max(0.5, +(zoom - 0.1).toFixed(2)))}>−</button>
      <select class="zoom-select" data-zoom value={String(pct)} onChange={e => onZoom(Number((e.target as HTMLSelectElement).value) / 100)}>
        {(presets.includes(pct) ? presets : [...presets, pct].sort((a, b) => a - b)).map(p => <option key={p} value={String(p)}>{p}%</option>)}
      </select>
      <button type="button" class="zoom-btn" data-zoom-in onClick={() => onZoom(Math.min(2.5, +(zoom + 0.1).toFixed(2)))}>+</button>
    </span>
  );
}

export interface DocStats { words: number; chars: number; sel: boolean }

export function StatusBar({ layout, status, chord, message, save, tracking, trackingAs, change, docLabel, readOnly, quiet, updateReady, aiBusy, stats, zoom, onZoom }: {
  layout: string; status: Status; chord: string | null; message: { text: string; kind: 'info' | 'error' } | null; save: SaveState;
  tracking: boolean; trackingAs?: string; change?: string | null; docLabel?: string | null; readOnly?: boolean;
  /** no document editor is open (start screen, text file): only messages */
  quiet?: boolean;
  /** a newer build of OverLyX is deployed than the one running in this tab */
  updateReady?: boolean;
  /** an autocomplete request is on its way (Tools ▸ AI assistance) */
  aiBusy?: boolean;
  /** word / character count of the selection (sel) or of the whole document */
  stats?: DocStats | null;
  zoom?: number;
  onZoom?: (z: number) => void;
}) {
  if (quiet) return <div class="statusbar">{message && <span class={'msg ' + message.kind}>{message.text}</span>}<span class="spacer" /></div>;
  return (
    <div class="statusbar">
      <span><span class={'dot' + (status.connected ? ' on' : '')} />{status.connected ? (status.synced ? 'connected' : 'syncing…') : save.state === 'connecting' ? 'connecting…' : 'offline'}</span>
      {docLabel && <span class="doclabel" title="Document under the cursor">{docLabel}</span>}
      <span title="Current paragraph layout">{layout}</span>
      {readOnly && <span class="readonly-badge" title="This project was shared with you for viewing: you can read and compile it, but not change it">👁 view only</span>}
      {aiBusy && <span class="ai-busy" title="Asking the model for a continuation…" data-ai-busy>✦ AI…</span>}
      {chord && <span class="chord">{chord} …</span>}
      {tracking && <span class="tracking" title="Change tracking is on (Ctrl+Shift+E): your edits are recorded under this name">● tracking changes{trackingAs ? ` as ${trackingAs}` : ''}</span>}
      {change && <span class="change-info" title="Tracked change under the cursor (right-click to accept / reject)">{change}</span>}
      {message && <span class={'msg ' + message.kind}>{message.text}</span>}
      <span class="spacer" />
      {updateReady && <button type="button" class="update-hint" title="A newer version of OverLyX is deployed. Reloading takes a second; your document is kept." onClick={() => location.reload()}>↻ new version — reload</button>}
      {stats && (
        <span class="stats" data-stats title={stats.sel ? 'Words and characters in the selection' : 'Words and characters in the document'}>
          {stats.sel ? 'selection: ' : ''}{stats.words.toLocaleString('en-US')} words, {stats.chars.toLocaleString('en-US')} characters
        </span>
      )}
      <SaveIndicator save={save} />
      {zoom !== undefined && onZoom && <ZoomControl zoom={zoom} onZoom={onZoom} />}
    </div>
  );
}
