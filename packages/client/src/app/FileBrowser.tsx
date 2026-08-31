/**
 * File browser: one project at a time (a switcher at the top lists everything the user can open —
 * own projects, shared ones, and for administrators all others). Documents and text files open in
 * tabs; images and PDFs open in a browser tab. LaTeX build products and LyX backups are hidden
 * unless "all files" is on.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, fileUrl, isAuxFile, isTextFile, type Project, type ProjectFile } from '../api';
import { showContextMenu, type MenuItem } from '../editor/contextmenu';

interface TreeNode { name: string; path: string; children: TreeNode[]; file?: ProjectFile }

function buildTree(files: ProjectFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    const dirs = f.kind === 'dir' ? parts.length : parts.length - 1;   // a directory entry is a folder node itself, so empty folders show too
    let cur = root;
    for (let i = 0; i < dirs; i++) {
      const dirPath = parts.slice(0, i + 1).join('/');
      let next = cur.children.find(c => !c.file && c.path === dirPath);
      if (!next) { next = { name: parts[i], path: dirPath, children: [] }; cur.children.push(next); }
      cur = next;
    }
    if (f.kind !== 'dir') cur.children.push({ name: parts[parts.length - 1], path: f.path, children: [], file: f });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

const ICON: Record<string, string> = { doc: '📄', lyx: '📥', bib: '📚', image: '🖼', tex: '𝓣', pdf: '📕', other: '·' };
/** the explorer's cut/copy clipboard (paths within one project; survives re-renders) */
let fileClip: { project: string; path: string; cut: boolean } | null = null;
const isBackup = (name: string) => name.endsWith('~') || name.startsWith('#') || name.endsWith('.emergency');
export const projectLabel = (p: Project) => p.title ?? p.name;

export function FileBrowser({ current, onOpen, onShare, onGit, refreshKey, project: controlled, onProjectCreated }: {
  current: string | null; onOpen: (id: string) => void; onShare?: (project: string) => void; onGit?: (project: string) => void; refreshKey: number;
  /** the project to show, chosen outside (the documents panel): no picker of its own */
  project?: string | null;
  onProjectCreated?: (name: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('ol.tree') || '{}'); } catch { return {}; } });
  const [showAll, setShowAll] = useState(false);
  const [picked, setPicked] = useState<string | null>(() => localStorage.getItem('ol.project'));
  const load = () => api.projects().then(r => setProjects(r.projects)).catch(() => {});
  useEffect(() => { load(); }, [refreshKey]);
  // documents with a local copy (IndexedDB) can be opened offline
  const [offlineDocs, setOfflineDocs] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const scan = () => (indexedDB as any).databases?.().then((dbs: { name?: string }[]) => {
      if (alive) setOfflineDocs(new Set(dbs.map(d => d.name ?? '').filter(n => n.startsWith('overlyx:')).map(n => n.slice('overlyx:'.length))));
    }).catch(() => {});
    const t = setTimeout(scan, 1500);   // after the current document has been stored
    return () => { alive = false; clearTimeout(t); };
  }, [current, refreshKey]);
  useEffect(() => { localStorage.setItem('ol.tree', JSON.stringify(collapsed)); }, [collapsed]);

  // the project shown: the current document's, else the last picked one, else the first
  const currentProject = current ? current.split('/')[0] : null;
  useEffect(() => { if (currentProject) setPicked(currentProject); }, [currentProject]);   // a newly opened document brings its project up; the picker can then switch away
  useEffect(() => { if (picked) localStorage.setItem('ol.project', picked); }, [picked]);
  const groups = useMemo(() => {
    const byTitle = (a: Project, b: Project) => Number((b.kind ?? '') === 'example') - Number((a.kind ?? '') === 'example') || projectLabel(a).localeCompare(projectLabel(b));
    return [
      { label: 'Your projects', items: projects.filter(p => (p.via ?? 'owner') === 'owner').sort(byTitle) },
      { label: 'Shared with you', items: projects.filter(p => p.via === 'member' || p.via === 'link').sort(byTitle) },
      { label: 'All other projects (admin)', items: projects.filter(p => p.via === 'admin').sort(byTitle) },
    ].filter(g => g.items.length);
  }, [projects]);
  const selected = useMemo(() => {
    if (controlled !== undefined) return controlled;
    if (picked && projects.some(p => p.name === picked)) return picked;
    if (currentProject && projects.some(p => p.name === currentProject)) return currentProject;
    return groups[0]?.items[0]?.name ?? null;
  }, [currentProject, picked, projects, groups, controlled]);
  const project = projects.find(p => p.name === selected) ?? null;
  const role = project?.role ?? 'owner';
  const via = project?.via ?? 'owner';
  const canEdit = role !== 'view';

  // auto-expand the folders of the current document
  useEffect(() => {
    if (!current) return;
    const parts = current.split('/');
    const open: Record<string, boolean> = {};
    for (let i = 1; i < parts.length - 1; i++) open[parts[0] + ':' + parts.slice(1, i + 1).join('/')] = false;
    setCollapsed(c => ({ ...c, ...open }));
  }, [current]);
  const toggle = (key: string) => setCollapsed(c => ({ ...c, [key]: !c[key] }));

  const newDoc = async (dir = '') => {
    if (!project) return;
    const name = prompt(`New document file name (in ${projectLabel(project)}${dir ? '/' + dir : ''}):`, 'untitled.tex');
    if (!name) return;
    try {
      const r = await api.newDoc(project.name, (dir ? dir + '/' : '') + name, { title: name.replace(/\.(tex|lyx)$/, '') });
      await load();
      onOpen(r.id);
    } catch (e) { alert(String((e as Error).message)); }
  };
  const newTextFile = async (dir = '') => {
    if (!project) return;
    const name = prompt(`New text file (in ${projectLabel(project)}${dir ? '/' + dir : ''}), e.g. macros.tex or refs.bib:`, 'notes.tex');
    if (!name) return;
    const rel = (dir ? dir + '/' : '') + name;
    try {
      if (project.files.some(f => f.path === rel)) throw new Error('file exists');
      await api.writeText(project.name, rel, '');
      await load();
      onOpen(project.name + '/' + rel);
    } catch (e) { alert(String((e as Error).message)); }
  };
  const newProject = async () => {
    const name = prompt('New project name:');
    if (!name) return;
    try { const r = await api.createProject(name.trim()); await load(); setPicked(r.project.name); onProjectCreated?.(r.project.name); } catch (e) { alert(String((e as Error).message)); }
  };
  const upload = async (dir = '') => {
    if (!project) return;
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true;
    input.onchange = async () => {
      for (const f of Array.from(input.files ?? [])) {
        try { await api.upload(project.name, (dir ? dir + '/' : '') + f.name, f); } catch (e) { alert(String((e as Error).message)); }
      }
      load();
    };
    input.click();
  };

  const visible = (f: ProjectFile) => f.kind === 'dir' || showAll || (!isBackup(f.name) && !isAuxFile(f.name) && !f.name.endsWith('.overlyx-tmp'));
  const tree = useMemo(() => (project ? buildTree(project.files.filter(visible)) : []), [project, showAll]);

  /* ---- the VS Code-like context menu (right click on a file, a folder, or the background) */
  const doOp = async (body: { op: 'rename' | 'delete' | 'mkdir' | 'copy'; from?: string; to?: string }) => {
    if (!project) return;
    try { await api.fileOp(project.name, body); await load(); } catch (e) { alert(String((e as Error).message)); }
  };
  /** a free name in `dir` for paste / duplicate: name.ext, name copy.ext, name copy 2.ext … */
  const freeName = (dir: string, base: string) => {
    const exists = (rel: string) => project!.files.some(f => f.path === rel);
    let rel = (dir ? dir + '/' : '') + base;
    if (!exists(rel)) return rel;
    const dot = base.startsWith('.') ? -1 : base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : '';
    for (let k = 1; ; k++) { rel = (dir ? dir + '/' : '') + `${stem} copy${k > 1 ? ' ' + k : ''}${ext}`; if (!exists(rel)) return rel; }
  };
  const renamePath = async (p: string) => {
    const nn = prompt('New name (a path moves the file):', p);
    if (nn && nn !== p) await doOp({ op: 'rename', from: p, to: nn });
  };
  const deletePath = async (p: string, isDir: boolean) => {
    if (!confirm(`Delete ${p}${isDir ? ' and everything in it' : ''}? (It is moved to the server's trash, not erased.)`)) return;
    await doOp({ op: 'delete', from: p });
  };
  const newFolder = async (dir = '') => {
    const n = prompt(`New folder${dir ? ' in ' + dir : ''}:`, 'figures');
    if (n) await doOp({ op: 'mkdir', to: (dir ? dir + '/' : '') + n.trim() });
  };
  const pasteInto = async (dir: string) => {
    if (!fileClip || !project) return;
    if (fileClip.project !== project.name) { alert('Cut / copy and paste work within one project.'); return; }
    await doOp({ op: fileClip.cut ? 'rename' : 'copy', from: fileClip.path, to: freeName(dir, fileClip.path.split('/').pop()!) });
    if (fileClip.cut) fileClip = null;
  };
  const copyText = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => {}); };
  const download = (p: string) => { const a = document.createElement('a'); a.href = fileUrl(project!.name, p) + '?download=1'; a.click(); };
  const ctxCommon = (p: string, isDir: boolean): MenuItem[] => [
    { sep: true },
    ...(canEdit ? [
      { label: 'Cut', action: () => { fileClip = { project: project!.name, path: p, cut: true }; } },
      { label: 'Copy', action: () => { fileClip = { project: project!.name, path: p, cut: false }; } },
      ...(isDir ? [{ label: 'Paste', disabled: !fileClip, action: () => void pasteInto(p) }] : []),
      { sep: true },
    ] : [{ sep: true }]),
    { label: 'Copy Path', action: () => copyText(`${project!.name}/${p}`) },
    { label: 'Copy Relative Path', action: () => copyText(p) },
    ...(canEdit ? [
      { sep: true },
      { label: 'Rename…', action: () => void renamePath(p) },
      ...(!isDir ? [{ label: 'Duplicate', action: () => void doOp({ op: 'copy', from: p, to: freeName(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', p.split('/').pop()!) }) }] : []),
      { label: 'Delete', action: () => void deletePath(p, isDir) },
    ] : []),
  ];
  const newItems = (dir = ''): MenuItem[] => canEdit ? [
    { label: 'New Document…', action: () => void newDoc(dir) },
    { label: 'New File…', action: () => void newTextFile(dir) },
    { label: 'New Folder…', action: () => void newFolder(dir) },
    { label: 'Upload…', action: () => void upload(dir) },
  ] : [];
  const fileCtx = (f: ProjectFile, openIt: () => void) => (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Open', action: openIt },
      { label: 'Download', action: () => download(f.path) },
      ...ctxCommon(f.path, false),
    ]);
  };
  const folderCtx = (p: string) => (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [...newItems(p), ...ctxCommon(p, true)]);
  };
  const bgCtx = (e: MouseEvent) => {
    if (!project) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      ...newItems(''),
      ...(canEdit ? [{ label: 'Paste', disabled: !fileClip, action: () => void pasteInto('') }] : []),
      { sep: true },
      { label: showAll ? 'Hide Build Files' : 'Show All Files', action: () => setShowAll(!showAll) },
      { label: 'Refresh', action: () => void load() },
    ]);
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const key = project!.name + ':' + node.path;
    if (!node.file) {
      const isCollapsed = collapsed[key] ?? (depth > 0);
      return (
        <div key={key}>
          <div class="tree-row folder" style={{ paddingLeft: 6 + depth * 14 + 'px' }} onClick={() => toggle(key)} onContextMenu={folderCtx(node.path)}>
            <span class="twisty">{isCollapsed ? '▸' : '▾'}</span><span class="fname">{node.name}</span>
            {canEdit && <span class="row-actions">
              <button class="mini" title="New document here" onClick={e => { e.stopPropagation(); void newDoc(node.path); }}>+</button>
              <button class="mini" title="Upload files here" onClick={e => { e.stopPropagation(); void upload(node.path); }}>⇧</button>
            </span>}
          </div>
          {!isCollapsed && node.children.map(c => renderNode(c, depth + 1))}
        </div>
      );
    }
    const f = node.file;
    const id = `${project!.name}/${f.path}`;
    const isDoc = f.kind === 'doc';
    const isLyx = f.kind === 'lyx';
    const isPdf = f.kind === 'pdf';
    const inTab = isDoc || isLyx || isPdf || isTextFile(f.name);
    const tabId = isDoc ? id : isPdf ? 'pdf:' + id : 'text:' + id;
    const href = isLyx ? '#' : inTab ? '#/' + tabId : fileUrl(project!.name, f.path);
    const importLyx = async () => {
      if (!confirm(`Import ${f.name} into a .tex document (${f.name.replace(/\.lyx$/, '.tex')})? The .lyx file is kept; child documents it includes are imported too.`)) return;
      try { const r = await api.importLyx(project!.name, f.path); await load(); onOpen(r.id); if (r.warnings.length) alert('Imported with warnings:\n' + r.warnings.slice(0, 10).join('\n')); }
      catch (e) { alert('Import failed: ' + (e as Error).message); }
    };
    return (
      <a key={key} class={'tree-row file' + (id === current ? ' current' : '') + (!isDoc ? ' other' : '')} style={{ paddingLeft: 6 + depth * 14 + 'px' }}
        href={href} target={inTab ? undefined : '_blank'} title={`${f.path} · ${(f.size / 1024).toFixed(0)} KB${isLyx ? ' · click to import as .tex' : inTab && isPdf ? ' · opens in the PDF viewer' : inTab && !isDoc ? ' · opens in the text editor' : ''}`}
        data-file={f.path}
        onContextMenu={fileCtx(f, () => { if (isLyx) void importLyx(); else if (inTab) onOpen(tabId); else window.open(href, '_blank'); })}
        onClick={e => { if (isLyx) { e.preventDefault(); void importLyx(); return; } if (inTab && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); onOpen(tabId); } }}>
        <span class="ficon">{ICON[f.kind] ?? '·'}</span><span class="fname">{node.name}</span>
        {isDoc && offlineDocs.has(id) && <span class="offline-mark" title="A copy of this document is stored in this browser: it can be opened and edited offline">⬇</span>}
      </a>
    );
  };

  return (
    <div class="filetree" data-project={project?.name ?? ''} onContextMenu={bgCtx}>
      {controlled === undefined && <div class="project-picker">
        <select value={selected ?? ''} onChange={e => setPicked((e.target as HTMLSelectElement).value)} title="Switch project" aria-label="Project">
          {!projects.length && <option value="">(no projects)</option>}
          {groups.map(g => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map(p => <option key={p.name} value={p.name}>{projectLabel(p)}{p.via === 'admin' && p.owner ? ` — ${p.owner.username}` : p.via === 'member' || p.via === 'link' ? ` — ${p.owner?.name ?? 'shared'}${p.role === 'view' ? ' (view)' : ''}` : ''}</option>)}
            </optgroup>
          ))}
        </select>
        {project && via !== 'owner' && <span class={'badge' + (role === 'view' ? ' view' : '')} title={role === 'view' ? 'Shared with you for viewing' : 'Shared with you for editing'}>{via === 'admin' ? 'admin' : role === 'view' ? 'view' : 'edit'}</span>}
      </div>}
      {project && <div class="project-info" title={project.name}>
        {via === 'owner' ? 'Your project' : via === 'admin' ? `Owned by ${project.owner?.name ?? '—'}` : `Shared by ${project.owner?.name ?? '—'} · ${role === 'view' ? 'view only' : 'you can edit'}`} · {project.name}
      </div>}
      <div class="actions">
        <button class="small-btn" onClick={() => void newProject()} title="Create a new project">+ Project</button>
        {canEdit && project && <button class="small-btn" onClick={() => void newDoc()} title="New LyX document in this project">+ Doc</button>}
        {canEdit && project && <button class="small-btn" onClick={() => void newTextFile()} title="New text file (.tex, .bib, …) in this project">+ File</button>}
        {canEdit && project && <button class="small-btn" onClick={() => void upload()} title="Upload files (figures, .bib, .sty …)">⇧</button>}
        {role === 'owner' && via !== 'admin' && project && onShare && <button class="small-btn" data-share={project.name} onClick={() => onShare(project.name)} title="Share this project…">👥</button>}
        {project && onGit && <button class="small-btn" data-git={project.name} onClick={() => onGit(project.name)} title="Git repository: clone, pull and push this project from your computer…">⎇</button>}
        <button class="small-btn" onClick={() => setShowAll(!showAll)} title="Show LaTeX build files (.aux, .log, .bbl …) and LyX backups (~, #, .emergency)">{showAll ? 'Fewer' : 'All files'}</button>
        <button class="small-btn" onClick={load} title="Refresh">↻</button>
      </div>
      {project && tree.map(n => renderNode(n, 0))}
      {project && !tree.length && <div class="empty">No files yet — add a document with + Doc, or upload files.</div>}
      {!projects.length && <div class="empty">No projects yet.</div>}
    </div>
  );
}
