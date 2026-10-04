/**
 * File ▸ Google Docs…: the document's link to a Google Doc (server gdocs/). Connect the account's
 * Google Drive once, create a Google Doc from the document, and they stay in step both ways — edits
 * made in Google Docs come back as tracked changes by whoever made them, comment threads, replies
 * and resolving go both ways — on their own every minute, or with Sync now.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type GdocsStatus } from '../api';
import { Dialog } from './Dialogs';

const ago = (t: number | null) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleString();
};

export function GoogleDocsDialog({ docId, onClose, notify }: { docId: string; onClose: () => void; notify: (t: string, k?: 'info' | 'error') => void }) {
  const [st, setSt] = useState<GdocsStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(() => (docId.split('/').pop() ?? '').replace(/\.[^.]+$/, ''));
  const load = () => api.gdocsStatus(docId).then(setSt).catch(e => setError((e as Error).message));
  useEffect(() => { void load(); }, [docId]);
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const connect = () => { location.href = '/api/gdocs/connect?next=' + encodeURIComponent(location.hash.replace(/\?.*$/, '') + '?gdocs=connected'); };
  const link = st?.link;
  return (
    <Dialog title="Google Docs" onClose={onClose}>
      <div class="gdocs-dialog" data-gdocs>
        {!st && !error && <p class="hint">Loading…</p>}
        {st && !st.configured && <p>Google is not set up on this server, so documents cannot be synced with Google Docs.</p>}
        {st && st.configured && !link && !st.account && (
          <>
            <p>Sync this document with a Google Doc: write here, collaborators comment and edit in Google Docs. Their edits come back as tracked changes you can accept or reject; comments, replies and resolving go both ways.</p>
            {st.guest ? <p class="hint">Sign in to connect Google Drive.</p> : st.canEdit ? <button class="primary" data-gdocs-connect onClick={connect}>Connect Google Drive…</button> : <p class="hint">You can only view this project.</p>}
            <p class="hint">OverLyX only gets access to the Google Docs it creates (Drive's “files this app created” permission).</p>
          </>
        )}
        {st && st.configured && !link && st.account && (
          <>
            <p>Create a Google Doc from this document in the Google Drive of <b>{st.account.email ?? 'your account'}</b>. From then on they are kept in step both ways.</p>
            <label class="row">Title <input value={title} onInput={e => setTitle((e.target as HTMLInputElement).value)} /></label>
            {st.canEdit
              ? <button class="primary" data-gdocs-create disabled={!!busy} onClick={() => act('create', async () => { await api.gdocsLink(docId, title); notify('Linked to a new Google Doc'); })}>{busy === 'create' ? 'Creating…' : 'Create Google Doc'}</button>
              : <p class="hint">You can only view this project.</p>}
          </>
        )}
        {link && (
          <>
            <p><a href={link.url} target="_blank" rel="noopener" data-gdocs-open>Open in Google Docs ↗</a></p>
            <p class="hint">Last synced {ago(link.lastSync)}.{link.lastError ? '' : ' Edits made in Google Docs come back as tracked changes; comments go both ways.'}</p>
            {link.lastError && <p class="error">Last sync failed: {link.lastError}</p>}
            {st?.canEdit && (
              <div class="buttons-row">
                <button class="primary" data-gdocs-sync disabled={!!busy} onClick={() => act('sync', async () => {
                  const r = await api.gdocsSync(docId);
                  const parts = [r.report.pulled ? `${r.report.pulled} characters changed in Google Docs` : '', r.report.comments.fromGoogle ? `${r.report.comments.fromGoogle} comments from Google Docs` : '', r.report.comments.toGoogle ? `${r.report.comments.toGoogle} comments sent` : ''].filter(Boolean);
                  notify('Synced with Google Docs' + (parts.length ? ': ' + parts.join(', ') : ''));
                })}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
                <label class="row"><input type="checkbox" checked={link.auto} disabled={!!busy} onChange={e => act('auto', () => api.gdocsAuto(docId, (e.target as HTMLInputElement).checked))} /> Sync automatically</label>
                <button disabled={!!busy} onClick={() => act('unlink', async () => { await api.gdocsUnlink(docId); notify('No longer synced with Google Docs (the Google Doc stays)'); })}>Unlink</button>
              </div>
            )}
          </>
        )}
        {error && <p class="error" data-gdocs-error>{error}</p>}
        {st?.account && (
          <p class="hint">Google Drive: {st.account.email ?? 'connected'} · <a href="#" onClick={e => { e.preventDefault(); void act('disconnect', () => api.gdocsDisconnect()); }}>Disconnect</a></p>
        )}
      </div>
    </Dialog>
  );
}
