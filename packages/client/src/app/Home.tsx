/**
 * Start screen (no document open): the user's projects — their personal example project first (a
 * welcome card), then their own projects, then what others shared with them, each group most recent
 * first (app/recency.ts: last opened by you, or last changed). Projects are listed as rows; the icon
 * at the right of the action bar switches to a grid of cards, remembered per browser (`ol.homeView`).
 */
import { useEffect, useState } from 'preact/hooks';
import { inkOn } from './contrast';
import { api, zipUrl, type AdminProjectInfo, type Project, type ProjectPerson, type User } from '../api';
import { AvatarContent, initials } from './Avatar';
import { OverleafImport, projectNameFrom, type ImportInitial } from './OverleafImport';
import { chooseGoogleImport } from './gpicker';
import { takePendingImport } from './pendingImport';
import { sortByRecency, recencyLabel } from './recency';
import { projectShortName, splitProjectKey, isProjectName } from '@overlyx/core';
import { uiConfirm, uiAlert, Dialog } from './Dialogs';
import { promptNewFile, createProjectFile } from './newfile';
import { useUiMode } from './uimode';
import { KIND_ICONS, iconSvg } from './modernicons';
import { ScientificTemplates } from './ScientificTemplates';
import { BetaNote } from './Login';

const isBackup = (name: string) => name.endsWith('~') || name.startsWith('#') || name.endsWith('.emergency');
const mainFirst = (a: string, b: string) => Number(!/(^|\/)main\.tex$/.test(a)) - Number(!/(^|\/)main\.tex$/.test(b)) || a.split('/').length - b.split('/').length || a.localeCompare(b);

/**
 * A project's documents, its main one first: the LaTeX and Markdown documents, and with
 * `deliverables` also its slide decks, posters and web pages (HTML files, decks first, after the documents).
 */
export function projectDocs(p: Project, deliverables = false): string[] {
  const docs = p.files.filter(f => f.kind === 'doc' && !isBackup(f.name)).map(f => f.path).sort(mainFirst);
  if (!deliverables) return docs;
  const order = { deck: 0, poster: 1, page: 2 } as const;
  const html = p.files.filter(f => f.kind === 'html' && !isBackup(f.name))
    .sort((a, b) => (order[a.deliverable ?? 'page'] - order[b.deliverable ?? 'page']) || mainFirst(a.path, b.path));
  return [...docs, ...html.map(f => f.path)];
}
const DELIVERABLE_NAME = { deck: 'slides', poster: 'poster', page: 'web page' } as const;
/** what a thing is, before its name: an emoji (the Modern interface draws a geometric mark for `kind` instead, modern.css) */
/** what a project or a document is: an emoji in Classic, a line icon in Modern (modernicons.ts KIND_ICONS) */
function Glyph({ kind, emoji }: { kind: string; emoji: string }) {
  const modern = useUiMode() === 'modern';
  return modern
    ? <span class="hglyph icon" data-kind={kind} aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconSvg(KIND_ICONS[kind] ?? KIND_ICONS.other, 15) }} />
    : <span class="hglyph" data-kind={kind} aria-hidden="true">{emoji}</span>;
}
/** how a document is listed: an HTML deliverable by its folder (an index.html) and what it is */
function docLabel(p: Project, d: string) {
  if (!/\.html?$/i.test(d)) return <><Glyph kind="doc" emoji="📄" /> {d}</>;
  const file = p.files.find(f => f.path === d);
  const kind = file?.deliverable;
  const name = /(^|\/)index\.html?$/i.test(d) && d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : d;
  // an article (core html/article.ts): a document, named by its folder
  if (file?.format === 'article') return <><Glyph kind="doc" emoji="📰" /> {name}{name.toLowerCase().includes('article') ? '' : ' (article)'}</>;
  const what = kind && !name.toLowerCase().includes(DELIVERABLE_NAME[kind].split(' ')[0]) ? ` (${DELIVERABLE_NAME[kind]})` : '';
  return <><Glyph kind={kind ?? 'page'} emoji={kind === 'deck' ? '🎞' : kind === 'poster' ? '🪧' : '🌐'} /> {name}{what}</>;
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
  const [importSource, setImportSource] = useState<'overleaf' | 'lyx'>('overleaf');
  // Google's picker is set up on this server: Import from Google Docs is offered
  const [gdocs, setGdocs] = useState(false);
  useEffect(() => { if (!user.guest) api.gdocsAccount().then(s => setGdocs(s.picker)).catch(() => setGdocs(false)); }, [user.guest]);
  /** a picked Google Doc as a project of its own, named after it — its document opened */
  const importGoogle = async () => {
    try {
      const choice = await chooseGoogleImport();
      if (!choice) return;
      const file = await api.gdocsFile(choice.fileId);
      const base = /[A-Za-z0-9]/.test(file.name) ? projectNameFrom(file.name) : 'Google Doc';
      let key = '';
      for (let k = 1; !key; k++) {
        try { key = (await api.createProject(k > 1 ? `${base} ${k}` : base)).project.name; }
        catch (e) { if (k >= 50 || !/exists already/.test((e as Error).message)) throw e; }
      }
      try {
        const r = await api.gdocsImport(key, choice.fileId, '', choice.sync);
        void load(); onChanged();
        onOpen(r.id);
      } catch (e) { await api.deleteProject(key).catch(() => undefined); throw e; }
    } catch (e) { await uiAlert('Import Failed', (e as Error).message); }
  };
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
    void takePendingImport().then(p => { if (p) { setPending({ links: p.links, token: p.token, zips: p.zips }); setImportSource(p.source ?? 'overleaf'); setImportOpen(true); } });
  }, []);
  const openImported = async (names: string[]) => {
    if (names.length !== 1) return;
    try {
      const r = await api.projects();
      const p = r.projects.find(x => x.name === names[0]);
      const doc = p && projectDocs(p, true)[0];
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

  const [newOpen, setNewOpen] = useState(false);
  const remove = async (p: Project) => {
    const what = p.kind === 'example' ? 'your example project (it will not be re-created)' : `the project "${projectTitle(p)}" and its ${p.files.length} file(s)`;
    const ok = await uiConfirm('Delete Project', `Delete ${what}?\n\nIt waits 30 days in the server's trash, then it is erased — until then, the people who run OverLyX can bring it back (Help ▸ Report a problem).`, { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    try { await api.deleteProject(p.name); await load(); onChanged(); notify(`Project "${projectTitle(p)}" removed`); }
    catch (e) { notify((e as Error).message, 'error'); }
  };

  const metaText = (p: Project, docs: string[]) =>
    `${p.via === 'owner' ? 'Your project' : p.via === 'admin' ? (p.owner ? `Owned by ${p.owner.name} (${p.owner.username})` : 'No owner') : p.owner ? `Shared by ${p.owner.name}` : 'Shared with you'} · ${docs.length} document${docs.length === 1 ? '' : 's'}, ${p.files.length} file${p.files.length === 1 ? '' : 's'}${recencyLabel(p) ? ` · ${recencyLabel(p)}` : ''}`;
  /** who joined the project (and who owns it, when it is someone else's): avatars, then the names — guests ("Anonymous Otter") left out */
  const people = (p: Project) => {
    type Face = Omit<ProjectPerson, 'role'> & { role: ProjectPerson['role'] | 'owner' };
    const owner: Face[] = p.via !== 'owner' && p.owner ? [{ name: p.owner.name, username: p.owner.username, color: '', avatar: null, role: 'owner', via: 'owner', since: 0, guest: false }] : [];
    const members = (p.members ?? []).filter(m => !m.guest && (m.username !== user.username || p.via === 'owner'));
    if (!members.length && !p.invited) return null;
    const when = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
    const shown: Face[] = [...owner, ...members];
    const names = members.map(m => (m.username === user.username ? 'you' : m.name.split(' ')[0]));
    return (
      <div class="people" data-people={p.name}>
        <span class="people-faces">
          {shown.slice(0, 6).map(m => (
            <span key={m.username} class={'avatar' + (m.role === 'owner' ? ' owner' : '')} style={{ background: m.color || 'var(--muted2)', color: m.color ? inkOn(m.color) : undefined }} data-initials={m.avatar ? undefined : initials(m.name).length}
              title={m.role === 'owner' ? `${m.name} (${m.username}) — owns this project` : `${m.name} (${m.username}) — ${m.role === 'edit' ? 'can edit' : 'can view'}, joined ${when(m.since)}${m.via === 'link' ? ' through the link' : ''}`}>
              <AvatarContent name={m.name} src={m.avatar} />
            </span>
          ))}
          {shown.length > 6 && <span class="avatar more">+{shown.length - 6}</span>}
        </span>
        <span class="people-names">{names.length ? `${names.length > 3 ? names.slice(0, 3).join(', ') + ` and ${names.length - 3} more` : names.join(', ').replace(/, ([^,]*)$/, ' and $1')} joined` : ''}{p.invited ? `${names.length ? ' · ' : ''}${p.invited} invited` : ''}</span>
      </div>
    );
  };
  const badge = (p: Project) => p.via !== 'owner' && <span class={'badge' + (p.role === 'view' ? ' view' : '')}>{p.via === 'admin' ? 'admin' : p.role === 'view' ? 'can view' : 'can edit'}</span>;
  const docLink = (p: Project, d: string) => <a key={d} href={'#/' + p.name + '/' + d} onClick={e => { e.preventDefault(); onOpen(p.name + '/' + d); }}>{docLabel(p, d)}</a>;
  const actions = (p: Project, docs: string[], isExample = false) => (
    <div class="actions">
      {docs[0] ? (isExample
        ? <button class="btn primary small" data-start-tour onClick={() => onStartTour(p.name + '/' + docs[0])}>Start the tour</button>
        : <button class="btn primary small" onClick={() => onOpen(p.name + '/' + docs[0])}>Open</button>)
        : <button class="btn primary small" onClick={() => onOpen(p.name)} title="This project has no documents yet — open it to create the first one">Open</button>}
      {p.role === 'owner' && p.via !== 'admin' && <button class="btn small" onClick={() => onShare(p.name)} data-share={p.name}>Share…</button>}
      <button class="btn small" onClick={() => onGit(p.name)} data-git={p.name} title="Clone, pull and push this project with git">Git…</button>
      <a class="btn small" data-download-zip={p.name} href={zipUrl(p.name)} title="Download the whole project as a .zip">Download</a>
      {p.files.some(f => f.kind === 'doc') && <a class="btn small" data-download-lyx={p.name} href={zipUrl(p.name, 'lyx')} title="Download the project as LyX documents with figures and bibliography">LyX</a>}
      {p.role === 'owner' && <button class="btn small danger" title="Move this project to the trash" onClick={() => void remove(p)}>Delete</button>}
    </div>
  );

  const card = (p: Project) => {
    const docs = projectDocs(p, true);
    const isExample = p === example;
    return (
      <div class={'home-card' + (isExample ? ' example' : '')} key={p.name} data-project={p.name}>
        <div class="title">
          <span>{isExample ? <Glyph kind="hello" emoji="👋" /> : <Glyph kind="project" emoji="📁" />} {projectTitle(p)}</span>
          {badge(p)}
        </div>
        {isExample && (
          <div class="blurb">
            A short tour of OverLyX: text and headings, formulas and macros, a figure, a table, citations, notes and comments, sharing and compiling.
            It is a plain LaTeX file in a project of your own — edit it, press <b>Ctrl+R</b> to see the PDF, share it with a colleague, or delete it when you are done.{' '}
            <b>Start the tour</b> opens it with an interactive walkthrough that asks you to try the essentials (every step can be skipped).
          </div>
        )}
        {!isExample && <div class="meta">{metaText(p, docs)}</div>}
        {people(p)}
        <div class="docs">
          {docs.slice(0, isExample ? 1 : 6).map(d => docLink(p, d))}
          {!isExample && docs.length > 6 && <span class="meta">+{docs.length - 6} more in the files panel</span>}
          {!docs.length && <span class="meta">No documents yet.</span>}
        </div>
        {actions(p, docs, isExample)}
      </div>
    );
  };

  /** one line per project: name and facts on the left, its first documents on one line below (the count is in the facts), the actions on the right */
  const row = (p: Project) => {
    const docs = projectDocs(p, true);
    const target = docs[0] ? p.name + '/' + docs[0] : p.name;
    return (
      <div class="home-card home-row" key={p.name} data-project={p.name}>
        <div class="title">
          <a class="name" href={'#/' + target} onClick={e => { e.preventDefault(); onOpen(target); }}><Glyph kind="project" emoji="📁" /> {projectTitle(p)}</a>
          {badge(p)}
        </div>
        <div class="meta">{metaText(p, docs)}</div>
        {people(p)}
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
      <h1>Welcome</h1>
      <div class="sub">{user.guest ? 'You are here as a guest, through a link somebody shared. Sign in to keep those projects in an account of your own — and to create projects.' : 'OverLyX edits LaTeX documents, slides and posters in the browser, together with others. Projects are private until you share them.'}</div>
      <BetaNote />
      <div class="home-actions">
        {user.guest
          ? <button class="btn primary" data-guest-signin onClick={onSignIn}>Sign in</button>
          : <button class="btn primary" data-new-project onClick={() => setNewOpen(true)} title="A new document, slide deck, poster or whiteboard — each in a project of its own">+ New</button>}
        {!user.guest && <button class="btn" data-import-overleaf onClick={() => { setImportSource('overleaf'); setImportOpen(true); }} title="Bring projects over from Overleaf — through its Git access, or from a downloaded zip">Import from Overleaf…</button>}
        {!user.guest && <button class="btn" data-import-lyx onClick={() => { setImportSource('lyx'); setImportOpen(true); }}>Import from LyX…</button>}
        {!user.guest && gdocs && <button class="btn" data-import-gdocs onClick={() => void importGoogle()} title="Bring a Google Doc over as a project of its own — kept in sync with it, or as a copy">Import from Google Docs…</button>}
        <button class="btn" onClick={onBrowse}>Show the files panel</button>
        <button class="home-view-switch" data-home-view-switch={view === 'rows' ? 'grid' : 'rows'} onClick={switchView}
          title={view === 'rows' ? 'Show projects as a grid of cards' : 'Show projects as a list'} aria-label={view === 'rows' ? 'Grid view' : 'List view'}>
          {viewIcon(view === 'rows' ? 'grid' : 'rows')}
        </button>
      </div>
      {newOpen && <NewProjectDialog onClose={() => setNewOpen(false)} notify={notify}
        onCreated={(id, name) => { setNewOpen(false); void load(); onChanged(); if (id) onOpen(id); else notify(`Project "${name}" created — add a document with + File in the files panel`); }} />}
      {importOpen && <OverleafImport source={importSource} existing={(projects ?? []).filter(p => splitProjectKey(p.name).owner === user.username).map(p => projectShortName(p.name))} onClose={() => { setImportOpen(false); setPending(null); }} onImported={() => { void load(); onChanged(); }} notify={notify}
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
                <span class="name"><Glyph kind="project" emoji="📁" /> {p.title ?? p.name}</span>
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

type NewKind = 'doc' | 'deck' | 'poster' | 'board' | 'empty';
const NEW_KINDS: { id: NewKind; label: string; hint: string; w: number; h: number; name: string }[] = [
  { id: 'doc', label: 'Document', hint: 'A paper, thesis or notes', w: 210, h: 297, name: 'Untitled document' },
  { id: 'deck', label: 'Slides', hint: '16:9 or 4:3, presented full screen', w: 16, h: 9, name: 'Untitled slides' },
  { id: 'poster', label: 'Poster', hint: '48 × 36 in or portrait', w: 48, h: 36, name: 'Untitled poster' },
  // (no page: its thumbnail is a patch of the endless dotted canvas, styles.css .ol-newthumb.board)
  { id: 'board', label: 'Whiteboard', hint: 'An endless canvas to draw and think on', w: 0, h: 0, name: 'Untitled whiteboard' },
  { id: 'empty', label: 'Empty project', hint: 'Add files later', w: 0, h: 0, name: '' },
];

/**
 * The start page's + New: a document, slides, a poster or a whiteboard, each in a project of its own
 * (named like it), opened right away — or an empty project. Inside a project, + File and File ▸ New … add more.
 */
export function NewProjectDialog({ onClose, onCreated, notify }: { onClose: () => void; onCreated: (id: string | null, name: string) => void; notify: (text: string, kind?: 'info' | 'error') => void }) {
  const [kind, setKind] = useState<NewKind>('doc');
  const [template, setTemplate] = useState<string>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const k = NEW_KINDS.find(x => x.id === kind)!;
  const typed = name.trim();
  const invalid = typed && !isProjectName(typed) ? 'Only letters, digits, space, . _ - are allowed.' : null;
  const create = async (selectedKind = kind) => {
    const n = typed || NEW_KINDS.find(k => k.id === selectedKind)!.name;
    if (!n || invalid) return;
    setBusy(true);
    try {
      const { project } = await api.createProject(n);
      const key = project.name;
      const chosenTemplate = selectedKind === kind ? template : undefined;
      const id = selectedKind === 'doc' ? (await api.newDoc(key, 'main.tex', { title: n })).id
        : selectedKind === 'deck' ? (await api.newDeliverable(key, 'slides', 'deck', n, chosenTemplate)).id
        : selectedKind === 'poster' ? (await api.newDeliverable(key, 'poster', 'poster', n, chosenTemplate)).id
        : selectedKind === 'board' ? await createProjectFile(key, 'whiteboard.board')
        : null;
      onCreated(id, n);
    } catch (e) { setBusy(false); notify((e as Error).message, 'error'); }
  };
  return (
    <Dialog title="New" onClose={onClose} buttons={
      <button type="button" class="small-btn primary" disabled={busy || !!invalid || (kind === 'empty' && !typed)} onClick={() => void create()} data-new-create>Create</button>
    }>
      <div class="ol-newkinds five" role="radiogroup" aria-label="What to make">
        {NEW_KINDS.map(x => {
          const s = x.w ? 44 / Math.max(x.w, x.h) : 0;
          return (
            <button key={x.id} type="button" role="radio" aria-checked={x.id === kind} class={'ol-newkind' + (x.id === kind ? ' active' : '')} data-new-kind={x.id}
              onClick={() => { setKind(x.id); setTemplate(undefined); }} onDblClick={() => { if (x.id !== 'empty') void create(x.id); }}>
              <span class={'ol-newthumb' + (x.id === 'board' ? ' board' : x.w ? '' : ' empty')} style={x.w ? { width: `${x.w * s}px`, height: `${x.h * s}px` } : undefined}>
                {x.id === 'board' && <svg viewBox="0 0 44 34" aria-hidden="true"><path d="M10 22c4-9 8-11 11-6s6 4 8-2 4-5 6-1" /></svg>}
              </span>
              <span>{x.label}</span>
              <small>{x.hint}</small>
            </button>
          );
        })}
      </div>
      {(kind === 'deck' || kind === 'poster') && <ScientificTemplates kind={kind} value={template} onChange={setTemplate} />}
      <label class="dialog-row">Name <input type="text" value={name} autofocus placeholder={k.name || 'Name of the project'} data-new-name
        onInput={e => setName((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter') void create(); }} /></label>
      {invalid && <p class="dialog-hint error">{invalid}</p>}
      <p class="dialog-hint">{kind === 'empty' ? 'A project holds documents, slides, figures and a bibliography together. Share it to work on it with others.' : kind === 'board' ? `It gets a project of its own, “${typed || k.name}”, where the pictures you put on it are kept too.` : `It gets a project of its own, “${typed || k.name}”, where figures and a bibliography can go too.`}</p>
    </Dialog>
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
    const id = await promptNewFile(project, { where: projectShortName(project), initial: 'main.tex', title: 'New Document' }).catch(e => { notify((e as Error).message, 'error'); return null; });
    if (id) onCreated(id);
  };
  const createDeliverable = async (kind: 'deck' | 'poster') => {
    try { onCreated((await api.newDeliverable(project, kind === 'deck' ? 'slides' : 'poster', kind, projectShortName(project))).id); }
    catch (e) { notify((e as Error).message, 'error'); }
  };
  if (info === undefined) return <div class="home"><div class="meta">Loading…</div></div>;
  if (info === null) return <div class="home"><h1>Not found</h1><div class="meta">This project does not exist, or you do not have access to it.</div></div>;
  const docs = projectDocs(info, true);
  return (
    <div class="home">
      <h1><Glyph kind="project" emoji="📁" /> {projectTitle(info)}</h1>
      {docs.length ? <>
        <div class="sub">Open one of its documents — all its files are in the files panel on the left.</div>
        <div class="docs project-docs">{docs.map(d => <a key={d} href={'#/' + project + '/' + d.split('/').map(encodeURIComponent).join('/')} onClick={e => { e.preventDefault(); onCreated(project + '/' + d); }}><Glyph kind="doc" emoji="📄" /> {d}</a>)}</div>
      </> : <div class="sub">This project has no documents yet. Its files (if any) are in the files panel on the left.</div>}
      <div class="home-actions">
        <button class="btn primary" onClick={() => void createFirstDoc()}>+ New document</button>
        <button class="btn" data-first-deliverable="deck" onClick={() => void createDeliverable('deck')}>+ New slides</button>
        <button class="btn" data-first-deliverable="poster" onClick={() => void createDeliverable('poster')}>+ New poster</button>
      </div>
    </div>
  );
}
