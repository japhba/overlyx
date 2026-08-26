import { useEffect, useState } from 'preact/hooks';
import { api, type Project } from '../api';

export function FileBrowser({ current, onOpen, refreshKey }: { current: string | null; onOpen: (id: string) => void; refreshKey: number }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const load = () => api.projects().then(r => setProjects(r.projects)).catch(() => {});
  useEffect(() => { load(); }, [refreshKey]);

  const newDoc = async (project: string) => {
    const name = prompt('New document file name (inside project "' + project + '"):', 'untitled.lyx');
    if (!name) return;
    try {
      const r = await api.newDoc(project, name, { title: name.replace(/\.lyx$/, '') });
      await load();
      onOpen(r.id);
    } catch (e) { alert(String((e as Error).message)); }
  };
  const newProject = async () => {
    const name = prompt('New project name:');
    if (!name) return;
    try { await api.createProject(name); await load(); } catch (e) { alert(String((e as Error).message)); }
  };
  const upload = async (project: string) => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true;
    input.onchange = async () => {
      for (const f of Array.from(input.files ?? [])) {
        const dir = /\.(png|jpe?g|svg|pdf|eps|gif)$/i.test(f.name) ? 'figures/' : '';
        try { await api.upload(project, dir + f.name, f); } catch (e) { alert(String((e as Error).message)); }
      }
      load();
    };
    input.click();
  };

  return (
    <div class="filetree">
      <div class="actions">
        <button class="small-btn" onClick={newProject}>+ Project</button>
        <button class="small-btn" onClick={() => setShowAll(!showAll)}>{showAll ? 'LyX only' : 'All files'}</button>
        <button class="small-btn" onClick={load} title="Refresh">↻</button>
      </div>
      {projects.map(p => {
        const isOpen = open[p.name] ?? true;
        return (
          <div key={p.name}>
            <div class="project" onClick={() => setOpen({ ...open, [p.name]: !isOpen })}>
              <span>{isOpen ? '▾' : '▸'} {p.name}</span>
              <span>
                <button class="small-btn" title="New document" onClick={(e) => { e.stopPropagation(); newDoc(p.name); }}>+</button>{' '}
                <button class="small-btn" title="Upload files (figures, .bib)" onClick={(e) => { e.stopPropagation(); upload(p.name); }}>⇧</button>
              </span>
            </div>
            {isOpen && p.files.filter(f => showAll || f.kind === 'lyx').map(f => {
              const id = `${p.name}/${f.path}`;
              return (
                <div key={f.path} class={'file' + (id === current ? ' current' : '') + (f.kind !== 'lyx' ? ' other' : '')} title={f.path}
                  onClick={() => { if (f.kind === 'lyx') onOpen(id); }}>
                  <span class="kind">{f.kind === 'lyx' ? '📄' : f.kind === 'image' ? '🖼' : f.kind === 'bib' ? '📚' : '·'}</span>
                  <span>{f.path}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {!projects.length && <div style="padding:8px;color:#888">No projects yet.</div>}
    </div>
  );
}
