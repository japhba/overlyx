/**
 * The left panel, Google-Docs style: one project at a time — a switcher at the top, then the
 * project's documents as "document tabs" (main, appendix, macros …). A tab opens its document
 * and reveals its outline: live (the editor's headings, with the section tools) for the open
 * document, from the file on disk (`GET /api/docs/<id>/outline`) for the others — a heading of
 * another document opens that document at the heading. Below the documents, the project's other
 * files (the file browser without its own project picker).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { api, type Project, type TexHeading } from '../api';
import { FileBrowser, projectLabel, useProjectEvents } from './FileBrowser';
import { projectDocs } from './Home';
import { Outline, type OutlineItem } from './Outline';
import { editorContext } from '../editor/context';

export interface DocPanelProps {
  /** the file shown (project/path, no prefix) */
  current: string | null;
  /** the document open in the editor (its outline is live) */
  currentDoc: string | null;
  refreshKey: number;
  outline: OutlineItem[];
  activePos: number;
  view: EditorView | null;
  onOpen: (id: string, opts?: { heading?: number }) => void;
  onGit?: (project: string) => void;
  onHide: () => void;
  /** the project the panel shows (for the Share button and the menus) */
  onProject?: (p: Project | null) => void;
  notify: (text: string, kind?: 'info' | 'error') => void;
}

const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

export function DocPanel({ current, currentDoc, refreshKey, outline, activePos, view, onOpen, onGit, onHide, onProject, notify }: DocPanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [picked, setPicked] = useState<string | null>(() => stored('ol.project'));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filesOpen, setFilesOpen] = useState(() => stored('ol.files.section') !== '0');
  const [statics, setStatics] = useState<Record<string, TexHeading[]>>({});
  // fsTick: the server told us the project's files changed on disk (SSE), or the window came back
  // into focus — reload the panel and the file browser without any refresh button
  const [fsTick, setFsTick] = useState(0);
  const listKey = refreshKey + fsTick;
  const load = () => api.projects().then(r => setProjects(r.projects)).catch(() => {});
  useEffect(() => { void load(); }, [listKey]);
  useEffect(() => {
    const f = () => setFsTick(t => t + 1);
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, []);
  useEffect(() => { try { localStorage.setItem('ol.files.section', filesOpen ? '1' : '0'); } catch { /* ignore */ } }, [filesOpen]);

  // the project shown: the current file's, else the last picked one, else the first
  const currentProject = current ? current.split('/')[0] : null;
  useEffect(() => { if (currentProject) setPicked(currentProject); }, [currentProject]);
  useEffect(() => { if (picked) try { localStorage.setItem('ol.project', picked); } catch { /* ignore */ } }, [picked]);
  const groups = useMemo(() => {
    const byTitle = (a: Project, b: Project) => Number((b.kind ?? '') === 'example') - Number((a.kind ?? '') === 'example') || projectLabel(a).localeCompare(projectLabel(b));
    return [
      { label: 'Your projects', items: projects.filter(p => (p.via ?? 'owner') === 'owner').sort(byTitle) },
      { label: 'Shared with you', items: projects.filter(p => p.via === 'member' || p.via === 'link').sort(byTitle) },
      { label: 'Opened as administrator', items: projects.filter(p => p.via === 'admin').sort(byTitle) },
    ].filter(g => g.items.length);
  }, [projects]);
  const selected = useMemo(() => {
    if (currentProject && projects.some(p => p.name === currentProject)) return currentProject;
    if (picked && projects.some(p => p.name === picked)) return picked;
    return groups[0]?.items[0]?.name ?? null;
  }, [currentProject, picked, projects, groups]);
  const project = projects.find(p => p.name === selected) ?? null;
  useProjectEvents(selected, () => setFsTick(t => t + 1));
  const reported = useRef<string | null>(null);
  useEffect(() => { const key = project ? `${project.name}:${project.role}:${project.via}` : ''; if (reported.current !== key) { reported.current = key; onProject?.(project); } }, [project]);
  const docs = useMemo(() => (project ? projectDocs(project) : []), [project]);

  // the open document's tab is expanded (its outline is the live one)
  useEffect(() => { if (currentDoc) setExpanded(e => (e[currentDoc] ? e : { ...e, [currentDoc]: true })); }, [currentDoc]);

  // the agent's context: which documents are open here (the active one first)
  useEffect(() => {
    const fn = () => {
      const open = project ? docs.map(d => `${project.name}/${d}`).filter(id => expanded[id]) : [];
      const active = currentDoc ?? current;
      return active ? [active, ...open.filter(id => id !== active)] : open;
    };
    editorContext.openDocs = fn;
    return () => { if (editorContext.openDocs === fn) editorContext.openDocs = undefined; };
  });

  /** switching projects opens the other project's main document (one project at a time) */
  const switchProject = (name: string) => {
    const p = projects.find(x => x.name === name);
    if (!p) return;
    setPicked(name);
    const d = projectDocs(p)[0];
    if (d) onOpen(`${name}/${d}`);
    else { notify(`“${projectLabel(p)}” has no documents yet — create one with + Doc`); location.hash = '#/'; }
  };

  const fetchStatic = (id: string) => {
    api.docOutline(id).then(r => setStatics(s => ({ ...s, [id]: r.headings }))).catch(e => { setStatics(s => ({ ...s, [id]: s[id] ?? [] })); notify('Outline: ' + (e as Error).message, 'error'); });
  };
  const toggle = (id: string) => {
    const open = !expanded[id];
    setExpanded(e => ({ ...e, [id]: open }));
    if (open && id !== currentDoc) fetchStatic(id);
  };
  // expanded tabs of documents that are not open show the file's headings; refreshed when the panel reloads
  useEffect(() => { for (const d of docs) { const id = `${project!.name}/${d}`; if (expanded[id] && id !== currentDoc) fetchStatic(id); } }, [listKey, currentDoc, project?.name]);

  const staticOutline = (id: string) => {
    const hs = statics[id];
    if (!hs) return <div class="outline-loading">Loading…</div>;
    if (!hs.length) return <div class="outline-empty">No sections.</div>;
    return hs.map(h => (
      <div key={h.n} class={'outline-item static l' + Math.min(5, h.level)} title={h.text} data-heading={h.n} onMouseDown={e => e.preventDefault()} onClick={() => onOpen(id, { heading: h.n })}>
        <span class="outline-text">{h.num && <span class="num">{h.num}</span>}{h.text}</span>
      </div>
    ));
  };

  return (
    <div class="docpanel" data-project={project?.name ?? ''}>
      <div class="panel-tabs project-bar">
        <select class="project-switch" value={selected ?? ''} onChange={e => switchProject((e.target as HTMLSelectElement).value)} title="Switch to another project (one project is open at a time)" aria-label="Project">
          {!projects.length && <option value="">(no projects)</option>}
          {groups.map(g => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map(p => <option key={p.name} value={p.name}>{projectLabel(p)}{p.via === 'admin' && p.owner ? ` — ${p.owner.username}` : p.via === 'member' || p.via === 'link' ? ` — ${p.owner?.name ?? 'shared'}${p.role === 'view' ? ' (view)' : ''}` : ''}</option>)}
            </optgroup>
          ))}
        </select>
        {project && (project.via ?? 'owner') !== 'owner' && <span class={'badge' + (project.role === 'view' ? ' view' : '')} title={project.role === 'view' ? 'Shared with you for viewing' : 'Shared with you for editing'}>{project.via === 'admin' ? 'admin' : project.role === 'view' ? 'view' : 'edit'}</span>}
        <button class="hide" title="Hide the documents panel (Ctrl+Alt+O)" onClick={onHide}>«</button>
      </div>
      <div class="panel-body">
        {project && (
          <div class="doc-tabs" data-doc-tabs>
            {docs.map(d => {
              const id = `${project.name}/${d}`;
              const active = id === current || id === currentDoc;
              const open = !!expanded[id];
              return (
                <div key={id} class={'doc-tab' + (active ? ' active' : '') + (open ? ' open' : '')} data-doc={d}>
                  <div class="doc-tab-row">
                    <button class="twisty" title={open ? 'Hide the outline' : 'Show the outline'} onClick={() => toggle(id)}>{open ? '▾' : '▸'}</button>
                    <a class="doc-name" href={'#/' + id} title={id} onClick={e => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); onOpen(id); setExpanded(x => ({ ...x, [id]: true })); } }}>
                      <span class="ficon">📄</span><span class="fname">{d}</span>
                    </a>
                  </div>
                  {open && <div class="doc-outline">{id === currentDoc ? <Outline view={view} items={outline} activePos={activePos} /> : staticOutline(id)}</div>}
                </div>
              );
            })}
            {!docs.length && <div class="empty">No documents yet — add one with + Doc below.</div>}
          </div>
        )}
        <div class={'section-head' + (filesOpen ? ' open' : '')} onClick={() => setFilesOpen(o => !o)} data-files-section>
          <span class="twisty">{filesOpen ? '▾' : '▸'}</span> Files
        </div>
        {filesOpen && <FileBrowser current={current} project={selected} refreshKey={listKey} onOpen={id => onOpen(id)} onGit={onGit} />}
      </div>
    </div>
  );
}
