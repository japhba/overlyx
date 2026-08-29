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

/** Presence avatars: one per connected client; click to jump to where that user is editing. */
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

export function StatusBar({ layout, status, chord, message, save, tracking, trackingAs, change, docLabel, readOnly, quiet, updateReady, aiBusy, onJumpToUser }: {
  layout: string; status: Status; chord: string | null; message: { text: string; kind: 'info' | 'error' } | null; save: SaveState;
  tracking: boolean; trackingAs?: string; change?: string | null; docLabel?: string | null; readOnly?: boolean;
  /** no document editor is open (start screen, text file): only messages */
  quiet?: boolean;
  /** a newer build of OverLyX is deployed than the one running in this tab */
  updateReady?: boolean;
  /** an autocomplete request is on its way (Tools ▸ AI assistance) */
  aiBusy?: boolean;
  onJumpToUser?: (u: PresenceUser) => void;
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
      <SaveIndicator save={save} />
      <UserAvatars users={status.users} onJump={onJumpToUser} />
    </div>
  );
}
