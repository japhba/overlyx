/**
 * "Copy link to …" (editor/permalink.ts) in the web app: who may open the link, asked first. The
 * people with access get the plain address of the place; anyone else needs a share link, made here
 * with the role picked — a new one each time, its role its own for good (Share ▸ Links lists them,
 * ✕ turns one off). Only the owner makes share links; the others see who the plain link opens for.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type Project, type User } from '../api';
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

export function CopyLinkDialog({ url, what, user, notify, onClose }: { url: string; what: string; user: User; notify: (text: string, kind?: 'info' | 'error') => void; onClose: () => void }) {
  const { project: key, path } = linkTarget(url);
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  const [scope, setScope] = useState<Scope>('access');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.projects().then(r => { if (live) setProject(r.projects.find(p => p.name === key) ?? null); }).catch(() => { if (live) setProject(null); });
    return () => { live = false; };
  }, [key]);
  const owner = project?.role === 'owner';
  const title = project ? projectTitle(project) : key;
  // who the plain address opens for: the owner and the people on the project
  const people = project ? [
    project.owner ? (project.owner.id === user.id ? 'you' : project.owner.name) : null,
    ...(project.members ?? []).map(m => (m.username === user.username ? 'you' : m.name)),
  ].filter((n): n is string => !!n) : [];
  const accessSub = !project ? '…'
    : project.public ? `Anyone can view it: “${title}” is public.`
    : people.length <= 1 ? `Only you — nobody else has access to “${title}” yet.`
    : `The ${people.length} people on “${title}”: ${names(people)}.`;
  const copy = async () => {
    setBusy(true); setErr('');
    try {
      if (scope === 'access') {
        if (!await copyText(url)) throw new Error('The browser refused the clipboard: ' + url);
        notify(`Link to ${what} copied — it opens for the people with access`);
      } else {
        const made = api.createLink(key, scope).then(r => withShareToken(url, r.link.token));
        if (!await copyText(made)) throw new Error('The browser refused the clipboard: ' + await made);
        notify(`Link to ${what} copied — anyone who has it can ${scope === 'edit' ? 'edit' : 'view'} “${title}”`);
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
  const whole = `every file of the project, not only ${path || 'this one'}`;
  return (
    <Dialog title={`Copy link to ${what}`} onClose={onClose}
      buttons={<button class="btn primary" disabled={busy || project === undefined} data-link-scope-copy onClick={() => void copy()}>Copy link</button>}>
      <p>Who can open it?</p>
      {choice('access', 'People with access', accessSub)}
      {choice('view', 'Anyone with the link can view', `A new share link: they read ${whole}, with its comments and history, and can download it or clone it with git. No account needed; a forwarded link works too.`, !owner)}
      {choice('edit', 'Anyone with the link can edit', 'A new share link: they can also change everything — write and comment, upload, rename and delete files, accept or reject tracked changes, restore earlier versions.', !owner)}
      <p class="hint">{owner
        ? 'Each share link keeps its role for good. Share ▸ Links lists them, with who came in through each; ✕ turns one off.'
        : project ? `Only ${project.owner?.name ?? 'the owner'} can make links for people without access.` : ''}</p>
      {err && <div class="err" role="alert">{err}</div>}
    </Dialog>
  );
}
