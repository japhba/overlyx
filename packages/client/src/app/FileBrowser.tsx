import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, fileUrl, type Project, type ProjectFile } from '../api';

interface TreeNode { name: string; path: string; children: TreeNode[]; file?: ProjectFile }

function buildTree(files: ProjectFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/');
      let next = cur.children.find(c => !c.file && c.path === dirPath);
      if (!next) { next = { name: parts[i], path: dirPath, children: [] }; cur.children.push(next); }
      cur = next;
    }
    cur.children.push({ name: parts[parts.length - 1], path: f.path, children: [], file: f });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

const ICON: Record<string, string> = { lyx: '📄', bib: '📚', image: '🖼', tex: '𝓣', pdf: '📕', other: '·' };
const isBackup = (name: string) => name.endsWith('~') || name.startsWith('#') || name.endsWith('.emergency');

export function FileBrowser({ current, onOpen, refreshKey }: { current: string | null; onOpen: (id: string) => void; refreshKey: number }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('ol.tree') || '{}'); } catch { return {}; } });
  const [showBackups, setShowBackups] = useState(false);
  const load = () => api.projects().then(r => setProjects(r.projects)).catch(() => {});
  useEffect(() => { load(); }, [refreshKey]);
  useEffect(() => { localStorage.setItem('ol.tree', JSON.stringify(collapsed)); }, [collapsed]);

  // auto-expand the folders of the current document
  useEffect(() => {
    if (!current) return;
    const parts = current.split('/');
    const open: Record<string, boolean> = {};
    for (let i = 1; i < parts.length - 1; i++) open[parts[0] + ':' + parts.slice(1, i + 1).join('/')] = false;
    setCollapsed(c => ({ ...c, ...open }));
  }, [current]);

  const toggle = (key: string) => setCollapsed(c => ({ ...c, [key]: !c[key] }));

  const newDoc = async (project: string, dir = '') => {
    const name = prompt(`New document file name (in ${project}${dir ? '/' + dir : ''}):`, 'untitled.lyx');
    if (!name) return;
    try {
      const r = await api.newDoc(project, (dir ? dir + '/' : '') + name, { title: name.replace(/\.lyx$/, '') });
      await load();
      onOpen(r.id);
    } catch (e) { alert(String((e as Error).message)); }
  };
  const newProject = async () => {
    const name = prompt('New project name:');
    if (!name) return;
    try { await api.createProject(name); await load(); } catch (e) { alert(String((e as Error).message)); }
  };
  const upload = async (project: string, dir = '') => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true;
    input.onchange = async () => {
      for (const f of Array.from(input.files ?? [])) {
        try { await api.upload(project, (dir ? dir + '/' : '') + f.name, f); } catch (e) { alert(String((e as Error).message)); }
      }
      load();
    };
    input.click();
  };

  const trees = useMemo(() => projects.map(p => ({ project: p.name, tree: buildTree(p.files.filter(f => showBackups || !isBackup(f.name))) })), [projects, showBackups]);

  const renderNode = (project: string, node: TreeNode, depth: number) => {
    const key = project + ':' + node.path;
    if (!node.file) {
      const isCollapsed = collapsed[key] ?? (depth > 0);
      return (
        <div key={key}>
          <div class="tree-row folder" style={{ paddingLeft: 6 + depth * 14 + 'px' }} onClick={() => toggle(key)}>
            <span class="twisty">{isCollapsed ? '▸' : '▾'}</span><span class="fname">{node.name}</span>
            <span class="row-actions">
              <button class="mini" title="New document here" onClick={e => { e.stopPropagation(); newDoc(project, node.path); }}>+</button>
              <button class="mini" title="Upload files here" onClick={e => { e.stopPropagation(); upload(project, node.path); }}>⇧</button>
            </span>
          </div>
          {!isCollapsed && node.children.map(c => renderNode(project, c, depth + 1))}
        </div>
      );
    }
    const f = node.file;
    const id = `${project}/${f.path}`;
    const href = f.kind === 'lyx' ? '#/' + id : fileUrl(project, f.path);
    return (
      <a key={key} class={'tree-row file' + (id === current ? ' current' : '') + (f.kind !== 'lyx' ? ' other' : '')} style={{ paddingLeft: 6 + depth * 14 + 'px' }}
        href={href} target={f.kind === 'lyx' ? undefined : '_blank'} title={`${f.path} · ${(f.size / 1024).toFixed(0)} KB`}
        onClick={e => { if (f.kind === 'lyx' && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); onOpen(id); } }}>
        <span class="ficon">{ICON[f.kind] ?? '·'}</span><span class="fname">{node.name}</span>
      </a>
    );
  };

  return (
    <div class="filetree">
      <div class="actions">
        <button class="small-btn" onClick={newProject}>+ Project</button>
        <button class="small-btn" onClick={() => setShowBackups(!showBackups)} title="Show LyX backup files (~, #, .emergency)">{showBackups ? 'Hide backups' : 'Backups'}</button>
        <button class="small-btn" onClick={load} title="Refresh">↻</button>
      </div>
      {trees.map(({ project, tree }) => {
        const key = project + ':';
        const isCollapsed = collapsed[key] ?? false;
        return (
          <div key={project}>
            <div class="tree-row project" onClick={() => toggle(key)}>
              <span class="twisty">{isCollapsed ? '▸' : '▾'}</span><span class="fname">{project}</span>
              <span class="row-actions">
                <button class="mini" title="New document" onClick={e => { e.stopPropagation(); newDoc(project); }}>+</button>
                <button class="mini" title="Upload files (figures, .bib, .sty …)" onClick={e => { e.stopPropagation(); upload(project); }}>⇧</button>
              </span>
            </div>
            {!isCollapsed && tree.map(n => renderNode(project, n, 1))}
          </div>
        );
      })}
      {!projects.length && <div style="padding:8px;color:#888">No projects yet.</div>}
    </div>
  );
}
