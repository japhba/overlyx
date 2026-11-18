/**
 * "Copy link to …" (editor/permalink.ts) in the web app: who may open the link, asked first. The
 * people with access get the plain address of the place — also those a folder holding it (or the file)
 * is shared with on their own (server access.ts roleAt); anyone else needs a share link, made here with
 * the role picked — a new one each time, its role its own for good (Share ▸ Links lists them, ✕ turns
 * one off). A share link reaches what the owner picks: the innermost folder holding the place that is
 * already shared on its own (the default then), the file alone, its folder, or the whole project.
 * Only the owner makes share links; the others see who the plain link opens for.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type Project, type ShareInfo, type User } from '../api';
import { Dialog } from './Dialogs';
import { projectTitle } from './Home';
import { copyText, withShareToken } from '../editor/permalink';
import { docPathOf, projectOfDoc } from '@overlyx/core';

type Scope = 'access' | 'view' | 'edit';

/** The project and file a link's address names (`…#/<id>?…`, the id's `raw:` / `text:` / `pdf:` prefix aside). */
function linkTarget(url: string): { project: string; path: string } {
  const hash = url.slice(url.indexOf('#') + 1).replace(/^\/?/, '');
  const id = decodeURIComponent(hash.split('?')[0]).replace(/^(raw|text|pdf):/, '');
  return { project: projectOfDoc(id), path: docPathOf(id) };
}

/** "you, Bob and Carol", "you, Bob, Carol and 4 others" */
function names(list: string[]): string {
  const shown = list.length > 4 ? [...list.slice(0, 3), `${list.length - 3} others`] : list;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0] ?? '';
}

/** `rel` is `folder` (a folder or a file of the project) or lies in it (server foldershares.ts withinPath) */
const within = (rel: string, folder: string) => !!folder && (rel === folder || rel.startsWith(folder + '/'));

/** what a share link may reach: a folder or file of the project (alone), '' the whole project */
interface Reach { path: string; label: string; shared: boolean }

export function CopyLinkDialog({ url, what, user, notify, onClose }: { url: string; what: string; user: User; notify: (text: string, kind?: 'info' | 'error') => void; onClose: () => void }) {
  const { project: key, path } = linkTarget(url);
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [scope, setScope] = useState<Scope>('access');
  const [reach, setReach] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.projects().then(r => {
      const p = r.projects.find(x => x.name === key) ?? null;
      if (!live) return;
      setProject(p);
      // the owner also sees who folders and files of it are shared with on their own
      if (p?.role === 'owner') api.share(key).then(s => { if (live) setShare(s); }).catch(() => { /* the project's people only */ });
    }).catch(() => { if (live) setProject(null); });
    return () => { live = false; };
  }, [key]);
  const owner = project?.role === 'owner';
  const title = project ? projectTitle(project) : key;
  const me = (u: { username: string; name: string }) => (u.username === user.username ? 'you' : u.name);
  // who the plain address opens for: the owner and the people on the project …
  const people = project ? [
    project.owner ? (project.owner.id === user.id ? 'you' : project.owner.name) : null,
    ...(project.members ?? []).map(m => me(m)),
  ].filter((n): n is string => !!n) : [];
  // … and those a folder holding it, or the file, is shared with on their own
  const shareRows = (share?.folderMembers ?? []).filter(m => path && within(path, m.path));
  const extra = [...new Set(shareRows.map(m => (m.user ? me(m.user) : m.email ?? '')).filter(n => n && !people.includes(n)))];
  const extraPaths = [...new Set(shareRows.filter(m => extra.includes(m.user ? me(m.user) : m.email ?? '')).map(m => m.path))];
  const because = extraPaths.length !== 1 ? 'a folder holding it is shared with' : extraPaths[0] === path ? 'it is shared with' : `${extraPaths[0]}/ is shared with`;
  // a user who has only folders of the project sees neither its people nor who else the folder is shared with
  const mine = project?.partial ? (project.folders ?? []).filter(f => within(path, f.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
  const all = [...people, ...extra];
  const accessSub = !project ? '…'
    : project.public ? `Anyone can view it: “${title}” is public.`
    : project.partial ? `${project.owner?.name ?? 'Its owner'}, you and anyone else ${mine && mine.path !== path ? `${mine.path}/` : 'it'} is shared with.`
    : all.length <= 1 ? `Only you — nobody else has access to “${title}” yet.`
    : extra.length ? `The ${all.length} people who can open it: ${names(people)} (on “${title}”) and ${names(extra)} (${because} them).`
    : `The ${people.length} people on “${title}”: ${names(people)}.`;

  // what a new share link may reach: the folders holding the place that are shared on their own, its
  // folder, the file alone — narrowest first — and the whole project
  const sharedPaths = new Set([...(share?.folderMembers ?? []).map(m => m.path), ...(share?.links ?? []).flatMap(l => (l.path ? [l.path] : []))]);
  const isDir = (p: string) => project?.files.some(f => f.path === p && f.kind === 'dir') ?? false;
  const reaches: Reach[] = [];
  if (owner && path && !project?.e2e) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const candidates = [...new Set([path, ...(dir ? [dir] : []), ...[...sharedPaths].filter(f => within(path, f))])].sort((a, b) => b.length - a.length);
    for (const p of candidates) {
      const shared = sharedPaths.has(p);
      const label = p === path && !isDir(p) ? `only ${p.split('/').pop()}` : `${p}/`;
      reaches.push({ path: p, label: label + (shared ? ' — already shared' : ''), shared });
    }
  }
  reaches.push({ path: '', label: `all of “${title}”`, shared: false });
  // inherited: the innermost folder (or the file) already shared on its own, else the whole project as before
  const inherited = reaches.find(r => r.shared)?.path ?? '';
  const target = reach ?? inherited;
  const reachName = !target ? `“${title}”` : target === path && !isDir(target) ? target.split('/').pop()! : `${target}/`;
  const viewSub = !target
    ? `A new share link: they read every file of the project, not only ${path || 'this one'}, with its comments and history, and can download it or clone it with git. No account needed; a forwarded link works too.`
    : target === path && !isDir(target)
      ? `A new share link to this file alone: they read it with its comments and history, nothing else of the project — not the pictures or other files it uses. No account needed; a forwarded link works too.`
      : `A new share link to ${target}/ alone: they read what is in it, with its comments and history, and nothing else of the project. No account needed; a forwarded link works too.`;
  const editSub = !target
    ? 'A new share link: they can also change everything — write and comment, upload, rename and delete files, accept or reject tracked changes, restore earlier versions.'
    : target === path && !isDir(target)
      ? 'A new share link to this file alone: they can also write and comment in it, and accept or reject tracked changes.'
      : `A new share link to ${target}/ alone: they can also write and comment there, upload, rename and delete files in it, and accept or reject tracked changes.`;

  const copy = async () => {
    setBusy(true); setErr('');
    try {
      if (scope === 'access') {
        if (!await copyText(url)) throw new Error('The browser refused the clipboard: ' + url);
        notify(`Link to ${what} copied — it opens for the people with access`);
      } else {
        const made = api.createLink(key, scope, target || null).then(r => withShareToken(url, r.link.token));
        if (!await copyText(made)) throw new Error('The browser refused the clipboard: ' + await made);
        notify(`Link to ${what} copied — anyone who has it can ${scope === 'edit' ? 'edit' : 'view'} ${reachName}`);
      }
      onClose();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const choice = (s: Scope, label: string, sub: string, disabled = false) => (
    <label class={'pref' + (disabled ? ' disabled' : '')}>
      <input type="radio" name="ol-link-scope" data-link-scope={s} checked={scope === s} disabled={disabled} onChange={() => setScope(s)} />
      <span>{label}<span class="sub">{sub}</span></span>
    </label>
  );
  return (
    <Dialog title={`Copy link to ${what}`} onClose={onClose}
      buttons={<button class="btn primary" disabled={busy || project === undefined} data-link-scope-copy onClick={() => void copy()}>Copy link</button>}>
      <p>Who can open it?</p>
      {choice('access', 'People with access', accessSub)}
      {choice('view', 'Anyone with the link can view', viewSub, !owner)}
      {choice('edit', 'Anyone with the link can edit', editSub, !owner)}
      {owner && scope !== 'access' && reaches.length > 1 && (
        <label class="link-reach" data-link-reach>
          <span>The link reaches</span>
          <select value={target} onChange={e => setReach((e.target as HTMLSelectElement).value)}>
            {reaches.map(r => <option key={r.path} value={r.path}>{r.label}</option>)}
          </select>
        </label>
      )}
      <p class="hint">{owner
        ? 'Each share link keeps its role and reach for good. Share ▸ Links (or the folder’s Share Folder…) lists them, with who came in through each; ✕ turns one off.'
        : project ? `Only ${project.owner?.name ?? 'the owner'} can make links for people without access.` : ''}</p>
      {err && <div class="err" role="alert">{err}</div>}
    </Dialog>
  );
}
