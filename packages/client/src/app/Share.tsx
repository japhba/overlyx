/**
 * Share dialog (Google-Docs style): people with access and their roles, invite by username or
 * e-mail, and "anyone with the link" with a copyable link (which also lets people in without an
 * account, as guests — app/Guest.tsx). Only the owner (or an administrator) sees it — the server
 * refuses everything else.
 */
import { useEffect, useState } from 'preact/hooks';
import { AvatarContent, initials } from './Avatar';
import { api, pdfLinkUrl, type ActivityEntry, type PdfLinkInfo, type PdfLinksInfo, type PdfPublishInfo, type ShareInfo, type User } from '../api';
import { ago } from './Git';
import { Dialog } from './Dialogs';

export function shareUrl(token: string): string { return `${location.origin}/#/share/${token}`; }

/** One activity entry as a sentence fragment after the person's name. */
export function describe(e: ActivityEntry): string {
  switch (e.action) {
    case 'open': return e.detail ? `opened ${e.detail}` : 'opened the project';
    case 'build': return e.detail ? `built the PDF of ${e.detail}` : 'built a PDF';
    case 'git-fetch': return 'pulled with git';
    case 'git-push': return 'pushed with git';
    case 'share': return e.detail ?? 'changed the sharing';
    case 'admin-access': return `opened the project as administrator${e.detail ? ` (${e.detail})` : ''}`;
    default: return e.detail ?? e.action;
  }
}

const ROLE_LABEL: Record<string, string> = { view: 'Viewer', edit: 'Editor' };

export function ShareDialog({ project, user, onClose, onChanged }: { project: string; user: User; onClose: () => void; onChanged?: () => void }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [err, setErr] = useState('');
  const [who, setWho] = useState('');
  const [role, setRole] = useState<'view' | 'edit'>('edit');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  // public PDF links: the project's documents and which of them have one
  const [pdf, setPdf] = useState<PdfLinksInfo | null>(null);
  const [copiedPdf, setCopiedPdf] = useState<string | null>(null);
  // publishing into a GitHub repository: the document whose target is being edited, and the fields
  const [pubEdit, setPubEdit] = useState<string | null>(null);
  const [pubRepo, setPubRepo] = useState('');
  const [pubPath, setPubPath] = useState('');
  const [pubBranch, setPubBranch] = useState('');
  // people join through the link while the dialog is open: keep the list fresh (poll + on focus)
  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([
      api.share(project).then(i => { if (alive) setInfo(i); }),
      api.activity(project, 40).then(r => { if (alive) setActivity(r.entries); }).catch(() => {}),
      api.pdfLinks(project).then(r => { if (alive) setPdf(r); }).catch(() => {}),
    ]).catch(e => { if (alive) setErr((e as Error).message); });
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
  const updatePdf = async (fn: () => Promise<{ links: PdfLinkInfo[] }>) => {
    setBusy(true); setErr('');
    try { const r = await fn(); setPdf(p => p ? { ...p, links: r.links } : p); onChanged?.(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const updatePublish = async (fn: () => Promise<{ publish: PdfPublishInfo[] }>): Promise<boolean> => {
    setBusy(true); setErr('');
    try { const r = await fn(); setPdf(p => p ? { ...p, publish: r.publish } : p); onChanged?.(); return true; }
    catch (e) { setErr((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const editPublish = (doc: string, cur?: PdfPublishInfo) => { setPubEdit(doc); setPubRepo(cur?.repo ?? ''); setPubPath(cur?.path ?? ''); setPubBranch(cur?.branch ?? ''); };
  const savePublish = async (doc: string) => {
    if (await updatePublish(() => api.setPdfPublish(project, { doc, repo: pubRepo, path: pubPath, branch: pubBranch || null }))) setPubEdit(null);
  };
  const copyPdf = async (l: PdfLinkInfo) => {
    const url = pdfLinkUrl(l);
    try { await navigator.clipboard.writeText(url); } catch { const el = document.querySelector<HTMLInputElement>(`[data-pdf-link-doc="${l.doc}"] input`); el?.select(); document.execCommand('copy'); }
    setCopiedPdf(l.token); setTimeout(() => setCopiedPdf(null), 2000);
  };

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
              <span class="avatar" style={{ background: 'var(--accent)' }} data-initials={initials(info.owner?.name ?? '?').length}>{initials(info.owner?.name ?? '?')}</span>
              <span class="who">{info.owner?.name ?? '—'}{info.owner && <small>{info.owner.id === user.id ? 'you' : info.owner.username}</small>}</span>
              <span class="role-static">Owner</span>
            </div>
            {info.members.map(m => (
              <div class="share-row" key={m.id} data-member={m.user?.username ?? m.email ?? ''}>
                {m.user
                  ? <span class="avatar" style={{ background: m.user.color }} data-initials={m.user.avatar ? undefined : initials(m.user.name).length}><AvatarContent name={m.user.name} src={m.user.avatar} /></span>
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
          <h4>Public PDF link</h4>
          <div class="hint">A stable address that serves the latest PDF of a document to anyone — link it from your web page, or embed it. It is rebuilt when the project changed; readers need no account.</div>
          <div class="pdf-links" data-pdf-links>
            {(pdf?.docs ?? []).map(d => {
              const l = pdf?.links.find(x => x.doc === d);
              return (
                <div key={d} data-pdf-link-doc={d}>
                  <div class="pdf-link-row">
                    <span class="doc" title={d}>📄 {d}</span>
                    {l ? (
                      <>
                        <input type="text" readonly value={pdfLinkUrl(l)} onFocus={e => (e.target as HTMLInputElement).select()} />
                        <button class="btn" disabled={busy} onClick={() => void copyPdf(l)}>{copiedPdf === l.token ? 'Copied ✓' : 'Copy'}</button>
                        <button class="mini" title="Turn the link off — the address stops working" disabled={busy} data-pdf-link-off onClick={() => void updatePdf(() => api.deletePdfLink(project, l.token))}>✕</button>
                      </>
                    ) : <button class="btn small" disabled={busy} data-pdf-link-on onClick={() => void updatePdf(() => api.createPdfLink(project, d))}>Turn on</button>}
                  </div>
                  {l && <div class="hint small">{l.built ? '' : 'Not built yet — the first reader waits for the build. '}{l.hits ? `Fetched ${l.hits} time${l.hits === 1 ? '' : 's'}${l.lastHitAt ? `, last ${ago(l.lastHitAt)}` : ''}.` : 'Nobody has fetched it yet.'}</div>}
                  {pdf?.publishAvailable && (() => {
                    const pub = pdf.publish.find(x => x.doc === d);
                    return (
                      <div class="pdf-publish" data-pdf-publish-doc={d}>
                        {pub && pubEdit !== d && (
                          <div class="hint small">
                            After every build the PDF is committed to <a href={pub.htmlUrl} target="_blank" rel="noopener">{pub.repo}:{pub.path}</a>{pub.branch ? ` (${pub.branch})` : ''} —{' '}
                            {pub.lastError ? <span class="err">{pub.lastError}</span> : pub.lastPushedAt ? `last pushed ${ago(pub.lastPushedAt)}` : 'nothing pushed yet'}.{' '}
                            <button class="mini" disabled={busy} data-pdf-publish-push onClick={() => void updatePublish(() => api.pushPdfPublish(project, d))}>Push now</button>{' '}
                            <button class="mini" disabled={busy} onClick={() => editPublish(d, pub)}>Change…</button>{' '}
                            <button class="mini" disabled={busy} title="Stop publishing (the file in the repository stays)" data-pdf-publish-off onClick={() => void updatePublish(() => api.deletePdfPublish(project, d))}>✕</button>
                          </div>
                        )}
                        {!pub && pubEdit !== d && <button type="button" class="fallback-link left" data-pdf-publish-on onClick={() => editPublish(d)}>Also commit the PDF to a GitHub repository (GitHub Pages)…</button>}
                        {pubEdit === d && (
                          <form class="share-add pdf-publish-form" onSubmit={e => { e.preventDefault(); void savePublish(d); }}>
                            <input type="text" placeholder="owner/repository" value={pubRepo} disabled={busy} data-pdf-publish-repo onInput={e => setPubRepo((e.target as HTMLInputElement).value)} />
                            <input type="text" placeholder="path/in/repo/name.pdf" value={pubPath} disabled={busy} data-pdf-publish-path onInput={e => setPubPath((e.target as HTMLInputElement).value)} />
                            <input type="text" class="branch" placeholder="branch" title="Branch (the default branch when empty)" value={pubBranch} disabled={busy} onInput={e => setPubBranch((e.target as HTMLInputElement).value)} />
                            <button class="btn" disabled={busy || !pubRepo.trim() || !pubPath.trim()} data-pdf-publish-save>Save & push</button>
                            <button type="button" class="mini" disabled={busy} onClick={() => setPubEdit(null)}>Cancel</button>
                          </form>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
            {pdf && !pdf.docs.length && <div class="hint">No documents in this project yet.</div>}
          </div>
          <h4>Activity</h4>
          <div class="hint">Who opened, built, pulled or pushed this project, changes to its sharing, and every time an administrator opened it (repeated opens by the same person are one entry per 10 minutes).</div>
          <div class="share-activity git-tokens" data-share-activity>
            {(activity ?? []).map(e => (
              <div class={'git-token' + (e.action === 'admin-access' ? ' admin' : '')} key={e.id}>
                <span class="name">{e.user ? (e.user.id === user.id ? 'You' : e.user.name) : 'Someone'}</span>
                <span class="what">{describe(e)}</span>
                <span class="meta">{ago(e.at)}</span>
              </div>
            ))}
            {activity && !activity.length && <div class="hint">Nothing yet.</div>}
          </div>
          <div class="hint">{info.link ? `Anyone who opens the link becomes ${info.link.role === 'edit' ? 'an editor' : 'a viewer'} — without an account as a guest (“Anonymous Otter”), who keeps the project by signing in. Switching back to Restricted removes everyone who came in through the link.` : 'Viewers can read and compile; editors can also change the documents and upload files.'}</div>
        </>
      )}
    </Dialog>
  );
}
