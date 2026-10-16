/**
 * Share dialog (Google-Docs style): people with access and their roles, invite by username or
 * e-mail, and "anyone with the link" with a copyable link (which also lets people in without an
 * account, as guests — app/Guest.tsx). The link shares the whole project and names the file it
 * opens — the one open when the dialog was, or another document picked under the link. Only the
 * owner (or an administrator) sees it — the server refuses everything else.
 */
import { useEffect, useState } from 'preact/hooks';
import { inkOn } from './contrast';
import { AvatarContent, initials } from './Avatar';
import { api, pdfLinkUrl, type ActivityEntry, type PdfLinkInfo, type PdfLinksInfo, type PdfPublishInfo, type ShareInfo, type User } from '../api';
import { ago } from './Git';
import { Dialog, uiConfirm } from './Dialogs';
import { docPathOf, projectOfDoc, projectShortName } from '@overlyx/core';

/**
 * A share link: the address of the file it opens (`#/<owner>/<project>/<path>`; the main document
 * without `path`) with the token that joins the project.
 */
export function shareUrl(token: string, project: string, path?: string | null): string {
  const seg = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  return `${location.origin}/#/${seg(project)}${path ? '/' + seg(path) : ''}?share=${token}`;
}

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

export function ShareDialog({ project, user, doc, onClose, onChanged }: { project: string; user: User; doc?: string | null; onClose: () => void; onChanged?: () => void }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  // the file the link opens: the one open in the workspace, else (from the start screen) the main document
  const openPath = doc && projectOfDoc(doc) === project ? docPathOf(doc) : null;
  const [linkPath, setLinkPath] = useState<string | null>(openPath);
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
  // hand the project over (before leaving OverLyX, or to the person who carries it on): it moves to
  // their account; the server keeps us on it as an editor
  const makeOwner = async (to: { name: string; username: string }) => {
    if (!await uiConfirm(`Make ${to.name} the owner?`, `“${info?.title ?? projectShortName(project)}” moves to ${to.name}’s account. You stay on it as an editor, but only ${to.name} can share it, change who may edit it, or delete it.`, { okLabel: 'Make owner' })) return;
    setBusy(true); setErr('');
    try { await api.setOwner(project, to.username); onChanged?.(); onClose(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  // a new link in place of the current one: the old address stops working (it went too far, say)
  const resetLink = async () => {
    if (!await uiConfirm('Reset the Link?', 'The current link stops working and a new one replaces it. People who already joined through the old link keep their access — remove them above, or switch to Restricted to remove them all.', { okLabel: 'Reset link' })) return;
    if (await update(() => api.resetLink(project))) setCopied(false);
  };
  const add = async () => { if (!who.trim() || busy) return; if (await update(() => api.addMember(project, who.trim(), role))) setWho(''); };
  const copy = async () => {
    if (!info?.link) return;
    const url = shareUrl(info.link.token, project, linkPath);
    try { await navigator.clipboard.writeText(url); } catch { const el = document.querySelector<HTMLInputElement>('.share-link input'); el?.select(); document.execCommand('copy'); }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  const title = info?.title ?? projectShortName(project);
  // what the link can open: the file open now and the project's documents (main document first)
  const linkFiles = [...new Set([...(openPath ? [openPath] : []), ...(pdf?.docs ?? [])])];
  useEffect(() => { if (linkPath === null && pdf?.docs.length) setLinkPath(pdf.docs[0]); }, [pdf]);
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
                  ? <span class="avatar" style={{ background: m.user.color, color: inkOn(m.user.color) }} data-initials={m.user.avatar ? undefined : initials(m.user.name).length}><AvatarContent name={m.user.name} src={m.user.avatar} /></span>
                  : <span class="avatar pending" title="Invited — has not signed in yet">✉</span>}
                <span class="who" title={m.user ? `${m.user.name} (${m.user.username})` : m.email ?? ''}>
                  {m.user ? m.user.name : m.email}
                  <small>{m.user ? m.user.username : 'invited, not signed in yet'}{m.via === 'link' ? ' · via link' : ''}</small>
                </span>
                <select value={m.role} disabled={busy} data-member-role onChange={e => {
                  const el = e.target as HTMLSelectElement;
                  if (el.value === 'owner') { el.value = m.role; if (m.user) void makeOwner(m.user); return; }
                  void update(() => api.setMemberRole(project, m.id, el.value as 'view' | 'edit'));
                }}>
                  <option value="edit">Editor</option><option value="view">Viewer</option>
                  {m.user && info.owner?.id === user.id && <option value="owner">Make owner…</option>}
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
              <input type="text" readonly value={shareUrl(info.link.token, project, linkPath)} onFocus={e => (e.target as HTMLInputElement).select()} />
              <button class="btn" onClick={() => void copy()}>{copied ? 'Copied ✓' : 'Copy link'}</button>
            </div>
          )}
          {info.link && linkFiles.length > 0 && (
            <div class="share-link-file hint">
              Opens{' '}
              {linkFiles.length > 1
                ? <select value={linkPath ?? ''} disabled={busy} data-link-file onChange={e => setLinkPath((e.target as HTMLSelectElement).value)}>
                    {linkFiles.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                : <b data-link-file>{linkFiles[0]}</b>}
              {' '}— and gives access to the whole project.
            </div>
          )}
          {info.link && (
            <div class="share-link-meta hint" data-link-created={info.link.createdAt ?? ''}>
              {info.link.createdAt && <span title={new Date(info.link.createdAt).toLocaleString()}>Link created {new Date(info.link.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.</span>}
              <button type="button" class="btn small" disabled={busy} data-link-reset title="Make a new link — the current one stops working" onClick={() => void resetLink()}>Reset link</button>
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
