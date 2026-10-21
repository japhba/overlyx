/**
 * File ▸ LessWrong…: the document's link to a LessWrong draft (server lesswrong/). Connect the
 * account's LessWrong once (LessWrong's own consent page), create a draft on LessWrong — in its
 * rich-text editor, not Markdown mode: LessWrong's agent API edits only those — and paste its
 * address here. An empty draft gets the document, an empty document the draft; when both hold text,
 * this document's replaces the draft's, or the draft's differences come in as tracked changes.
 * Edits on LessWrong come back as edits (tracked while Suggesting); comments written here go to
 * LessWrong, and with the draft's link-sharing key (its edit address after "Anyone with the link
 * can: Edit") LessWrong's comment threads come here too, replies both ways.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type LessWrongStatus, type LessWrongLink } from '../api';
import { Dialog } from './Dialogs';
import './syncchip.css';

const ago = (t: number | null) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleString();
};

const elapsed = (since: number) => { const s = Math.max(0, Math.round((Date.now() - since) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** what a sync did, in words */
function summary(r: { pulled: number; pushed: number; comments: { fromLessWrong: number; toLessWrong: number }; notes?: string[]; warnings: string[] | number }): string {
  const n = (k: number, what: string) => (k ? `${k} ${what}${k === 1 ? '' : 's'}` : '');
  const parts = [r.pulled ? `${r.pulled} characters changed on LessWrong` : '', n(r.pushed, 'edit') && n(r.pushed, 'edit') + ' sent', n(r.comments.fromLessWrong, 'comment') && n(r.comments.fromLessWrong, 'comment') + ' from LessWrong', n(r.comments.toLessWrong, 'comment') && n(r.comments.toLessWrong, 'comment') + ' sent', ...(r.notes ?? [])].filter(Boolean);
  const warned = typeof r.warnings === 'number' ? r.warnings : r.warnings.length;
  if (warned) return 'Synced with some changes left out' + (typeof r.warnings === 'number' ? ' (see File ▸ LessWrong)' : ': ' + r.warnings.join(' '));
  return 'Synced with LessWrong' + (parts.length ? ': ' + parts.join(', ') : '');
}

/** a sync under way: what it is doing, how long it has taken, that it may take a while */
function Progress({ link }: { link: LessWrongLink }) {
  const p = link.syncing;
  if (!p) return null;
  return (
    <div class="lw-progress" data-lw-progress>
      <p><b>⟳ {p.phase}</b>{p.edits ? ` · ${p.edits} edit${p.edits === 1 ? '' : 's'} sent` : ''} · {elapsed(p.since)}</p>
      <p class="hint">LessWrong takes one edit per call and the sync reads the draft again after each round, so the first sync of a long document can take a minute or two. You can close this dialog: it carries on, and the ⇄ chip in the status bar shows it.</p>
    </div>
  );
}

export function LessWrongDialog({ docId, onClose, notify }: { docId: string; onClose: () => void; notify: (t: string, k?: 'info' | 'error') => void }) {
  const [st, setSt] = useState<LessWrongStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [keyUrl, setKeyUrl] = useState('');
  const [keep, setKeep] = useState<'ours' | 'merge'>('ours');
  const load = () => api.lwStatus(docId).then(setSt).catch(e => setError((e as Error).message));
  useEffect(() => { void load(); }, [docId]);
  // while a sync runs (or the link is being made): its progress every second and a half
  const syncing = !!st?.link?.syncing;
  useEffect(() => {
    if (!syncing && busy !== 'link') return;
    const iv = setInterval(() => { void load(); }, 1500);
    return () => clearInterval(iv);
  }, [syncing, busy, docId]);
  // a sync that ended after this dialog started waiting for it: say what it did
  const waiting = useRef<number | null>(null);
  useEffect(() => {
    const r = st?.link?.lastReport;
    if (waiting.current === null || syncing || !r || r.at < waiting.current) return;
    waiting.current = null;
    notify(st?.link?.lastError ? 'The LessWrong sync failed: ' + st.link.lastError : summary(r), st?.link?.lastError ? 'error' : 'info');
  }, [st]);
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const connect = () => { location.href = '/api/lesswrong/connect?next=' + encodeURIComponent(location.hash.replace(/\?.*$/, '') + '?lesswrong=connected'); };
  const link = st?.link;
  const expires = st?.account ? Math.round((st.account.expiresAt - Date.now()) / 86_400_000) : 0;
  return (
    <Dialog title="LessWrong" onClose={onClose}>
      <div class="gdocs-dialog" data-lesswrong>
        {!st && !error && <p class="hint">Loading…</p>}
        {st && !link && !st.account && (
          <>
            <p>Sync this document with a LessWrong draft: write here, readers comment and edit on LessWrong before you publish. Their edits come back as edits — as tracked changes to accept or reject while you are Suggesting — and comments go both ways.</p>
            {st.guest ? <p class="hint">Sign in to connect LessWrong.</p> : st.canEdit ? <button class="primary" data-lw-connect onClick={connect}>Connect LessWrong…</button> : <p class="hint">You can only view this project.</p>}
            <p class="hint">LessWrong asks you to allow OverLyX to read and edit your drafts (for 90 days; connect again then). OverLyX edits only the drafts you link here.</p>
          </>
        )}
        {st && !link && st.account && (
          st.canEdit ? <>
            <p>On LessWrong, start a new post (or open a draft) in the normal editor — <b>not Markdown mode</b>, which LessWrong’s API cannot edit — and paste its address here. An empty draft gets this document.</p>
            <label class="row">Draft <input data-lw-url placeholder="https://www.lesswrong.com/editPost?postId=…" value={url} onInput={e => setUrl((e.target as HTMLInputElement).value)} /></label>
            <div class="gdocs-keep" role="radiogroup" aria-label="If the draft already holds text">
              <span class="hint">If both hold text:</span>
              <label class="row"><input type="radio" name="lw-keep" checked={keep === 'ours'} data-lw-keep="ours" onChange={() => setKeep('ours')} /> This document's text replaces the draft's</label>
              <label class="row"><input type="radio" name="lw-keep" checked={keep === 'merge'} data-lw-keep="merge" onChange={() => setKeep('merge')} /> What the draft holds differently comes in here as tracked changes</label>
            </div>
            <div class="buttons-row">
              <button class="primary" data-lw-link disabled={!!busy || !url.trim()} onClick={() => act('link', async () => { waiting.current = Date.now(); await api.lwLink(docId, url.trim(), keep); })}>{busy === 'link' ? 'Linking…' : 'Link'}</button>
              <a href="https://www.lesswrong.com/newPost" target="_blank" rel="noopener">New post on LessWrong ↗</a>
            </div>
            {busy === 'link' && <p class="hint" data-lw-checking>⟳ Checking the draft on LessWrong (a few seconds)…</p>}
            <p class="hint">To have LessWrong's comments come here too, set the draft's sharing to “Anyone with the link can: Edit” and paste the edit address it then shows (with <code>&amp;key=…</code>).</p>
          </> : <p class="hint">You can only view this project.</p>
        )}
        {link && (
          <>
            <p><a href={link.url} target="_blank" rel="noopener" data-lw-open>{link.title ? `“${link.title}”` : 'The draft'} on LessWrong ↗</a>{link.draft === false ? ' (published: changes go to its editor; publish them there)' : ''}</p>
            <p class="hint">Last synced {ago(link.lastSync)}.{link.lastError ? '' : ' Edits made on LessWrong come back as edits (tracked while Suggesting).'}</p>
            <Progress link={link} />
            {link.lastError && !link.syncing && <p class="error">Last sync failed: {link.lastError}</p>}
            {link.warnings?.map(w => <p class="hint" data-lw-warning>{w}</p>)}
            <p class="hint">{link.comments ? 'Comment threads sync both ways; a thread resolved on LessWrong is resolved here (resolving here stays here: LessWrong’s API cannot).' : 'Comments written here go to LessWrong. For LessWrong’s comments to come here too, give the draft’s link-sharing address:'}</p>
            {st?.canEdit && !link.comments && (
              <div class="buttons-row">
                <input data-lw-key placeholder="https://www.lesswrong.com/editPost?postId=…&key=…" value={keyUrl} onInput={e => setKeyUrl((e.target as HTMLInputElement).value)} />
                <button disabled={!!busy || !keyUrl.trim()} onClick={() => act('key', async () => { await api.lwKey(docId, keyUrl.trim()); setKeyUrl(''); notify('LessWrong comments now come here too'); })}>{busy === 'key' ? 'Checking…' : 'Use'}</button>
              </div>
            )}
            {st?.canEdit && (
              <div class="buttons-row">
                <button class="primary" data-lw-sync disabled={!!busy || !!link.syncing} onClick={() => act('sync', async () => {
                  const started = Date.now();
                  const r = await api.lwSync(docId);
                  // (a long sync answers before it ends: its end is said when the dialog sees it)
                  if (r.report) notify(summary(r.report)); else waiting.current = started;
                })}>{busy === 'sync' || link.syncing ? 'Syncing…' : 'Sync now'}</button>
                <label class="row"><input type="checkbox" checked={link.auto} disabled={!!busy} onChange={e => act('auto', () => api.lwAuto(docId, (e.target as HTMLInputElement).checked))} /> Sync automatically</label>
                <button disabled={!!busy} onClick={() => act('unlink', async () => { await api.lwUnlink(docId); notify('No longer synced with LessWrong (the draft stays)'); })}>Unlink</button>
              </div>
            )}
          </>
        )}
        <p class="hint">The post's title, publishing it, and images from this project stay on LessWrong: add them there. Raw LaTeX and notes are not sent.</p>
        {error && <p class="error" data-lw-error>{error}</p>}
        {st?.account && (
          <p class="hint">LessWrong: connected{expires < 14 ? ` (for ${Math.max(expires, 0)} more days)` : ''} · {expires < 14 && <><a href="#" onClick={e => { e.preventDefault(); connect(); }}>Connect again</a> · </>}<a href="#" onClick={e => { e.preventDefault(); void act('disconnect', () => api.lwDisconnect()); }}>Disconnect</a></p>
        )}
      </div>
    </Dialog>
  );
}
