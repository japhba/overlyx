/**
 * Connect to Zotero: a Zotero Web API key pasted here links the account's Zotero library (and the
 * groups the key reads) to the citation dialog's search (server zotero.ts) — its items are listed
 * first and cited with Zotero's own BibTeX. Shown in Settings ▸ Account, and folded behind
 * "Connect Zotero…" on the citation dialog's Find online tab (`compact`).
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type ZoteroStatus } from '../api';

export function ZoteroConnect({ status: given, compact, onChange }: { status?: ZoteroStatus | null; compact?: boolean; onChange?: (s: ZoteroStatus) => void }) {
  const [status, setStatus] = useState<ZoteroStatus | null>(given ?? null);
  useEffect(() => { if (given) setStatus(given); }, [given]);
  useEffect(() => { if (!given) api.zotero().then(setStatus).catch(() => setStatus({ connected: false })); }, []);
  const [open, setOpen] = useState(!compact);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async (f: () => Promise<ZoteroStatus>) => {
    setBusy(true); setErr('');
    try { const s = await f(); setStatus(s); setKey(''); onChange?.(s); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const connect = () => { if (key.trim() && !busy) void run(() => api.connectZotero(key.trim())); };

  if (!status) return compact ? null : <div class="sub">Checking…</div>;
  if (status.connected) {
    const groups = (status.libraries ?? []).filter(l => l !== 'My Library');
    return <div class="zotero-connect" data-zotero="connected">
      <span class="sub">Zotero: <b>{status.username}</b>{groups.length ? ` — and ${groups.length === 1 ? 'the group' : 'the groups'} ${groups.join(', ')}` : ''}</span>
      <button type="button" class="small-btn" disabled={busy} onClick={() => void run(() => api.disconnectZotero())} data-zotero-disconnect>Disconnect</button>
    </div>;
  }
  if (!open) return <button type="button" class="lit-link" onClick={() => setOpen(true)} data-zotero-open>Connect Zotero…</button>;
  return <div class="zotero-connect form" data-zotero="form">
    <div class="sub">The citation search then lists the matching papers of your Zotero library first and cites them with Zotero’s BibTeX. Create a key at <a href="https://www.zotero.org/settings/keys/new" target="_blank" rel="noopener">zotero.org/settings/keys</a> with <i>Allow library access</i> (reading is enough; give it group access for shared libraries) and paste it here. OverLyX keeps it encrypted and never writes to your library.</div>
    <div class="zotero-key">
      <input type="password" autocomplete="off" spellcheck={false} placeholder="Zotero API key" value={key} onInput={e => setKey((e.target as HTMLInputElement).value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); connect(); } }} data-zotero-key />
      <button type="button" class="btn" disabled={busy || !key.trim()} onClick={connect} data-zotero-connect>{busy ? 'Connecting…' : 'Connect'}</button>
    </div>
    {err && <div class="err" role="alert">{err}</div>}
  </div>;
}
