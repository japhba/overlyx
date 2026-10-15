/**
 * File ▸ Google Docs…: the document's link to a Google Doc (server gdocs/). Connect the account's
 * Google Drive once, create a Google Doc from the document — or link it to one that exists, picked
 * in Google's picker (app/gpicker.ts; a Google Doc with tabs: one of its tabs), whose differences
 * then come in as tracked changes — and they stay in step both ways: edits made in Google Docs come
 * back as tracked changes by whoever made them, comment threads, replies and resolving go both ways,
 * on their own every minute, or with Sync now.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type GdocsStatus, type GdocsTab } from '../api';
import { Dialog } from './Dialogs';
import { pickGoogleDoc } from './gpicker';

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
  // a picked Google Doc with tabs: which tab this document is to be
  const [picked, setPicked] = useState<{ id: string; name: string; tabs: GdocsTab[]; tab: string } | null>(null);
  const linkExisting = (fileId: string, name: string, tabId: string | null) => act('existing', async () => {
    await api.gdocsLinkExisting(docId, fileId, tabId);
    setPicked(null);
    notify(`Linked to “${name}”: what it holds differently comes in as tracked changes`);
  });
  const pickExisting = () => act('pick', async () => {
    const id = await pickGoogleDoc('Link this document to a Google Doc');
    if (!id) return;
    const f = await api.gdocsFile(id);
    if (f.tabs.length > 1) setPicked({ ...f, tab: f.tabs[0].id });
    else await linkExisting(id, f.name, null);
  });
  return (
    <Dialog title="Google Docs" onClose={onClose}>
      <div class="gdocs-dialog" data-gdocs>
        {!st && !error && <p class="hint">Loading…</p>}
        {st && !st.configured && <p>Google is not set up on this server, so documents cannot be synced with Google Docs.</p>}
        {st && st.configured && !link && !st.account && (
          <>
            <p>Sync this document with a Google Doc: write here, collaborators comment and edit in Google Docs. Their edits come back as tracked changes you can accept or reject; comments, replies and resolving go both ways.</p>
            {st.guest ? <p class="hint">Sign in to connect Google Drive.</p> : st.canEdit ? <button class="primary" data-gdocs-connect onClick={connect}>Connect Google Drive…</button> : <p class="hint">You can only view this project.</p>}
            <p class="hint">OverLyX only gets access to the Google Docs it creates and the ones you pick (Drive's “files this app uses” permission).</p>
          </>
        )}
        {st && st.configured && !link && st.account && (
          <>
            <p>Create a Google Doc with this document's images and equations in the Google Drive of <b>{st.account.email ?? 'your account'}</b>. Text edits and comments then sync both ways.</p>
            <label class="row">Title <input value={title} onInput={e => setTitle((e.target as HTMLInputElement).value)} /></label>
            {st.canEdit
              ? <button class="primary" data-gdocs-create disabled={!!busy} onClick={() => act('create', async () => { await api.gdocsLink(docId, title); notify('Linked to a new Google Doc'); })}>{busy === 'create' ? 'Creating…' : 'Create Google Doc'}</button>
              : <p class="hint">You can only view this project.</p>}
            {st.canEdit && st.picker && !picked && (
              <p>Or <button data-gdocs-existing disabled={!!busy} onClick={pickExisting}>{busy === 'pick' ? 'Opening Google’s picker…' : 'Link an existing Google Doc…'}</button> — nothing is overwritten: what it holds differently comes in here as tracked changes.</p>
            )}
            {picked && (
              <>
                <p><b>{picked.name}</b> has {picked.tabs.length} tabs. This document is to be the tab</p>
                <select data-gdocs-tab value={picked.tab} onChange={e => setPicked({ ...picked, tab: (e.target as HTMLSelectElement).value })}>
                  {picked.tabs.map(t => <option key={t.id} value={t.id}>{'\u2003'.repeat(t.level)}{t.title}</option>)}
                </select>
                <div class="buttons-row">
                  <button class="primary" disabled={!!busy} onClick={() => linkExisting(picked.id, picked.name, picked.tab)}>{busy === 'existing' ? 'Linking…' : 'Link'}</button>
                  <button disabled={!!busy} onClick={() => setPicked(null)}>Cancel</button>
                </div>
                <p class="hint">To have every tab as a document, import the Google Doc instead (file list ▸ right click ▸ Import from Google Docs…): it becomes a document group.</p>
              </>
            )}
          </>
        )}
        {link && (
          <>
            <p><a href={link.url} target="_blank" rel="noopener" data-gdocs-open>Open in Google Docs ↗</a></p>
            <p class="hint">Last synced {ago(link.lastSync)}.{link.lastError ? '' : ' Edits made in Google Docs come back as tracked changes; comments go both ways.'}</p>
            {link.lastError && <p class="error">Last sync failed: {link.lastError}</p>}
            {link.warnings?.map(w => <p class="hint" data-gdocs-warning>{w}</p>)}
            {link.format !== 'docx' && (link.tabId
              ? <p class="hint">Equations show as <code>$…$</code> text in this Google Doc: a tab of a Google Doc with several can't be uploaded again as a whole. To include images and equations, unlink and create a new Google Doc.</p>
              : <p class="hint">Equations still show as <code>$…$</code> text in this Google Doc (the older text export). The next sync uploads this document into it again, so they become Google Docs equations — same link and sharing.</p>)}
            {st?.canEdit && (
              <div class="buttons-row">
                <button class="primary" data-gdocs-sync disabled={!!busy} onClick={() => act('sync', async () => {
                  const r = await api.gdocsSync(docId);
                  const parts = [r.report.pulled ? `${r.report.pulled} characters changed in Google Docs` : '', r.report.comments.fromGoogle ? `${r.report.comments.fromGoogle} comments from Google Docs` : '', r.report.comments.toGoogle ? `${r.report.comments.toGoogle} comments sent` : '', ...r.report.notes].filter(Boolean);
                  notify(r.report.warnings.length ? 'Synced with some changes left out: ' + r.report.warnings.join(' ') : 'Synced with Google Docs' + (parts.length ? ': ' + parts.join(', ') : ''));
                })}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
                <label class="row"><input type="checkbox" checked={link.auto} disabled={!!busy} onChange={e => act('auto', () => api.gdocsAuto(docId, (e.target as HTMLInputElement).checked))} /> Sync automatically</label>
                <button disabled={!!busy} onClick={() => act('unlink', async () => { await api.gdocsUnlink(docId); notify('No longer synced with Google Docs (the Google Doc stays)'); })}>Unlink</button>
              </div>
            )}
          </>
        )}
        {st?.configured && (!link || link.format === 'docx') && <div data-gdocs-limitations>
          <p class="hint">Images and equations go to Google Docs as a Word (DOCX) upload. Review complex equations: Google Docs can simplify their layout, including flattening matrices.</p>
          <p class="hint">When images or equations change here, the next sync uploads the whole document into the same Google Doc again (its link, sharing and version history stay). Comments made in Google Docs then keep their text but lose their place there; here they stay at theirs. Changes to images and equations made in Google Docs don't come back.</p>
        </div>}
        {error && <p class="error" data-gdocs-error>{error}</p>}
        {st?.account && (
          <p class="hint">Google Drive: {st.account.email ?? 'connected'} · <a href="#" onClick={e => { e.preventDefault(); void act('disconnect', () => api.gdocsDisconnect()); }}>Disconnect</a></p>
        )}
      </div>
    </Dialog>
  );
}
