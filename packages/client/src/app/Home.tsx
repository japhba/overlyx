/**
 * Start screen (no document open): the user's projects — their personal example project first (a
 * welcome card), then their own projects, then what others shared with them, each group most recent
 * first (app/recency.ts: last opened by you, or last changed). Projects are listed as rows; the icon
 * at the right of the action bar switches to a grid of cards, remembered per browser (`ol.homeView`).
 */
import { useEffect, useState } from 'preact/hooks';
import { api, zipUrl, type AdminProjectInfo, type Project, type User } from '../api';
import { OverleafImport, type ImportInitial } from './OverleafImport';
import { takePendingImport } from './pendingImport';
import { sortByRecency, recencyLabel } from './recency';
import { projectShortName, splitProjectKey, isProjectName } from '@overlyx/core';
import { uiPrompt, uiConfirm } from './Dialogs';

const isBackup = (name: string) => name.endsWith('~') || name.startsWith('#') || name.endsWith('.emergency');
const mainFirst = (a: string, b: string) => Number(!/(^|\/)main\.tex$/.test(a)) - Number(!/(^|\/)main\.tex$/.test(b)) || a.split('/').length - b.split('/').length || a.localeCompare(b);

export function projectDocs(p: Project): string[] {
  return p.files.filter(f => f.kind === 'doc' && !isBackup(f.name)).map(f => f.path).sort(mainFirst);
}
/** a project's title, else its name without the owner (`jan/thesis` → `thesis`) */
export const projectTitle = (p: Project) => p.title ?? projectShortName(p.name);

type HomeView = 'rows' | 'grid';
const VIEW_KEY = 'ol.homeView';
function storedView(): HomeView {
  try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'rows'; } catch { return 'rows'; }
}
/** the view the switch leads to: a 2×2 grid of squares, or three lines with bullets */
const viewIcon = (to: HomeView) => to === 'grid'
  ? <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" /><rect x="9" y="1.5" width="5.5" height="5.5" rx="1" /><rect x="1.5" y="9" width="5.5" height="5.5" rx="1" /><rect x="9" y="9" width="5.5" height="5.5" rx="1" /></svg>
  : <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="2.5" cy="3.5" r="1.3" /><circle cx="2.5" cy="8" r="1.3" /><circle cx="2.5" cy="12.5" r="1.3" /><rect x="5.5" y="2.6" width="9" height="1.8" rx="0.9" /><rect x="5.5" y="7.1" width="9" height="1.8" rx="0.9" /><rect x="5.5" y="11.6" width="9" height="1.8" rx="0.9" /></svg>;

export function Home({ user, refreshKey, onOpen, onStartTour, onShare, onGit, onChanged, onBrowse, onSignIn, notify }: {
  user: User; refreshKey: number; onOpen: (id: string) => void; onStartTour: (id: string) => void; onShare: (project: string) => void; onGit: (project: string) => void; onChanged: () => void; onBrowse: () => void;
  /** guests cannot create projects; they are asked to sign in instead */
  onSignIn: () => void;
  notify: (text: string, kind?: 'info' | 'error') => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [adminList, setAdminList] = useState<AdminProjectInfo[] | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [view, setView] = useState<HomeView>(storedView);
  const switchView = () => {
    const next: HomeView = view === 'rows' ? 'grid' : 'rows';
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* the choice just is not remembered */ }
  };
  // an import chosen on the landing page before the sign-in: runs now, and a lone project opens itself
  const [pending, setPending] = useState<ImportInitial | null>(null);
  useEffect(() => {
    if (user.guest) return;
    void takePendingImport().then(p => { if (p) { setPending({ links: p.links, token: p.token, zips: p.zips }); setImportOpen(true); } });
  }, []);
  const openImported = async (names: string[]) => {
    if (names.length !== 1) return;
    try {
      const r = await api.projects();
      const p = r.projects.find(x => x.name === names[0]);
      const doc = p && projectDocs(p)[0];
      if (doc) { setImportOpen(false); setPending(null); onOpen(p.name + '/' + doc); }
    } catch { /* the start page shows the project */ }
  };
  const load = () => Promise.all([
    api.projects().then(r => setProjects(r.projects)).catch(e => { setProjects([]); notify('Could not load projects: ' + (e as Error).message, 'error'); }),
    user.isAdmin ? api.adminProjects().then(r => setAdminList(r.projects)).catch(() => setAdminList(null)) : Promise.resolve(),
  ]);
  useEffect(() => { void load(); }, [refreshKey]);
  // administrators do not see other people's projects; they can open one for an hour, and the owner sees that in the activity log
  const openAsAdmin = async (p: AdminProjectInfo) => {
    const ok = await uiConfirm('Open as Administrator', `Open "${p.title ?? p.name}" (owned by ${p.owner?.name ?? 'nobody'}) as administrator for one hour?\n\nThe owner will see this in the project's activity log.`);
    if (!ok) return;
    try { await api.adminAccess(p.name, 60); await load(); onChanged(); }
    catch (e) { notify((e as Error).message, 'error'); }
  };
  const others = (adminList ?? []).filter(p => p.access === null && p.kind !== 'example-gone');

  const example = projects?.find(p => p.kind === 'example' && p.via === 'owner') ?? null;
  const mine = sortByRecency(projects?.filter(p => p.via === 'owner' && p !== example) ?? []);
  const shared = sortByRecency(projects?.filter(p => p.via === 'member' || p.via === 'link') ?? []);
  const admin = projects?.filter(p => p.via === 'admin') ?? [];
  const firstName = user.guest ? 'guest' : user.name.split(/\s+/)[0];

  const newProject = async () => {
    const name = await uiPrompt('New Project', 'Name of the new project:', '', {
      placeholder: 'letters, digits, space, . _ -',
      validate: v => (v && !isProjectName(v) ? 'Only letters, digits, space, . _ - are allowed.' : null),
    });
    if (!name) return;
    try { await api.createProject(name.trim()); await load(); onChanged(); notify(`Project "${name.trim()}" created — add a document with + Doc in the documents panel`); }
    catch (e) { notify((e as Error).message, 'error'); }
  };
  const remove = async (p: Project) => {
    const what = p.kind === 'example' ? 'your example project (it will not be re-created)' : `the project "${projectTitle(p)}" and its ${p.files.length} file(s)`;
    const ok = await uiConfirm('Delete Project', `Delete ${what}?\n\nThe folder is moved to the server's trash, not destroyed; ask an administrator to get it back.`, { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    try { await api.deleteProject(p.name); await load(); onChanged(); notify(`Project "${projectTitle(p)}" removed`); }
    catch (e) { notify((e as Error).message, 'error'); }
  };

  const metaText = (p: Project, docs: string[]) =>
    `${p.via === 'owner' ? 'Your project' : p.via === 'admin' ? (p.owner ? `Owned by ${p.owner.name} (${p.owner.username})` : 'No owner') : p.owner ? `Shared by ${p.owner.name}` : 'Shared with you'} · ${docs.length} document${docs.length === 1 ? '' : 's'}, ${p.files.length} file${p.files.length === 1 ? '' : 's'}${recencyLabel(p) ? ` · ${recencyLabel(p)}` : ''}`;
  const badge = (p: Project) => p.via !== 'owner' && <span class={'badge' + (p.role === 'view' ? ' view' : '')}>{p.via === 'admin' ? 'admin' : p.role === 'view' ? 'can view' : 'can edit'}</span>;
  const docLink = (p: Project, d: string) => <a key={d} href={'#/' + p.name + '/' + d} onClick={e => { e.preventDefault(); onOpen(p.name + '/' + d); }}>📄 {d}</a>;
  const actions = (p: Project, docs: string[], isExample = false) => (
    <div class="actions">
      {docs[0] ? (isExample
        ? <button class="btn primary small" data-start-tour onClick={() => onStartTour(p.name + '/' + docs[0])}>Start the tour</button>
        : <button class="btn primary small" onClick={() => onOpen(p.name + '/' + docs[0])}>Open</button>)
        : <button class="btn primary small" onClick={() => onOpen(p.name)} title="This project has no documents yet — open it to create the first one">Open</button>}
      {p.role === 'owner' && p.via !== 'admin' && <button class="btn small" onClick={() => onShare(p.name)} data-share={p.name}>Share…</button>}
      <button class="btn small" onClick={() => onGit(p.name)} data-git={p.name} title="Clone, pull and push this project with git">Git…</button>
      <a class="btn small" data-download-zip={p.name} href={zipUrl(p.name)} title="Download the whole project as a .zip">Download</a>
      {p.role === 'owner' && <button class="btn small danger" title="Move this project to the trash" onClick={() => void remove(p)}>Delete</button>}
    </div>
  );

  const card = (p: Project) => {
    const docs = projectDocs(p);
    const isExample = p === example;
    return (
      <div class={'home-card' + (isExample ? ' example' : '')} key={p.name} data-project={p.name}>
        <div class="title">
          <span>{isExample ? '👋 ' : '📁 '}{projectTitle(p)}</span>
          {badge(p)}
        </div>
        {isExample && (
          <div class="blurb">
            A short tour of OverLyX written for you, {firstName}: text and layouts, formulas and macros, a figure, a table, citations, notes and comments, sharing and compiling.
            It is a normal LyX file in a project of your own — edit it, press <b>Ctrl+R</b> to see the PDF, share it with a colleague, or delete it when you are done.{' '}
            <b>Start the tour</b> opens it with an interactive walkthrough that asks you to try the essentials (every step can be skipped).
          </div>
        )}
        {!isExample && <div class="meta">{metaText(p, docs)}</div>}
        <div class="docs">
          {docs.slice(0, isExample ? 1 : 6).map(d => docLink(p, d))}
          {!isExample && docs.length > 6 && <span class="meta">+{docs.length - 6} more in the documents panel</span>}
          {!docs.length && <span class="meta">No documents yet.</span>}
        </div>
        {actions(p, docs, isExample)}
      </div>
    );
  };

  /** one line per project: name and facts on the left, its first documents on one line below (the count is in the facts), the actions on the right */
  const row = (p: Project) => {
    const docs = projectDocs(p);
    const target = docs[0] ? p.name + '/' + docs[0] : p.name;
    return (
      <div class="home-card home-row" key={p.name} data-project={p.name}>
        <div class="title">
          <a class="name" href={'#/' + target} onClick={e => { e.preventDefault(); onOpen(target); }}>📁 {projectTitle(p)}</a>
          {badge(p)}
        </div>
        <div class="meta">{metaText(p, docs)}</div>
        <div class="docs">
          {docs.slice(0, 8).map(d => docLink(p, d))}
          {!docs.length && <span class="meta">No documents yet.</span>}
        </div>
        {actions(p, docs)}
      </div>
    );
  };
  const list = (ps: Project[]) => <div class={'cards ' + view} data-home-view={view}>{ps.map(view === 'rows' ? row : card)}</div>;

  return (
    <div class="home">
      <h1>Welcome{projects ? `, ${firstName}` : ''}</h1>
      <div class="sub">{user.guest ? 'You are here as a guest, through a link somebody shared. Sign in to keep those projects in an account of your own — and to create projects.' : 'OverLyX edits LyX documents in the browser, together with others. Projects are private until you share them.'}</div>
      <div class="home-actions">
        {user.guest
          ? <button class="btn primary" data-guest-signin onClick={onSignIn}>Sign in</button>
          : <button class="btn primary" onClick={() => void newProject()}>+ New project</button>}
        {!user.guest && <button class="btn" data-import-overleaf onClick={() => setImportOpen(true)} title="Bring projects over from Overleaf — through its Git access, or from a downloaded zip">Import from Overleaf…</button>}
        <button class="btn" onClick={onBrowse}>Show the documents panel</button>
        <button class="home-view-switch" data-home-view-switch={view === 'rows' ? 'grid' : 'rows'} onClick={switchView}
          title={view === 'rows' ? 'Show projects as a grid of cards' : 'Show projects as a list'} aria-label={view === 'rows' ? 'Grid view' : 'List view'}>
          {viewIcon(view === 'rows' ? 'grid' : 'rows')}
        </button>
      </div>
      {importOpen && <OverleafImport existing={(projects ?? []).filter(p => splitProjectKey(p.name).owner === user.username).map(p => projectShortName(p.name))} onClose={() => { setImportOpen(false); setPending(null); }} onImported={() => { void load(); onChanged(); }} notify={notify}
        initial={pending ?? undefined} autostart={!!pending} onDone={names => void openImported(names)} />}
      {projects === null && <div class="meta">Loading your projects…</div>}
      {example && <div class="cards">{card(example)}</div>}
      {mine.length > 0 && <><h3>Your projects</h3>{list(mine)}</>}
      {projects && !mine.length && !example && !user.guest && <div class="meta">You have no projects yet — create one, or ask a colleague to share theirs with you.</div>}
      {shared.length > 0 && <><h3>Shared with you</h3>{list(shared)}</>}
      {admin.length > 0 && <><h3>Opened as administrator</h3>{list(admin)}</>}
      {user.isAdmin && adminList && others.length > 0 && (
        <>
          <h3>Administration</h3>
          <div class="meta">Other people's projects on this server. Administrators do not have access to them; opening one grants you owner rights for an hour and is written to the project's activity log, where its owner sees it.</div>
          <div class="git-tokens admin-projects" data-admin-projects>
            {others.map(p => (
              <div class="git-token" key={p.name} data-admin-project={p.name}>
                <span class="name">📁 {p.title ?? p.name}</span>
                <span class="meta">{p.owner ? `${p.owner.name} (${p.owner.username})` : 'no owner'}{p.kind === 'example' ? ' · example project' : ''}</span>
                <button class="mini" onClick={() => void openAsAdmin(p)}>Open as administrator…</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A project with no document yet, opened directly (its bare `#/owner/project` link: a brand-new
 * project's dashboard tile, the project switcher, or a bookmark). The file tree is already the left
 * sidebar (DocPanel); this is just the main area's landing, offering the one thing to do next.
 */
export function ProjectRootPanel({ project, notify, onCreated }: { project: string; notify: (text: string, kind?: 'info' | 'error') => void; onCreated: (id: string) => void }) {
  const [info, setInfo] = useState<Project | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setInfo(undefined);
    api.projects().then(r => { if (alive) setInfo(r.projects.find(p => p.name === project) ?? null); }).catch(() => { if (alive) setInfo(null); });
    return () => { alive = false; };
  }, [project]);
  const createFirstDoc = async () => {
    const name = await uiPrompt('New Document', `First document of "${projectShortName(project)}":`, 'main.tex', { placeholder: 'main.tex' });
    if (!name) return;
    try { const r = await api.newDoc(project, name, { title: name.replace(/\.(tex|lyx)$/, '') }); onCreated(r.id); }
    catch (e) { notify((e as Error).message, 'error'); }
  };
  if (info === undefined) return <div class="home"><div class="meta">Loading…</div></div>;
  if (info === null) return <div class="home"><h1>Not found</h1><div class="meta">This project does not exist, or you do not have access to it.</div></div>;
  return (
    <div class="home">
      <h1>📁 {projectTitle(info)}</h1>
      <div class="sub">This project has no documents yet. Its files (if any) are in the documents panel on the left.</div>
      <div class="home-actions">
        <button class="btn primary" onClick={() => void createFirstDoc()}>+ New document</button>
      </div>
    </div>
  );
}
