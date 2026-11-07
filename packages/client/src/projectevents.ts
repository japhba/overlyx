/**
 * Server-sent events of a project (GET /api/projects/:project/events): the file list changed on
 * disk ({ kind: 'files' }) or a graphics file was written ({ kind: 'graphics', path, v } — `path`
 * relative to the project, `v` the file's mtime), or its settings changed ({ kind: 'settings' }:
 * app/projectsettings.ts). One EventSource per project, shared by the file
 * browser and every graphics inset of the open documents; it is closed a moment after the last
 * subscriber left (node views come and go while a document re-renders).
 */
import { API_BASE } from './api';

export type ProjectEvent = { kind: 'files' } | { kind: 'graphics'; path: string; v: number } | { kind: 'settings' };
type Listener = (ev: ProjectEvent) => void;

const streams = new Map<string, { es: EventSource | null; subs: Set<Listener>; closeTimer?: ReturnType<typeof setTimeout> }>();

/** projects whose events are made in this browser, not by the server (end-to-end encrypted ones: e2e/install.ts) */
let local: (project: string) => boolean = () => false;
export function setLocalProjectEvents(fn: (project: string) => boolean): void { local = fn; }

/** An event of a project whose files live in this browser (its file list changed, a figure was decrypted). */
export function emitProjectEvent(project: string, ev: ProjectEvent): void {
  for (const l of [...(streams.get(project)?.subs ?? [])]) { try { l(ev); } catch (e) { console.error('project event listener failed', e); } }
}

export function subscribeProjectEvents(project: string, cb: Listener): () => void {
  if (local(project)) {
    let s = streams.get(project);
    if (!s) streams.set(project, s = { es: null, subs: new Set() });
    s.subs.add(cb);
    const mine = s;
    return () => { mine.subs.delete(cb); };
  }
  if (typeof EventSource === 'undefined') return () => {};
  let s = streams.get(project);
  if (!s) {
    const subs = new Set<Listener>();
    const es = new EventSource(`${API_BASE}/api/projects/${encodeURIComponent(project)}/events`);
    es.onmessage = (m: MessageEvent) => {
      let ev: ProjectEvent;
      try { ev = JSON.parse(String(m.data)); } catch { return; }
      if (!ev || typeof ev !== 'object' || !('kind' in ev)) return;
      for (const l of [...subs]) { try { l(ev); } catch (e) { console.error('project event listener failed', e); } }
    };
    s = { es, subs };
    streams.set(project, s);
  }
  clearTimeout(s.closeTimer);
  s.subs.add(cb);
  const mine = s;
  return () => {
    mine.subs.delete(cb);
    if (mine.subs.size || streams.get(project) !== mine) return;
    clearTimeout(mine.closeTimer);
    mine.closeTimer = setTimeout(() => { if (!mine.subs.size && streams.get(project) === mine) { mine.es?.close(); streams.delete(project); } }, 3000);
  };
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');
const stripExt = (p: string) => p.replace(/\.[A-Za-z0-9]{1,5}$/, '');

/**
 * Does the graphics event for `changed` (project-relative, with its extension) concern the inset
 * that shows `wanted` (project-relative as written in the document — LaTeX allows the extension
 * to be left out; the callers ask for each `\graphicspath` candidate, editor/context.ts figureCandidates)?
 */
export function sameGraphicsFile(changed: string, wanted: string): boolean {
  const a = norm(changed), b = norm(wanted);
  if (!a || !b) return false;
  if (a === b) return true;
  return /\.[A-Za-z0-9]{1,5}$/.test(b) ? false : stripExt(a) === b;
}
