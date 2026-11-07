/**
 * Go to File (Ctrl/⌘+P; File ▸ Go to file…), VS Code's Quick Open: a box over the window that finds a
 * file of the project by a few of its letters (app/quickopen.ts) — the files shown lately first —
 * and opens it with Enter or a click. With no project open it looks through all of them.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, fileUrl, type Project } from '../api';
import { projectShortName } from '@overlyx/core';
import { quickFiles, rankFiles, type QuickHit } from './quickopen';
import { recentFiles } from './lastfile';
import { KIND_ICONS, iconSvg } from './modernicons';

/** the name with the matched letters in bold (`positions` count in the whole path) */
function marked(h: QuickHit, text: string, offset: number) {
  const at = new Set(h.positions.map(p => p - offset));
  const out: ComponentChildren[] = [];
  let run = '';
  for (let i = 0; i < text.length; i++) {
    if (at.has(i)) { if (run) out.push(run); run = ''; out.push(<b key={i}>{text[i]}</b>); }
    else run += text[i];
  }
  if (run) out.push(run);
  return out;
}

export function QuickOpen({ project, onOpen, onClose }: { project: string | null; onOpen: (id: string) => void; onClose: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { api.projects().then(r => setProjects(r.projects)).catch(() => setProjects([])); }, []);
  useEffect(() => { input.current?.focus(); }, []);
  const scope = useMemo(() => (projects ?? []).filter(p => !project || p.name === project), [projects, project]);
  const files = useMemo(() => quickFiles(scope), [scope]);
  const recent = useMemo(() => scope.flatMap(p => recentFiles(p.name)), [scope]);
  const hits = useMemo(() => rankFiles(files, q, recent), [files, q, recent]);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { list.current?.querySelector('.qo-row.sel')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const many = scope.length > 1;

  const open = (h: QuickHit | undefined) => {
    if (!h) return;
    onClose();
    if (h.id) onOpen(h.id);
    else window.open(fileUrl(h.project, h.path), '_blank', 'noopener');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(hits.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === 'PageDown') { e.preventDefault(); setSel(s => Math.min(hits.length - 1, s + 10)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setSel(s => Math.max(0, s - 10)); }
    else if (e.key === 'Enter') { e.preventDefault(); open(hits[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    e.stopPropagation();
  };

  return (
    <div class="qo-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="qo-box" role="dialog" aria-label="Go to file">
        <input ref={input} class="qo-input" value={q} placeholder={project ? `Go to a file of ${projectShortName(project)} — type a few letters of its name` : 'Go to a file — type a few letters of its name'}
          onInput={e => setQ((e.target as HTMLInputElement).value)} onKeyDown={onKey} autocomplete="off" spellcheck={false} data-quick-open />
        <div class="qo-list" ref={list} role="listbox">
          {projects === null ? <div class="qo-empty">Loading the files…</div>
            : !hits.length ? <div class="qo-empty">{q.trim() ? `No file matches “${q.trim()}”.` : 'No files yet.'}</div>
            : hits.map((h, i) => {
              const kind = h.file.kind === 'html' && h.file.deliverable ? h.file.deliverable : /\.md$/i.test(h.name) ? 'md' : h.file.kind;
              const nameAt = h.path.length - h.name.length;
              const isRecent = !q.trim() && !!h.id && recent.includes(h.id);
              return (
                <div key={h.project + '/' + h.path} role="option" aria-selected={i === sel} class={'qo-row' + (i === sel ? ' sel' : '')} data-quick-file={h.path}
                  onMouseMove={() => setSel(i)} onClick={() => open(h)} title={`${many ? projectShortName(h.project) + ': ' : ''}${h.path}`}>
                  <span class="qo-icon" dangerouslySetInnerHTML={{ __html: iconSvg(KIND_ICONS[kind] ?? KIND_ICONS.other, 15) }} />
                  <span class="qo-name">{marked(h, h.name, nameAt)}</span>
                  <span class="qo-dir">{many ? projectShortName(h.project) + (h.dir ? '/' : '') : ''}{marked(h, h.dir, 0)}</span>
                  {isRecent && <span class="qo-tag">recently opened</span>}
                </div>
              );
            })}
        </div>
        <div class="qo-hint">↑↓ Enter opens · Esc closes · Ctrl+Shift+F searches inside the files</div>
      </div>
    </div>
  );
}
