import type { SaveState } from '../editor/editor';

export interface Status { connected: boolean; synced: boolean; users: { name: string; color: string }[] }

/** Google-Docs-style save indicator: everything is saved automatically; this tells where the edits are. */
export function SaveIndicator({ save }: { save: SaveState }) {
  const when = save.savedAt ? new Date(save.savedAt).toLocaleTimeString() : '';
  switch (save.state) {
    case 'saved': return <span class="save-state saved" title={when ? `The .lyx file on the server was last written at ${when}` : 'Everything is saved on the server'}>✓ All changes saved</span>;
    case 'saving': return <span class="save-state saving" title="Your edits are being written to the .lyx file on the server">Saving…</span>;
    case 'connecting': return <span class="save-state connecting">connecting…</span>;
    case 'offline': return (
      <span class="save-state offline" title={save.unavailable ? 'This document has not been opened on this device yet, so there is no local copy to show.' : 'No connection to the server. You can keep editing: changes are stored in this browser and sync automatically when the connection is back.'}>
        ⚡ Offline{save.unavailable ? ' — document not available offline' : save.pending ? ' — changes kept on this device, will sync when back online' : ' — working from the local copy'}
      </span>
    );
  }
}

export function StatusBar({ layout, status, chord, message, save, tracking, trackingAs, change, docLabel }: {
  layout: string; status: Status; chord: string | null; message: { text: string; kind: 'info' | 'error' } | null; save: SaveState;
  tracking: boolean; trackingAs?: string; change?: string | null; docLabel?: string | null;
}) {
  return (
    <div class="statusbar">
      <span><span class={'dot' + (status.connected ? ' on' : '')} />{status.connected ? (status.synced ? 'connected' : 'syncing…') : save.state === 'connecting' ? 'connecting…' : 'offline'}</span>
      {docLabel && <span class="doclabel" title="Document under the cursor">{docLabel}</span>}
      <span title="Current paragraph layout">{layout}</span>
      {chord && <span class="chord">{chord} …</span>}
      {tracking && <span class="tracking" title="Change tracking is on (Ctrl+Shift+E): your edits are recorded under this name">● tracking changes{trackingAs ? ` as ${trackingAs}` : ''}</span>}
      {change && <span class="change-info" title="Tracked change under the cursor (right-click to accept / reject)">{change}</span>}
      {message && <span class={'msg ' + message.kind}>{message.text}</span>}
      <span class="spacer" />
      <SaveIndicator save={save} />
      <span class="users" title={status.users.map(u => u.name).join(', ')}>
        {status.users.map((u, i) => <span key={i} class="avatar" style={{ background: u.color }} title={u.name}>{u.name.slice(0, 1).toUpperCase()}</span>)}
      </span>
    </div>
  );
}
