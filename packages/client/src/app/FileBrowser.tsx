/**
 * File browser: one project at a time (a switcher at the top lists everything the user can open —
 * own projects, shared ones, and for administrators all others). Every file is just a file: + File
 * makes any of them, the name's ending deciding what it becomes (app/newfile.ts); documents, text
 * files, PDFs and whiteboards open in place, images in a browser tab. LaTeX build products and LyX
 * backups are hidden unless "all files" is on. What is not a document — pictures, .bib, .sty, scripts,
 * data, PDFs, and folders holding no document — waits in a folded "other files" row under a folder's
 * documents (open it with a click; it opens by itself for the file being shown or one just added). Under the files panel a document row expands into its
 * outline. A document group (a folder with core/docgroup.ts's manifest — the tabs of an imported
 * Google Doc) shows as one entry: its title, then its documents in the group's order under the titles
 * the group gives them (nested ones indented), the folder's other files after them.
 * *Import from Google Docs…* (where Google's picker is set up) brings a Google Doc in: a document, or
 * a group of its tabs (server gdocs/importing.ts).
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { api, fileTabId, fileUrl, isAuxFile, isTextFile, type Project, type ProjectFile } from '../api';
import { subscribeProjectEvents } from '../projectevents';
import { showContextMenu, type MenuItem } from '../editor/contextmenu';
import { chooseLyxImport } from './lyximport';
import { projectOfDoc, splitDocId, projectShortName, type DocGroup, type DocGroupMember } from '@overlyx/core';
import { uiPrompt, uiConfirm, uiAlert } from './Dialogs';
import { promptNewFile } from './newfile';
import { NewLayoutDialog } from './NewLayoutDialog';
import { useUiMode } from './uimode';
import { KIND_ICONS, iconSvg } from './modernicons';
import { chooseGoogleImport } from './gpicker';
import { editSvgFile } from '../editor/svgEditorEvents';

/**
 * Subscribe to the server's change stream for one project (SSE): `onChange` fires whenever files
 * appear or disappear in the project's directory on disk, whoever the writer was — another user,
 * the agent, a git push, a LaTeX build. The file list refreshes itself; there is no refresh button.
 */
export function useProjectEvents(project: string | null | undefined, onChange: () => void): void {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!project) return;
    return subscribeProjectEvents(project, ev => { if (ev.kind === 'files') cb.current(); });
  }, [project]);
}

interface TreeNode { name: string; path: string; children: TreeNode[]; file?: ProjectFile; group?: DocGroup; /** a document, or a folder holding one (or nothing yet) */ docs?: boolean }

/** what the tree shows first: documents (LaTeX, LyX, markdown, whiteboards, slides / posters / pages) */
const isDocFile = (f: ProjectFile) => f.kind === 'doc' || f.kind === 'lyx' || f.kind === 'board' || (f.kind === 'html' && !!f.deliverable) || /\.(md|markdown)$/i.test(f.name);

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
    else if (f.group) cur.group = f.group;
  }
  const sort = (n: TreeNode) => {
    // a group: its documents in the group's order first
    const at = new Map((n.group?.members ?? []).map((m, i) => [m.file, i]));
    const rank = (c: TreeNode) => (c.file ? at.get(c.name) ?? Infinity : Infinity);
    n.children.sort((a, b) => (rank(a) - rank(b) || 0) || Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    n.children.forEach(sort);
  };
  sort(root);
  const mark = (n: TreeNode): boolean => {
    const inside = n.children.map(mark).some(Boolean);
    n.docs = n.file ? isDocFile(n.file) : inside || !!n.group || !n.children.length;
    return n.docs;
  };
  root.children.forEach(mark);
  return root.children;
}

const ICON: Record<string, string> = { doc: '📄', lyx: '📥', bib: '📚', image: '🖼', tex: '𝓣', pdf: '📕', board: '🖍', html: '🌐', other: '·' };
/** an HTML deliverable: slides, a poster, a web page */
const DELIVERABLE_ICON = { deck: '🎞', poster: '🪧', page: '🌐' } as const;
/**
 * Documents deleted here, in the explorer: when the open one is among them its tab goes to another
 * document of its folder quietly (App's onGone), not to the start screen with an error.
 */
export const deletedHere = new Set<string>();

/**
 * Where to go when the document `goneId` is gone: the next document of its folder (its group's order,
 * else the folder's), else the one before, else the project's main document — null: none is left.
 */
export function siblingDocument(project: Project, goneId: string): string | null {
  const rel = goneId.slice(project.name.length + 1);
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const docs = project.files.filter(f => f.kind !== 'dir' && f.path !== rel && isDocFile(f) && !isBackup(f.name));
  const here = docs.filter(f => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '') === dir);
  const order = project.files.find(f => f.kind === 'dir' && f.path === dir)?.group?.members.map(m => m.file) ?? [];
  const rank = (f: ProjectFile) => { const i = order.indexOf(f.name); return i < 0 ? order.length : i; };
  here.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const name = rel.split('/').pop()!;
  const gone = order.indexOf(name);
  const next = gone >= 0 ? here.find(f => rank(f) > gone) ?? [...here].reverse().find(f => rank(f) < gone) : here[0];
  const pick = next ?? here[0] ?? docs.find(f => /(^|\/)main\.tex$/.test(f.path)) ?? docs.find(f => f.kind === 'doc') ?? docs[0];
  return pick ? fileTabId(project.name, pick) : null;
}

/** the explorer's cut/copy clipboard (paths within one project; survives re-renders) */
let fileClip: { project: string; path: string; cut: boolean } | null = null;
const isBackup = (name: string) => name.endsWith('~') || name.startsWith('#') || name.endsWith('.emergency');
/** a project's title, else its name without the owner (`jan/thesis` → `thesis`) */
export const projectLabel = (p: Project) => p.title ?? projectShortName(p.name);

/** A document row's outline (the documents panel): whether it is expanded, the twisty, and what to show under the row. */
export interface DocOutlines { open: (id: string) => boolean; toggle: (id: string) => void; render: (id: string) => ComponentChildren }

export function FileBrowser({ current, onOpen, onShare, refreshKey, project: controlled, outlines }: {
  current: string | null; onOpen: (id: string) => void; onShare?: (project: string) => void; refreshKey: number;
  /** the project to show, chosen outside (the documents panel): no picker of its own */
  project?: string | null;
  /** documents expand into their outline in place */
  outlines?: DocOutlines;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const modern = useUiMode() === 'modern';
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
  const currentProject = current ? projectOfDoc(current) || null : null;
  useEffect(() => { if (currentProject) setPicked(currentProject); }, [currentProject]);   // a newly opened document brings its project up; the picker can then switch away
  useEffect(() => { if (picked) localStorage.setItem('ol.project', picked); }, [picked]);
  const groups = useMemo(() => {
    const byTitle = (a: Project, b: Project) => Number((b.kind ?? '') === 'example') - Number((a.kind ?? '') === 'example') || projectLabel(a).localeCompare(projectLabel(b));
    return [
      { label: 'Your projects', items: projects.filter(p => (p.via ?? 'owner') === 'owner').sort(byTitle) },
      { label: 'Shared with you', items: projects.filter(p => p.via === 'member' || p.via === 'link' || p.via === 'public').sort(byTitle) },
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
  // standalone the browser refreshes itself; under the documents panel the panel subscribes (it
  // needs the same listing for the documents' outlines) and bumps refreshKey for both
  useProjectEvents(controlled === undefined ? selected : null, load);

  // auto-expand the folders of the current document
  useEffect(() => {
    if (!current) return;
    const { project: p, path: rel } = splitDocId(current);
    const parts = rel.split('/');
    const open: Record<string, boolean> = {};
    for (let i = 1; i < parts.length; i++) open[p + ':' + parts.slice(0, i).join('/')] = false;
    setCollapsed(c => ({ ...c, ...open }));
  }, [current]);
  // … and bring its row to the top of the panel when it is out of view or low down (the outline opens under it)
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!current) return;
    let t = 0, tries = 0;
    const place = () => {
      const row = treeRef.current?.querySelector<HTMLElement>('.tree-row.current');
      let box = row?.parentElement ?? null;
      while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      if (!row || !box) return;
      const r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
      if (r.top >= b.top && r.top <= b.top + b.height / 2) return;
      box.scrollTop += r.top - b.top - 8;
      // stopped by the end of the list: the outline under the row is still coming — try again while nobody scrolled
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1 && ++tries < 6) t = window.setTimeout(place, 200);
    };
    t = window.setTimeout(place, 50);
    return () => clearTimeout(t);
  }, [current, project?.name]);
  /** open / close a folder; one that was never toggled shows its default (`closedByDefault`) — flip that, not `undefined` */
  const toggle = (key: string, closedByDefault: boolean) => setCollapsed(c => ({ ...c, [key]: !(c[key] ?? closedByDefault) }));
  /** open the folders above a path (VS Code reveals what was just created, moved or uploaded) */
  const reveal = (rel: string) => {
    if (!project) return;
    const parts = rel.split('/');
    const open: Record<string, boolean> = {};
    for (let i = 0; i < parts.length; i++) {
      if (i) open[project.name + ':' + parts.slice(0, i).join('/')] = false;
      open[otherKey(parts.slice(0, i).join('/'))] = false;   // what was added may be no document: its folder's other files open
    }
    setCollapsed(c => ({ ...c, ...open }));
  };
  /** the folded row of a folder's other files (not documents) */
  const otherKey = (dir: string) => project!.name + ':' + dir + ':#other';

  /** a new file of any kind — a document, a whiteboard, a .bib … (app/newfile.ts: the name's ending decides); a taken name asks again, never replaces */
  const newFile = async (dir = '') => {
    if (!project) return;
    const id = await promptNewFile(project.name, { dir, where: projectLabel(project) + (dir ? '/' + dir : '') });
    if (!id) return;
    if (dir) reveal(dir + '/');
    await load();
    onOpen(id);
  };
  // Google's picker is set up on this server (the import is offered then)
  const [gdocs, setGdocs] = useState(false);
  useEffect(() => { api.gdocsAccount().then(s => setGdocs(s.picker)).catch(() => setGdocs(false)); }, []);
  /** a Google Doc picked in Google's picker into `dir`: a document, or a group of its tabs — opened */
  const importGoogle = async (dir = '') => {
    if (!project) return;
    try {
      const choice = await chooseGoogleImport();
      if (!choice) return;
      const r = await api.gdocsImport(project.name, choice.fileId, dir, choice.sync);
      reveal((r.group ?? dir) + '/');
      await load();
      onOpen(r.id);
    } catch (e) { await uiAlert('Import Failed', (e as Error).message); }
  };
  const upload = async (dir = '') => {
    if (!project) return;
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true;
    input.onchange = async () => {
      for (const f of Array.from(input.files ?? [])) {
        try { await api.upload(project.name, (dir ? dir + '/' : '') + f.name, f); } catch (e) { await uiAlert('Upload Failed', String((e as Error).message)); }
      }
      reveal(dir ? dir + '/' : '');
      load();
    };
    input.click();
  };

  /* ---- drag files (or whole folders) in from the computer; a folder row is a drop target */
  const [dropDir, setDropDir] = useState<string | null>(null);
  const wantsFiles = (e: DragEvent) => canEdit && !!project && Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const dragOver = (dir: string) => (e: DragEvent) => {
    if (!wantsFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setDropDir(dir);
  };
  const uploadDropped = async (dt: DataTransfer, dir: string) => {
    if (!project) return;
    const prefix = dir ? dir + '/' : '';
    // webkitGetAsEntry (all browsers) also walks dropped directories; plain files are the fallback — also
    // for a file whose entry cannot be read: WebKit hands out an entry for a file that is not on disk (one
    // made in a page) whose file() fails with NotFoundError, and nothing was uploaded
    const dropped = Array.from(dt.items ?? []).filter(i => i.kind === 'file').map(i => ({ entry: (i as any).webkitGetAsEntry?.(), file: i.getAsFile() }));
    const files: { rel: string; file: File }[] = [];
    const emptyDirs: string[] = [];
    const walk = (entry: any, at: string, fallback: File | null = null): Promise<void> => new Promise(resolve => {
      if (entry.isFile) entry.file((f: File) => { files.push({ rel: at + entry.name, file: f }); resolve(); }, () => { if (fallback) files.push({ rel: at + fallback.name, file: fallback }); resolve(); });
      else if (entry.isDirectory) {
        const sub = at + entry.name + '/';
        const reader = entry.createReader();
        const acc: any[] = [];
        const read = () => reader.readEntries((es: any[]) => {   // readEntries hands out ≤100 at a time
          if (es.length) { acc.push(...es); read(); }
          else {
            if (!acc.length) emptyDirs.push(sub.slice(0, -1));
            void Promise.all(acc.map(c => walk(c, sub))).then(() => resolve());
          }
        }, () => resolve());
        read();
      } else resolve();
    });
    if (dropped.length) {
      await Promise.all(dropped.map(d => {
        if (d.entry) return walk(d.entry, prefix, d.file);
        if (d.file) files.push({ rel: prefix + d.file.name, file: d.file });
        return undefined;
      }));
    }
    else for (const f of Array.from(dt.files ?? [])) files.push({ rel: prefix + f.name, file: f });
    if (!files.length && !emptyDirs.length) return;
    const clashes = files.filter(x => project.files.some(f => f.path === x.rel));
    const keep = clashes.length && !(await uiConfirm('Replace Existing Files', `${clashes.length === 1 ? clashes[0].rel + ' already exists' : clashes.length + ' of these files already exist'} — replace?`, { okLabel: 'Replace' }))
      ? files.filter(x => !clashes.includes(x)) : files;
    const errors: string[] = [];
    for (const d of emptyDirs) { try { await api.fileOp(project.name, { op: 'mkdir', to: d }); } catch (e) { errors.push(`${d}: ${(e as Error).message}`); } }
    for (const { rel, file } of keep) { try { await api.upload(project.name, rel, file); } catch (e) { errors.push(`${rel}: ${(e as Error).message}`); } }
    reveal(dir ? dir + '/' : '');
    await load();
    if (errors.length) await uiAlert('Upload Failed', 'Not everything could be uploaded:\n' + errors.slice(0, 10).join('\n'));
  };
  const drop = (dir: string) => (e: DragEvent) => {
    if (!wantsFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    setDropDir(null);
    void uploadDropped(e.dataTransfer!, dir);
  };

  const visible = (f: ProjectFile) => f.kind === 'dir' || showAll || (!isBackup(f.name) && !isAuxFile(f.name) && !f.name.endsWith('.overlyx-tmp'));
  const tree = useMemo(() => (project ? buildTree(project.files.filter(visible)) : []), [project, showAll]);

  /* ---- the VS Code-like context menu (right click on a file, a folder, or the background) */
  const doOp = async (body: { op: 'rename' | 'delete' | 'mkdir' | 'copy'; from?: string; to?: string }) => {
    if (!project) return;
    try { await api.fileOp(project.name, body); if (body.to) reveal(body.to); await load(); } catch (e) { await uiAlert('Could Not Complete', String((e as Error).message)); }
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
    const nn = (await uiPrompt('Rename', 'New name — a path with / moves it (/name: to the top of the project):', p))?.trim();
    // a bare name stays in the file's folder, as in every file manager: "results-final.tex" for
    // chapters/results.tex moved it to the top and broke \input{chapters/…}
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
    const to = !nn ? '' : nn.startsWith('/') ? nn.replace(/^\/+/, '') : nn.includes('/') ? nn : dir + nn;
    if (to && to !== p) await doOp({ op: 'rename', from: p, to });
  };
  const deletePath = async (p: string, isDir: boolean) => {
    if (!(await uiConfirm('Delete', `Delete ${p}${isDir ? ' and everything in it' : ''}? It waits 30 days in the server's trash — ask the people who run OverLyX (Help ▸ Report a problem) to bring it back.`, { danger: true, okLabel: 'Delete' }))) return;
    const id = `${project!.name}/${p}`;
    const shown = current?.replace(/^[a-z]+:/, '');
    if (shown && (shown === id || shown.startsWith(id + '/'))) deletedHere.add(shown);
    await doOp({ op: 'delete', from: p });
  };
  /** + Slides: a deck, poster, web page or article — a folder with an index.html — in `dir` (NewLayoutDialog) */
  const [newLayoutIn, setNewLayoutIn] = useState<string | null>(null);
  const newFolder = async (dir = '') => {
    const n = await uiPrompt('New Folder', `New folder${dir ? ' in ' + dir : ''}:`, 'figures');
    if (n) await doOp({ op: 'mkdir', to: (dir ? dir + '/' : '') + n.trim() });
  };
  const pasteInto = async (dir: string) => {
    if (!fileClip || !project) return;
    if (fileClip.project !== project.name) { await uiAlert('Cannot Paste', 'Cut / copy and paste work within one project.'); return; }
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
    { label: 'New File…', action: () => void newFile(dir) },
    { label: 'New Slides / Poster / Page…', action: () => setNewLayoutIn(dir) },
    { label: 'New Folder…', action: () => void newFolder(dir) },
    { label: 'Upload…', action: () => void upload(dir) },
    { label: 'Import from LyX…', action: () => chooseLyxImport(project!.name, dir, r => { reveal(r.created[0] ?? ''); void load(); onOpen(r.id); }) },
    ...(gdocs ? [{ label: 'Import from Google Docs…', action: () => void importGoogle(dir) }] : []),
  ] : [];
  const fileCtx = (f: ProjectFile, openIt: () => void) => (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Open', action: openIt },
      { label: 'Download', action: () => download(f.path) },
      ...(f.kind === 'doc' ? [{ label: 'Download LyX (.lyx)', action: () => window.open(`/api/docs/${encodeURIComponent(project!.name + '/' + f.path)}/lyx`) }] : []),
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
    ]);
  };

  /** the file being shown, as a project path (its tab id without the viewer's prefix) */
  const shownPath = current ? current.replace(/^[a-z]+:/, '') : null;
  /**
   * A folder's entries: its documents (and the folders holding some), then one folded row for the rest
   * — unless the folder holds no document at all, then everything as it is.
   */
  const renderChildren = (dir: string, children: TreeNode[], depth: number): ComponentChildren => {
    const docs = children.filter(c => c.docs), other = children.filter(c => !c.docs);
    if (!docs.length || !other.length) return children.map(c => renderNode(c, depth));
    const key = otherKey(dir);
    const holdsShown = !!shownPath && other.some(c => shownPath === project!.name + '/' + c.path || shownPath.startsWith(project!.name + '/' + c.path + '/'));
    const closed = (collapsed[key] ?? true) && !holdsShown;
    const folders = other.filter(c => !c.file).length, files = other.length - folders;
    const what = [files && `${files} file${files === 1 ? '' : 's'}`, folders && `${folders} folder${folders === 1 ? '' : 's'}`].filter(Boolean).join(', ');
    return [
      ...docs.map(c => renderNode(c, depth)),
      <div key={key} class={'tree-row other-files' + (closed ? '' : ' open')} data-other-files={dir} style={{ paddingLeft: 6 + depth * 14 + 'px' }}
        role="button" aria-expanded={!closed} onClick={() => toggle(key, true)} onContextMenu={dir ? folderCtx(dir) : bgCtx}
        title={`Not documents: pictures, bibliographies, styles, scripts, data, PDFs — ${what}. ${closed ? 'Click to show them' : 'Click to fold them away'}${holdsShown ? ' (open: the file shown is one of them)' : ''}`}>
        <span class="twisty">{closed ? '▸' : '▾'}</span><span class="fname">Other files</span><span class="group-count">{other.length}</span>
      </div>,
      ...(closed ? [] : other.map(c => renderNode(c, depth))),
    ];
  };

  const renderNode = (node: TreeNode, depth: number, member?: DocGroupMember) => {
    const key = project!.name + ':' + node.path;
    if (!node.file && node.group) {
      // a document group: one entry, its documents (the group's order, titles and nesting) under it
      const closedByDefault = depth > 0 || !!outlines;
      const isCollapsed = collapsed[key] ?? closedByDefault;
      const byFile = new Map(node.group.members.map(m => [m.file, m]));
      const n = node.children.filter(c => c.file && byFile.has(c.name)).length;
      return (
        <div key={key} class={'doc-group' + (isCollapsed ? '' : ' open')} data-group={node.path}>
          <div class={'tree-row folder group-row' + (dropDir === node.path ? ' drop-target' : '')} style={{ paddingLeft: 6 + depth * 14 + 'px' }} onClick={() => toggle(key, closedByDefault)} onContextMenu={folderCtx(node.path)}
            onDragOver={dragOver(node.path)} onDrop={drop(node.path)} title={`${node.path} · a document group: ${n} document${n === 1 ? '' : 's'}`}>
            <span class="twisty">{isCollapsed ? '▸' : '▾'}</span>
            {modern
              ? <span class="ficon icon" data-kind="group" dangerouslySetInnerHTML={{ __html: iconSvg(KIND_ICONS.group, 15) }} />
              : <span class="ficon" data-kind="group">🗂</span>}
            <span class="fname">{node.group.title ?? node.name}</span><span class="group-count">{n}</span>
          </div>
          {!isCollapsed && node.children.map(c => renderNode(c, depth + 1, c.file ? byFile.get(c.name) : undefined))}
        </div>
      );
    }
    if (!node.file) {
      const closedByDefault = depth > 0 || !!outlines;   // under the documents panel folders start closed: the open document stays near the top
      const isCollapsed = collapsed[key] ?? closedByDefault;
      return (
        <div key={key}>
          <div class={'tree-row folder' + (dropDir === node.path ? ' drop-target' : '')} style={{ paddingLeft: 6 + depth * 14 + 'px' }} onClick={() => toggle(key, closedByDefault)} onContextMenu={folderCtx(node.path)}
            onDragOver={dragOver(node.path)} onDrop={drop(node.path)}>
            <span class="twisty">{isCollapsed ? '▸' : '▾'}</span><span class="fname">{node.name}</span>
            {canEdit && <span class="row-actions">
              <button class="mini" title="New file here (a document, a whiteboard, a .bib …)" onClick={e => { e.stopPropagation(); void newFile(node.path); }}>+</button>
              <button class="mini" title="Upload files here" onClick={e => { e.stopPropagation(); void upload(node.path); }}>⇧</button>
            </span>}
          </div>
          {!isCollapsed && renderChildren(node.path, node.children, depth + 1)}
        </div>
      );
    }
    const f = node.file;
    const id = `${project!.name}/${f.path}`;
    const isDoc = f.kind === 'doc';
    const isLyx = f.kind === 'lyx';
    const isPdf = f.kind === 'pdf';
    const isBoard = f.kind === 'board';
    const isHtml = f.kind === 'html';
    const kind = isHtml && f.deliverable ? f.deliverable : f.name.toLowerCase().endsWith('.md') ? 'md' : f.kind;
    const inTab = isDoc || isLyx || isPdf || isBoard || isHtml || isTextFile(f.name);
    const tabId = fileTabId(project!.name, f) ?? 'text:' + id;
    const href = isLyx ? '#' : inTab ? '#/' + tabId : fileUrl(project!.name, f.path);
    // an SVG drawing opens in the drawing editor over the page (as a figure's double-click does); Ctrl+click: the file in a browser tab
    const isSvg = /\.svg$/i.test(f.name);
    const editSvg = () => editSvgFile(project!.name, f.path, !canEdit);
    const importLyx = async () => {
      if (!(await uiConfirm('Import LyX File', `Import ${f.name} into a .tex document (${f.name.replace(/\.lyx$/, '.tex')})? The .lyx file is kept; child documents it includes are imported too.`, { okLabel: 'Import' }))) return;
      try { const r = await api.importLyx(project!.name, f.path); await load(); onOpen(r.id); if (r.warnings.length) await uiAlert('Imported with Warnings', r.warnings.slice(0, 10).join('\n')); }
      catch (e) { await uiAlert('Import Failed', (e as Error).message); }
    };
    const outlined = isDoc && !!outlines;
    const open = outlined && outlines!.open(id);
    const row = (
      <a key={key} class={'tree-row file' + (id === current ? ' current' : '') + (outlined ? ' doc-name' : '') + (member ? ' group-member' : '')} style={{ paddingLeft: 6 + (depth + (member?.level ?? 0)) * 14 + 'px' }}
        href={href} target={inTab ? undefined : '_blank'} title={`${f.path} · ${(f.size / 1024).toFixed(0)} KB${isLyx ? ' · click to import as .tex' : inTab && isPdf ? ' · opens in the PDF viewer' : isSvg ? ' · opens in the drawing editor (Ctrl+click: in a browser tab)' : inTab && !isDoc ? ' · opens in the text editor' : ''}`}
        data-file={f.path}
        onDragOver={dragOver(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '')}
        onDrop={drop(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '')}
        onContextMenu={fileCtx(f, () => { if (isLyx) void importLyx(); else if (inTab) onOpen(tabId); else if (isSvg) editSvg(); else window.open(href, '_blank'); })}
        onClick={e => { if (isLyx) { e.preventDefault(); void importLyx(); return; } if (isSvg && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); editSvg(); return; } if (inTab && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); onOpen(tabId); } }}>
        {outlines && (outlined
          ? <span class="twisty" role="button" title={open ? 'Hide the outline' : 'Show the outline'} onClick={e => { e.preventDefault(); e.stopPropagation(); outlines.toggle(id); }}>{open ? '▾' : '▸'}</span>
          : <span class="twisty" />)}
        {modern
          ? <span class="ficon icon" data-kind={kind} dangerouslySetInnerHTML={{ __html: iconSvg(KIND_ICONS[kind] ?? KIND_ICONS.other, 15) }} />
          : <span class="ficon" data-kind={kind}>{f.kind === 'html' && f.deliverable ? DELIVERABLE_ICON[f.deliverable] : ICON[f.kind] ?? '·'}</span>}<span class="fname">{member?.title ?? node.name}</span>
        {isDoc && offlineDocs.has(id) && <span class="offline-mark" title="A copy of this document is stored in this browser: it can be opened and edited offline">⬇</span>}
      </a>
    );
    if (!outlined) return row;
    return (
      <div key={key} class={'doc-tab' + (id === current ? ' active' : '') + (open ? ' open' : '')} data-doc={f.path}>
        {row}
        {open && <div class="doc-outline" style={{ paddingLeft: 6 + (depth + (member?.level ?? 0)) * 14 + 17 + 'px' }}>{outlines!.render(id)}</div>}
      </div>
    );
  };

  return (
    <div ref={treeRef} class={'filetree' + (dropDir !== null ? ' dropping' : '')} data-project={project?.name ?? ''} onContextMenu={bgCtx}
      onDragOver={dragOver('')} onDrop={drop('')}
      onDragLeave={e => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropDir(null); }}>
      {controlled === undefined && <div class="project-picker">
        <select value={selected ?? ''} onChange={e => setPicked((e.target as HTMLSelectElement).value)} title="Switch project" aria-label="Project">
          {!projects.length && <option value="">(no projects)</option>}
          {groups.map(g => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map(p => <option key={p.name} value={p.name}>{projectLabel(p)}{p.via === 'admin' && p.owner ? ` — ${p.owner.username}` : p.via === 'member' || p.via === 'link' || p.via === 'public' ? ` — ${p.owner?.name ?? 'shared'}${p.role === 'view' ? ' (view)' : ''}` : ''}</option>)}
            </optgroup>
          ))}
        </select>
        {project && via !== 'owner' && <span class={'badge' + (role === 'view' ? ' view' : '')} title={role === 'view' ? 'Shared with you for viewing' : 'Shared with you for editing'}>{via === 'admin' ? 'admin' : role === 'view' ? 'view' : 'edit'}</span>}
      </div>}
      {project && <div class="project-info" title={project.name}>
        {via === 'owner' ? 'Your project' : via === 'admin' ? `Owned by ${project.owner?.name ?? '—'}` : `Shared by ${project.owner?.name ?? '—'} · ${role === 'view' ? 'view only' : 'you can edit'}`} · {project.name}
      </div>}
      <div class="actions">
        {canEdit && project && <button class="small-btn" onClick={() => void newFile()} title="New file in this project — the ending decides what it is: .tex a LaTeX document, .md a Markdown document, .html slides or a web page, .board a whiteboard, .bib, .sty … a text file">+ File</button>}
        {canEdit && project && <button class="small-btn" data-new-slides onClick={() => setNewLayoutIn('')} title="New slides, a poster, a web page or an article: a folder with an index.html, edited on a canvas">+ Slides</button>}
        {canEdit && project && <button class="small-btn" onClick={() => void newFolder()} title="New folder in this project (also in the right-click menu of any folder)">+ Folder</button>}
        {canEdit && project && <button class="small-btn" onClick={() => void upload()} title="Upload files (figures, .bib, .sty …) — or drag them from your computer onto the file list">⇧</button>}
        {canEdit && project && <button class="small-btn" data-lyx-import onClick={() => chooseLyxImport(project.name, '', r => { void load(); onOpen(r.id); })} title="Import a .lyx document or a zipped LyX project">LyX⇩</button>}
        {canEdit && project && gdocs && <button class="small-btn" data-gdocs-import onClick={() => void importGoogle()} title="Import a Google Doc (picked in Google's picker) — one with tabs becomes a document group; it stays in step with the Google Doc">G⇩</button>}
        {role === 'owner' && via !== 'admin' && project && onShare && <button class="small-btn" data-share={project.name} onClick={() => onShare(project.name)} title="Share this project…">👥</button>}
        <button class="small-btn" onClick={() => setShowAll(!showAll)} title="Show LaTeX build files (.aux, .log, .bbl …) and LyX backups (~, #, .emergency)">{showAll ? 'Fewer' : 'All files'}</button>
      </div>
      {project && renderChildren('', tree, 0)}
      {project && !tree.length && <div class="empty">No files yet — make one with + File (main.tex is a document), or upload files.</div>}
      {!projects.length && <div class="empty">No projects yet.</div>}
      {/* (on the page's body: not clipped by the sidebar, its clicks not the file tree's) */}
      {newLayoutIn !== null && project && createPortal(<NewLayoutDialog project={project.name} dir={newLayoutIn} onClose={() => setNewLayoutIn(null)}
        notify={(t, k) => { if (k === 'error') void uiAlert('Could Not Create It', t); }}
        onCreated={id => { const rel = splitDocId(id).path; if (rel.includes('/')) reveal(rel.slice(0, rel.lastIndexOf('/') + 1)); void load(); onOpen(id); }} />, document.body)}
    </div>
  );
}
