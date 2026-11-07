/**
 * Project settings in the client (Settings ▸ Project; core projectsettings.ts has the file and the
 * scopes). The shells say which project the open document belongs to (`setActiveProject`); its
 * settings are loaded, laid over this person's preferences (prefs.ts setProjectPrefs) and text styles
 * (editor/paragraphsep.ts), and loaded again when anyone changes them (the project's events, kind
 * `settings`). Settings ▸ Project changes them through `saveProjectSettings`: shown at once, written a
 * moment later; a reload while a change is on its way is ignored (the write's answer is the truth).
 */
import { useEffect, useState } from 'preact/hooks';
import type { ProjectSettings, ScreenStyles } from '@overlyx/core';
import { api } from './api';
import { subscribeProjectEvents } from './projectevents';
import { setProjectPrefs } from './prefs';

type Entry = {
  /** null: not loaded yet */
  settings: ProjectSettings | null;
  /** why they could not be loaded or saved (an end-to-end encrypted project, no connection) */
  error: string;
  listeners: Set<() => void>;
  users: number;
  unsubscribe: (() => void) | null;
  timer?: ReturnType<typeof setTimeout>;
  /** writes on their way */
  writing: number;
};
const entries = new Map<string, Entry>();
let active: string | null = null;
/** told when the settings that apply change (another project opened, the open one's changed) */
const activeListeners = new Set<() => void>();
export function subscribeActiveProject(cb: () => void): () => void { activeListeners.add(cb); return () => { activeListeners.delete(cb); }; }
const applyActive = () => {
  setProjectPrefs((active && entries.get(active)?.settings) || {});
  for (const l of [...activeListeners]) { try { l(); } catch (err) { console.error('project settings listener failed', err); } }
};

function entryOf(project: string): Entry {
  let e = entries.get(project);
  if (!e) { e = { settings: null, error: '', listeners: new Set(), users: 0, unsubscribe: null, writing: 0 }; entries.set(project, e); }
  return e;
}

function changed(project: string): void {
  const e = entries.get(project);
  for (const l of [...(e?.listeners ?? [])]) { try { l(); } catch (err) { console.error('project settings listener failed', err); } }
  if (project === active) applyActive();
}

async function load(project: string): Promise<void> {
  const e = entryOf(project);
  try {
    const r = await api.projectSettings(project);
    if (e.writing || e.timer) return;
    e.settings = r.settings; e.error = '';
  } catch (err) {
    e.settings ??= {};
    e.error = (err as Error).message || 'The project’s settings could not be loaded';
  }
  changed(project);
}

/** a user of a project's settings: loaded on the first, followed while any is there */
function use(project: string): () => void {
  const e = entryOf(project);
  if (!e.users++) {
    e.unsubscribe = subscribeProjectEvents(project, ev => { if (ev.kind === 'settings') void load(project); });
    void load(project);
  }
  return () => { if (!--e.users) { e.unsubscribe?.(); e.unsubscribe = null; } };
}

let releaseActive: (() => void) | null = null;
/** the project of the document open (null: none — a start screen, a file outside projects): its settings apply */
export function setActiveProject(project: string | null): void {
  if (project === active) return;
  releaseActive?.();
  releaseActive = null;
  active = project;
  if (project) releaseActive = use(project);
  applyActive();
}
export const activeProject = () => active;

/** the open project's text styles (the editor draws them over this person's own) */
export function activeProjectStyles(): ScreenStyles {
  return (active && entries.get(active)?.settings?.textStyles) || {};
}

/** change a project's settings: shown at once, written a moment later */
export function saveProjectSettings(project: string, next: ProjectSettings): void {
  const e = entryOf(project);
  e.settings = next;
  e.error = '';
  changed(project);
  clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    e.timer = undefined;
    e.writing++;
    const sent = e.settings ?? {};
    api.setProjectSettings(project, sent)
      .then(r => { e.writing--; if (!e.writing && !e.timer) { e.settings = r.settings; changed(project); } })
      .catch(err => { e.writing--; e.error = (err as Error).message || 'The project’s settings could not be saved'; if (!e.writing && !e.timer) void load(project); else changed(project); });
  }, 300);
}

/** a project's settings for a component: null while they load */
export function useProjectSettings(project: string | null): { settings: ProjectSettings | null; error: string } {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!project) return;
    const e = entryOf(project);
    const l = () => tick(n => n + 1);
    e.listeners.add(l);
    const release = use(project);
    return () => { e.listeners.delete(l); release(); };
  }, [project]);
  const e = project ? entries.get(project) : undefined;
  return { settings: e?.settings ?? null, error: e?.error ?? '' };
}
