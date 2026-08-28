/**
 * Share dialog (Google-Docs style): people with access and their roles, invite by username or
 * e-mail, and "anyone with the link" with a copyable link. Only the owner (or an administrator)
 * sees it — the server refuses everything else.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type ShareInfo, type User } from '../api';
import { Dialog } from './Dialogs';

export function shareUrl(token: string): string { return `${location.origin}/#/share/${token}`; }

const ROLE_LABEL: Record<string, string> = { view: 'Viewer', edit: 'Editor' };

export function ShareDialog({ project, user, onClose, onChanged }: { project: string; user: User; onClose: () => void; onChanged?: () => void }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [err, setErr] = useState('');
  const [who, setWho] = useState('');
  const [role, setRole] = useState<'view' | 'edit'>('edit');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // people join through the link while the dialog is open: keep the list fresh (poll + on focus)
  useEffect(() => {
    let alive = true;
    const load = () => api.share(project).then(i => { if (alive) setInfo(i); }).catch(e => { if (alive) setErr((e as Error).message); });
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 4000);
    window.addEventListener('focus', load);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', load); };
  }, [project]);

  const update = async (fn: () => Promise<{ share: ShareInfo }>): Promise<boolean> => {
    setBusy(true); setErr('');
    try { const r = await fn(); setInfo(r.share); onChanged?.(); return true; }
    catch (e) { setErr((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const add = async () => { if (!who.trim() || busy) return; if (await update(() => api.addMember(project, who.trim(), role))) setWho(''); };
  const copy = async () => {
    if (!info?.link) return;
    const url = shareUrl(info.link.token);
    try { await navigator.clipboard.writeText(url); } catch { const el = document.querySelector<HTMLInputElement>('.share-link input'); el?.select(); document.execCommand('copy'); }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  const title = info?.title ?? project;

  return (
    <Dialog title={`Share “${title}”`} onClose={onClose}>
      <div class="share-add">
        <input type="text" autofocus placeholder="Username or e-mail address" value={who} disabled={!info} onInput={e => setWho((e.target as HTMLInputElement).value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }} />
        <select value={role} onChange={e => setRole((e.target as HTMLSelectElement).value as 'view' | 'edit')}>
          <option value="edit">Editor</option><option value="view">Viewer</option>
        </select>
        <button class="btn" disabled={!who.trim() || busy || !info} onClick={() => void add()}>Add</button>
      </div>
      <div class="hint">People invited by e-mail get access the moment they sign in with Google using that address.</div>
      {err && <div class="err">{err}</div>}
      {info && (
        <>
          <h4>People with access</h4>
          <div class="share-list" data-share-members>
            <div class="share-row">
              <span class="avatar" style={{ background: '#3b6ea5' }}>{(info.owner?.name ?? '?').slice(0, 1).toUpperCase()}</span>
              <span class="who">{info.owner?.name ?? '—'}{info.owner && <small>{info.owner.id === user.id ? 'you' : info.owner.username}</small>}</span>
              <span class="role-static">Owner</span>
            </div>
            {info.members.map(m => (
              <div class="share-row" key={m.id} data-member={m.user?.username ?? m.email ?? ''}>
                {m.user
                  ? <span class="avatar" style={{ background: m.user.color }}>{m.user.avatar ? <img src={m.user.avatar} alt="" referrerpolicy="no-referrer" /> : m.user.name.slice(0, 1).toUpperCase()}</span>
                  : <span class="avatar pending" title="Invited — has not signed in yet">✉</span>}
                <span class="who" title={m.user ? `${m.user.name} (${m.user.username})` : m.email ?? ''}>
                  {m.user ? m.user.name : m.email}
                  <small>{m.user ? m.user.username : 'invited, not signed in yet'}{m.via === 'link' ? ' · via link' : ''}</small>
                </span>
                <select value={m.role} disabled={busy} onChange={e => void update(() => api.setMemberRole(project, m.id, (e.target as HTMLSelectElement).value as 'view' | 'edit'))}>
                  <option value="edit">Editor</option><option value="view">Viewer</option>
                </select>
                <button class="mini" title="Remove access" disabled={busy} onClick={() => void update(() => api.removeMember(project, m.id))}>✕</button>
              </div>
            ))}
            {!info.members.length && <div class="hint">Nobody else yet — add people above or turn on link sharing.</div>}
          </div>
          <h4>General access</h4>
          <div class="share-general">
            <select value={info.link ? 'link' : 'restricted'} disabled={busy} data-link-mode
              onChange={e => void update(() => api.setLink(project, (e.target as HTMLSelectElement).value === 'link' ? (info.link?.role ?? 'view') : null))}>
              <option value="restricted">Restricted — only the people listed above</option>
              <option value="link">Anyone with the link</option>
            </select>
            {info.link && (
              <select value={info.link.role} disabled={busy} data-link-role onChange={e => void update(() => api.setLink(project, (e.target as HTMLSelectElement).value as 'view' | 'edit'))}>
                <option value="view">{ROLE_LABEL.view}</option><option value="edit">{ROLE_LABEL.edit}</option>
              </select>
            )}
          </div>
          {info.link && (
            <div class="share-link">
              <input type="text" readonly value={shareUrl(info.link.token)} onFocus={e => (e.target as HTMLInputElement).select()} />
              <button class="btn" onClick={() => void copy()}>{copied ? 'Copied ✓' : 'Copy link'}</button>
            </div>
          )}
          <div class="hint">{info.link ? `Anyone who is signed in and opens the link becomes ${info.link.role === 'edit' ? 'an editor' : 'a viewer'}. Switching back to Restricted removes everyone who came in through the link.` : 'Viewers can read and compile; editors can also change the documents and upload files.'}</div>
        </>
      )}
    </Dialog>
  );
}
