export interface Status { connected: boolean; synced: boolean; users: { name: string; color: string }[] }

export function StatusBar({ layout, status, chord, message, saved, tracking }: { layout: string; status: Status; chord: string | null; message: { text: string; kind: 'info' | 'error' } | null; saved: boolean; tracking: boolean }) {
  return (
    <div class="statusbar">
      <span><span class={'dot' + (status.connected ? ' on' : '')} />{status.connected ? (status.synced ? 'connected' : 'syncing…') : 'offline'}</span>
      <span title="Current paragraph layout">{layout}</span>
      {chord && <span class="chord">{chord} …</span>}
      {tracking && <span style="color:#b00" title="Change tracking is on (Ctrl+Shift+E)">● tracking changes</span>}
      {message && <span class={'msg ' + message.kind}>{message.text}</span>}
      <span class="spacer" />
      <span>{saved ? 'saved' : 'unsaved changes'}</span>
      <span class="users" title={status.users.map(u => u.name).join(', ')}>
        {status.users.map((u, i) => <span key={i} class="avatar" style={{ background: u.color }} title={u.name}>{u.name.slice(0, 1).toUpperCase()}</span>)}
      </span>
    </div>
  );
}
