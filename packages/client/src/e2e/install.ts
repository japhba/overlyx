/**
 * End-to-end encrypted projects in the web app: the hooks that route their requests, file URLs and
 * project events to this browser (api.ts, projectevents.ts), installed once the user is known.
 * The VS Code extension does not install them (it has no encrypted projects).
 */
import { setLocalApi } from '../api';
import { setLocalProjectEvents, emitProjectEvent } from '../projectevents';
import { routeLocal, patchProjects, setCurrentDoc } from './localapi';
import { setE2eUser, isE2eProject, openedE2eProject, openE2eProject, knownE2eProjects, closeE2eProjects, keyNotices, type E2eProject } from './project';
import { uiAlert } from '../app/Dialogs';
import { projectShortName } from '@overlyx/core';
import { forgetKeys } from './keys';

/** 1×1 transparent GIF: a figure while it is being decrypted (a "graphics" event redraws it) */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const EXTS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.eps'];

/** The file a figure names: the first candidate (with graphicx's extensions) that the project has. */
function findFile(p: E2eProject, candidates: string[]): string | null {
  for (const c of candidates) for (const ext of EXTS) { const e = p.entry(c + ext); if (e && e.kind === 'blob') return c + ext; }
  return null;
}

const watched = new Set<string>();
/** the file list's changes reach the file browser as the server's would */
function watch(p: E2eProject): void {
  if (watched.has(p.name)) return;
  watched.add(p.name);
  let t: ReturnType<typeof setTimeout> | null = null;
  p.onChange(() => { if (!t) t = setTimeout(() => { t = null; emitProjectEvent(p.name, { kind: 'files' }); }, 150); });
}

export function installE2e(user: { id: number; name: string }, currentDoc: () => string | null, notify: (text: string, kind?: 'info' | 'error') => void): void {
  setE2eUser(user);
  keyNotices.waiting = (project) => void uiAlert('Waiting for the key', `“${projectShortName(project)}” is end-to-end encrypted: you can open it once a member who holds its key gives it to you. They see your request in the project’s Share dialog (and a note when they open it). Reload this page after they did.`);
  keyNotices.othersWaiting = (project, names) => notify(`${names.join(', ')} ${names.length === 1 ? 'waits' : 'wait'} for the key of “${projectShortName(project)}” — Share ▸ Give key`);
  setCurrentDoc(currentDoc);
  setLocalProjectEvents(isE2eProject);
  setLocalApi({
    router: (method, url, body, raw) => {
      const r = routeLocal(method, url, body, raw);
      // a project this browser opened: its file list changes reach the file browser
      if (r) for (const n of knownE2eProjects()) { const p = openedE2eProject(n); if (p) watch(p); }
      return r;
    },
    projects: async (list) => {
      const out = await patchProjects(list);
      for (const p of out) if (p.e2e) { const o = openedE2eProject(p.name); if (o) watch(o); }
      return out;
    },
    url: (kind, project, path, alt) => {
      if (!isE2eProject(project)) return undefined;
      const p = openedE2eProject(project);
      if (!p) { void openE2eProject(project, { prompt: false }).then(o => { watch(o); emitProjectEvent(project, { kind: 'graphics', path, v: Date.now() }); }).catch(() => {}); return PIXEL + '#e2e'; }
      const file = findFile(p, [path, ...alt]);
      if (!file) return PIXEL + '#e2e';
      const image = kind === 'graphics';
      const now = p.urlNow(file, image);
      // (the editor appends `&v=…` / `&download=1` to these URLs: after the fragment, they change nothing)
      if (now) return now + '#e2e';
      void p.loadUrl(file, image).then(u => { if (u) emitProjectEvent(project, { kind: 'graphics', path: file, v: Date.now() }); }).catch(e => console.warn('[e2e] figure', file, e));
      return PIXEL + '#e2e';
    },
  });
}

/** Sign-out: the keys, the decrypted copies and the open projects of this browser go. */
export async function forgetE2e(): Promise<void> {
  const projects = knownE2eProjects();
  closeE2eProjects();
  void import('./compile').then(m => m.stopEngine()).catch(() => {});
  await forgetKeys().catch(() => {});
  try {
    const dbs = await (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> }).databases?.() ?? [];
    for (const d of dbs) {
      const n = d.name ?? '';
      if ((n.startsWith('overlyx-e2e') && n !== 'overlyx-e2e-tex') || projects.some(p => n.startsWith(`overlyx2:${p}/`))) indexedDB.deleteDatabase(n);
    }
  } catch { /* ignore */ }
  try { localStorage.removeItem('ol.e2eProjects'); } catch { /* ignore */ }
}
