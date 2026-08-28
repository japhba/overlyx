/**
 * Start screen (no document open): the user's projects as cards — their personal example project
 * first, then their own projects, then what others shared with them.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type Project, type User } from '../api';

const isBackup = (name: string) => name.endsWith('~') || name.startsWith('#') || name.endsWith('.emergency');
const mainFirst = (a: string, b: string) => Number(!/(^|\/)main\.tex$/.test(a)) - Number(!/(^|\/)main\.tex$/.test(b)) || a.split('/').length - b.split('/').length || a.localeCompare(b);

export function projectDocs(p: Project): string[] {
  return p.files.filter(f => f.kind === 'doc' && !isBackup(f.name)).map(f => f.path).sort(mainFirst);
}
export const projectTitle = (p: Project) => p.title ?? p.name;

export function Home({ user, refreshKey, onOpen, onStartTour, onShare, onGit, onChanged, onBrowse, notify }: {
  user: User; refreshKey: number; onOpen: (id: string) => void; onStartTour: (id: string) => void; onShare: (project: string) => void; onGit: (project: string) => void; onChanged: () => void; onBrowse: () => void;
  notify: (text: string, kind?: 'info' | 'error') => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const load = () => api.projects().then(r => setProjects(r.projects)).catch(e => { setProjects([]); notify('Could not load projects: ' + (e as Error).message, 'error'); });
  useEffect(() => { void load(); }, [refreshKey]);

  const example = projects?.find(p => p.kind === 'example' && p.via === 'owner') ?? null;
  const mine = projects?.filter(p => p.via === 'owner' && p !== example) ?? [];
  const shared = projects?.filter(p => p.via === 'member' || p.via === 'link') ?? [];
  const admin = projects?.filter(p => p.via === 'admin') ?? [];
  const firstName = user.name.split(/\s+/)[0];

  const newProject = async () => {
    const name = prompt('Name of the new project (letters, digits, space, . _ -):');
    if (!name) return;
    try { await api.createProject(name.trim()); await load(); onChanged(); notify(`Project “${name.trim()}” created — add a document with + in the file browser`); }
    catch (e) { notify((e as Error).message, 'error'); }
  };
  const remove = async (p: Project) => {
    const what = p.kind === 'example' ? 'your example project (it will not be re-created)' : `the project “${projectTitle(p)}” and its ${p.files.length} file(s)`;
    if (!confirm(`Delete ${what}?\n\nThe folder is moved to the server's trash, not destroyed; ask an administrator to get it back.`)) return;
    try { await api.deleteProject(p.name); await load(); onChanged(); notify(`Project “${projectTitle(p)}” removed`); }
    catch (e) { notify((e as Error).message, 'error'); }
  };

  const card = (p: Project) => {
    const docs = projectDocs(p);
    const isExample = p === example;
    return (
      <div class={'home-card' + (isExample ? ' example' : '')} key={p.name} data-project={p.name}>
        <div class="title">
          <span>{isExample ? '👋 ' : '📁 '}{projectTitle(p)}</span>
          {p.via !== 'owner' && <span class={'badge' + (p.role === 'view' ? ' view' : '')}>{p.via === 'admin' ? 'admin' : p.role === 'view' ? 'can view' : 'can edit'}</span>}
        </div>
        {isExample && (
          <div class="blurb">
            A short tour of OverLyX written for you, {firstName}: text and layouts, formulas and macros, a figure, a table, citations, notes and comments, sharing and compiling.
            It is a normal LyX file in a project of your own — edit it, press <b>Ctrl+R</b> to see the PDF, share it with a colleague, or delete it when you are done.
            <b>Start the tour</b> opens it with an interactive walkthrough that asks you to try the essentials (every step can be skipped).
          </div>
        )}
        {!isExample && <div class="meta">{p.via === 'owner' ? 'Your project' : p.via === 'admin' ? (p.owner ? `Owned by ${p.owner.name} (${p.owner.username})` : 'No owner') : p.owner ? `Shared by ${p.owner.name}` : 'Shared with you'} · {docs.length} document{docs.length === 1 ? '' : 's'}, {p.files.length} file{p.files.length === 1 ? '' : 's'}</div>}
        <div class="docs">
          {docs.slice(0, isExample ? 1 : 6).map(d => <a key={d} href={'#/' + p.name + '/' + d} onClick={e => { e.preventDefault(); onOpen(p.name + '/' + d); }}>📄 {d}</a>)}
          {!isExample && docs.length > 6 && <span class="meta">+{docs.length - 6} more in the file browser</span>}
          {!docs.length && <span class="meta">No documents yet.</span>}
        </div>
        <div class="actions">
          {docs[0] && (isExample
            ? <button class="btn primary small" data-start-tour onClick={() => onStartTour(p.name + '/' + docs[0])}>Start the tour</button>
            : <button class="btn primary small" onClick={() => onOpen(p.name + '/' + docs[0])}>Open</button>)}
          {p.role === 'owner' && p.via !== 'admin' && <button class="btn small" onClick={() => onShare(p.name)} data-share={p.name}>Share…</button>}
          <button class="btn small" onClick={() => onGit(p.name)} data-git={p.name} title="Clone, pull and push this project with git">Git…</button>
          {p.role === 'owner' && <button class="btn small danger" title="Move this project to the trash" onClick={() => void remove(p)}>Delete</button>}
        </div>
      </div>
    );
  };

  return (
    <div class="home">
      <h1>Welcome{projects ? `, ${firstName}` : ''}</h1>
      <div class="sub">OverLyX edits LyX documents in the browser, together with others. Projects are private until you share them.</div>
      <div class="home-actions">
        <button class="btn primary" onClick={() => void newProject()}>+ New project</button>
        <button class="btn" onClick={onBrowse}>Open the file browser</button>
      </div>
      {projects === null && <div class="meta">Loading your projects…</div>}
      {example && <div class="cards">{card(example)}</div>}
      {mine.length > 0 && <><h3>Your projects</h3><div class="cards">{mine.map(card)}</div></>}
      {projects && !mine.length && !example && <div class="meta">You have no projects yet — create one, or ask a colleague to share theirs with you.</div>}
      {shared.length > 0 && <><h3>Shared with you</h3><div class="cards">{shared.map(card)}</div></>}
      {admin.length > 0 && <><h3>All other projects (administrator)</h3><div class="cards">{admin.map(card)}</div></>}
    </div>
  );
}
